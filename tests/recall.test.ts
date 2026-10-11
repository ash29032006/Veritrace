/*
 * The recall cascade: sp_initiate_recall, sp_close_recall, the lineage
 * functions, and the v_outlet_exposure view.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { closeTestPool, type Fixture, inRollback, rejects } from "./helpers";

after(closeTestPool);

/** A diamond four levels deep, with the raw lot ALSO shipped directly. */
async function network(f: Fixture) {
  const raw = await f.batch("R", { date: "2026-01-01", qty: 1000 });
  const a = await f.batch("A", { date: "2026-02-01" });
  const b = await f.batch("B", { date: "2026-02-02" });
  const c = await f.batch("C", { date: "2026-03-01" });
  const fin = await f.batch("F", { date: "2026-04-01" });
  const other = await f.batch("O", { date: "2026-04-01" });
  await f.compose(raw, a, 10);
  await f.compose(raw, b, 10);
  await f.compose(a, c, 10);
  await f.compose(b, c, 10);
  await f.compose(c, fin, 10);
  const o1 = await f.outlet("Direct");
  const o2 = await f.outlet("Deep");
  const o3 = await f.outlet("Clean");
  await f.ship(o1, [[raw, 5]]);
  await f.ship(o2, [[fin, 7]]);
  await f.ship(o3, [[other, 9]]);
  return { raw, a, b, c, fin, other, o1, o2, o3 };
}

const call = (f: Fixture, src: number, ids: number[], depths: number[], user: number) =>
  f.one<{ p_recall_id: number }>(
    `CALL sp_initiate_recall($1, 'Salmonella confirmed by lab', $2, $3::bigint[], $4::int[], NULL)`,
    [src, user, ids, depths],
  );

describe("lineage functions", () => {
  test("TC-28 fn_downstream_batches finds every descendant with its shortest hop count", () =>
    inRollback(async (f) => {
      const n = await network(f);
      const rows = await f.q<{ batch_id: number; hop_depth: number }>(`SELECT * FROM fn_downstream_batches($1)`, [n.raw]);
      const depth = Object.fromEntries(rows.map((r) => [r.batch_id, r.hop_depth]));
      assert.deepEqual(depth, { [n.raw]: 0, [n.a]: 1, [n.b]: 1, [n.c]: 2, [n.fin]: 3 });
    }));

  test("TC-29 fn_upstream_batches is the exact inverse", () =>
    inRollback(async (f) => {
      const n = await network(f);
      const up = await f.q<{ batch_id: number }>(`SELECT batch_id FROM fn_upstream_batches($1) ORDER BY 1`, [n.fin]);
      assert.deepEqual(
        up.map((r) => r.batch_id),
        [n.raw, n.a, n.b, n.c].sort((x, y) => x - y),
      );
    }));
});

describe("sp_initiate_recall", () => {
  test("TC-30 the cascade recalls the whole scope and quarantines stock at depth 0 AND depth 3", () =>
    inRollback(async (f) => {
      const n = await network(f);
      const { p_recall_id } = await call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.maker);

      const statuses = await f.q<{ batch_id: number; status: string }>(
        `SELECT batch_id, status FROM batch WHERE batch_id = ANY($1)`,
        [[n.raw, n.a, n.b, n.c, n.fin, n.other]],
      );
      for (const s of statuses) assert.equal(s.status, s.batch_id === n.other ? "ACTIVE" : "RECALLED");

      const inv = await f.q<{ outlet_id: number; stock_status: string }>(
        `SELECT outlet_id, stock_status FROM inventory WHERE outlet_id = ANY($1)`,
        [[n.o1, n.o2, n.o3]],
      );
      const byOutlet = Object.fromEntries(inv.map((i) => [i.outlet_id, i.stock_status]));
      assert.equal(byOutlet[n.o1], "QUARANTINED", "directly shipped raw lot (the *0.. case)");
      assert.equal(byOutlet[n.o2], "QUARANTINED", "three hops down");
      assert.equal(byOutlet[n.o3], "AVAILABLE", "unrelated outlet untouched");

      const scope = await f.q(`SELECT * FROM recall_batch WHERE recall_id = $1`, [p_recall_id]);
      assert.equal(scope.length, 5);

      const audit = await f.q<{ action: string }>(
        `SELECT action FROM audit_log WHERE (entity_name = 'recall' AND entity_id = $1) OR action = 'BATCH_RECALLED' AND details LIKE $2`,
        [p_recall_id, `%recall #${p_recall_id},%`],
      );
      const actions = audit.map((a) => a.action);
      assert.ok(actions.includes("RECALL_INITIATED"));
      assert.ok(actions.includes("INVENTORY_QUARANTINED"));
      assert.equal(actions.filter((a) => a === "BATCH_RECALLED").length, 5, "one audit row per recalled batch");
    }));

  test("TC-31 a stale graph (missing a downstream batch) is refused and NOTHING changes", () =>
    inRollback(async (f) => {
      const n = await network(f);
      await rejects(f, () => call(f, n.raw, [n.a, n.b, n.c], [1, 1, 2], f.maker), {
        code: "P0001",
        message: /Graph projection is stale/,
      });
      const recalled = await f.q(`SELECT 1 FROM batch WHERE batch_id = ANY($1) AND status = 'RECALLED'`, [
        [n.raw, n.a, n.b, n.c, n.fin],
      ]);
      assert.equal(recalled.length, 0, "atomic: the failed procedure left no partial recall");
      const quarantined = await f.q(`SELECT 1 FROM inventory WHERE outlet_id = ANY($1) AND stock_status = 'QUARANTINED'`, [
        [n.o1, n.o2],
      ]);
      assert.equal(quarantined.length, 0);
    }));

  test("TC-32 only a MANUFACTURER can initiate; recalling twice is refused", () =>
    inRollback(async (f) => {
      const n = await network(f);
      await rejects(f, () => call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.regulator), {
        code: "42501",
      });
      await call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.maker);
      await rejects(f, () => call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.maker), {
        code: "P0001",
        message: /already recalled/,
      });
    }));
});

describe("sp_close_recall and v_outlet_exposure", () => {
  test("TC-33 the view reports units per outlet per open recall, without double counting", () =>
    inRollback(async (f) => {
      const n = await network(f);
      const { p_recall_id } = await call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.maker);
      const rows = await f.q<{ outlet_id: number; units_shipped: number; units_quarantined: number; max_hop_depth: number }>(
        `SELECT outlet_id, units_shipped, units_quarantined, max_hop_depth FROM v_outlet_exposure WHERE recall_id = $1`,
        [p_recall_id],
      );
      const by = Object.fromEntries(rows.map((r) => [r.outlet_id, r]));
      assert.equal(rows.length, 2);
      assert.equal(by[n.o1]!.units_shipped, 5);
      assert.equal(by[n.o2]!.units_quarantined, 7);
      assert.equal(by[n.o2]!.max_hop_depth, 3);
    }));

  test("TC-34 only a REGULATOR can close; a closed recall leaves the view and cannot close twice", () =>
    inRollback(async (f) => {
      const n = await network(f);
      const { p_recall_id } = await call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.maker);
      await rejects(f, () => f.q(`CALL sp_close_recall($1, $2)`, [p_recall_id, f.maker]), { code: "42501" });
      await f.q(`CALL sp_close_recall($1, $2)`, [p_recall_id, f.regulator]);
      const { recall_status } = await f.one<{ recall_status: string }>(`SELECT recall_status FROM recall WHERE recall_id = $1`, [
        p_recall_id,
      ]);
      assert.equal(recall_status, "CLOSED");
      const open = await f.q(`SELECT 1 FROM v_outlet_exposure WHERE recall_id = $1`, [p_recall_id]);
      assert.equal(open.length, 0);
      await rejects(f, () => f.q(`CALL sp_close_recall($1, $2)`, [p_recall_id, f.regulator]), {
        code: "P0001",
        message: /already closed/,
      });
    }));

  test("TC-35 recall scope rows cannot be edited afterwards", () =>
    inRollback(async (f) => {
      const n = await network(f);
      const { p_recall_id } = await call(f, n.raw, [n.a, n.b, n.c, n.fin], [1, 1, 2, 3], f.maker);
      await rejects(f, () => f.q(`DELETE FROM recall_batch WHERE recall_id = $1`, [p_recall_id]), {
        code: "P0001",
        message: /scope of a recall is permanent/,
      });
    }));
});
