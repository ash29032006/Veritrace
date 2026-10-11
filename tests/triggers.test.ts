/*
 * The triggers: rules the database enforces no matter which program writes.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { closeTestPool, type Fixture, inRollback, rejects } from "./helpers";

after(closeTestPool);

/** raw -> mid -> fin, with fin shipped to an outlet. */
async function chain(f: Fixture) {
  const raw = await f.batch("RAW", { date: "2026-01-01" });
  const mid = await f.batch("MID", { date: "2026-02-01" });
  const fin = await f.batch("FIN", { date: "2026-03-01" });
  await f.compose(raw, mid, 40);
  await f.compose(mid, fin, 30);
  const outlet = await f.outlet("Chain");
  const shipment = await f.ship(outlet, [[fin, 10]]);
  return { raw, mid, fin, outlet, shipment };
}

async function recall(f: Fixture, source: number, affected: number[], depths: number[], user = f.maker) {
  const row = await f.one<{ p_recall_id: number }>(
    `CALL sp_initiate_recall($1, 'Contamination found in test', $2, $3::bigint[], $4::int[], NULL)`,
    [source, user, affected, depths],
  );
  return row.p_recall_id;
}

describe("trg_block_unsafe_shipment", () => {
  test("TC-14 shipping a RECALLED batch is refused", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      await recall(f, c.raw, [c.mid, c.fin], [1, 2]);
      await rejects(f, () => f.ship(c.outlet, [[c.fin, 1]]), { code: "P0001", message: /is RECALLED and cannot be shipped/ });
    }));

  test("TC-15 shipping a batch on hold (QUARANTINED) is refused", () =>
    inRollback(async (f) => {
      const b = await f.batch("HOLD");
      await f.q(`UPDATE batch SET status = 'QUARANTINED' WHERE batch_id = $1`, [b]);
      const o = await f.outlet("Hold");
      await rejects(f, () => f.ship(o, [[b, 1]]), { code: "P0001", message: /QUARANTINED/ });
    }));

  test("TC-16 shipping more than is left is refused", () =>
    inRollback(async (f) => {
      const b = await f.batch("OVR", { qty: 10 });
      const o = await f.outlet("Over");
      await rejects(f, () => f.ship(o, [[b, 11]]), { code: "P0001", message: /only 10\.00 units left/ });
    }));
});

describe("trg_guard_composition", () => {
  test("TC-17 a lineage cycle (A -> B -> A) is refused", () =>
    inRollback(async (f) => {
      const a = await f.batch("CYA", { date: "2026-01-01" });
      const b = await f.batch("CYB", { date: "2026-01-01" });
      await f.compose(a, b, 1);
      await rejects(f, () => f.compose(b, a, 1), { code: "P0001", message: /would create a lineage cycle/ });
    }));

  test("TC-18 an input made after the batch it went into is refused", () =>
    inRollback(async (f) => {
      const late = await f.batch("LATE", { date: "2026-05-01" });
      const early = await f.batch("EARLY", { date: "2026-01-01" });
      await rejects(f, () => f.compose(late, early, 1), { code: "P0001", message: /is newer than/ });
    }));

  test("TC-19 a recalled batch cannot be used as an input", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      await recall(f, c.raw, [c.mid, c.fin], [1, 2]);
      const fresh = await f.batch("NEW", { date: "2026-04-01" });
      await rejects(f, () => f.compose(c.mid, fresh, 1), { code: "P0001", message: /cannot be used as an input/ });
    }));

  test("TC-20 lineage rows cannot be deleted or edited", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      await rejects(f, () => f.q(`DELETE FROM batch_composition WHERE child_batch_id = $1`, [c.mid]), {
        code: "P0001",
        message: /lineage records are permanent/,
      });
      await rejects(f, () => f.q(`UPDATE batch_composition SET quantity_used = 1 WHERE child_batch_id = $1`, [c.mid]), {
        code: "P0001",
      });
    }));
});

describe("inventory follows shipments", () => {
  test("TC-21 a shipment books stock at the outlet; cancelling it returns the stock", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      const inv = () =>
        f.one<{ quantity_on_hand: number }>(`SELECT quantity_on_hand FROM inventory WHERE outlet_id = $1 AND batch_id = $2`, [
          c.outlet,
          c.fin,
        ]);
      assert.equal((await inv()).quantity_on_hand, 10);
      await f.q(`DELETE FROM shipment WHERE shipment_id = $1`, [c.shipment]);
      assert.equal((await inv()).quantity_on_hand, 0);
      const lines = await f.q(`SELECT 1 FROM shipment_line WHERE shipment_id = $1`, [c.shipment]);
      assert.equal(lines.length, 0, "lines cascade away with their header");
    }));

  test("TC-22 a shipment of a recalled batch cannot be cancelled (it is evidence)", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      await recall(f, c.raw, [c.mid, c.fin], [1, 2]);
      await rejects(f, () => f.q(`DELETE FROM shipment WHERE shipment_id = $1`, [c.shipment]), {
        code: "P0001",
        message: /evidence of exposure/,
      });
    }));

  test("TC-23 a shipment the outlet has partly sold cannot be cancelled", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      await f.q(`UPDATE inventory SET quantity_on_hand = 4 WHERE batch_id = $1`, [c.fin]);
      await rejects(f, () => f.q(`DELETE FROM shipment WHERE shipment_id = $1`, [c.shipment]), {
        code: "P0001",
        message: /already sold/,
      });
    }));
});

describe("status rules and the audit trail", () => {
  test("TC-24 RECALLED cannot be set by a plain UPDATE", () =>
    inRollback(async (f) => {
      const b = await f.batch("DIR");
      await rejects(f, () => f.q(`UPDATE batch SET status = 'RECALLED' WHERE batch_id = $1`, [b]), {
        code: "P0001",
        message: /only be recalled through sp_initiate_recall/,
      });
    }));

  test("TC-25 every write is audited by trigger, attributed to the acting user", () =>
    inRollback(async (f) => {
      const c = await chain(f);
      const rows = await f.q<{ action: string; performed_by: number }>(
        `SELECT action, performed_by FROM audit_log
          WHERE (entity_name = 'batch' AND entity_id = ANY($1)) OR (entity_name = 'shipment' AND entity_id = $2)`,
        [[c.raw, c.mid, c.fin], c.shipment],
      );
      const actions = rows.map((r) => r.action).sort();
      assert.deepEqual(actions, [
        "BATCH_CREATED",
        "BATCH_CREATED",
        "BATCH_CREATED",
        "COMPOSITION_RECORDED",
        "COMPOSITION_RECORDED",
        "SHIPMENT_CREATED",
      ]);
      assert.ok(rows.every((r) => r.performed_by === f.maker));
    }));

  test("TC-26 the audit log refuses UPDATE and DELETE", () =>
    inRollback(async (f) => {
      await f.batch("AUD");
      await rejects(f, () => f.q(`UPDATE audit_log SET details = 'tampered'`), { code: "P0001", message: /append only/ });
      await rejects(f, () => f.q(`DELETE FROM audit_log`), { code: "P0001", message: /append only/ });
    }));

  test("TC-27 deleting a user keeps their audit rows (performed_by becomes NULL)", () =>
    inRollback(async (f) => {
      const { user_id } = await f.one<{ user_id: number }>(
        `INSERT INTO app_user (username, password_hash, role) VALUES ('t_leaver', '$2b$10$' || repeat('b', 53), 'REGULATOR') RETURNING user_id`,
      );
      const { log_id } = await f.one<{ log_id: number }>(
        `INSERT INTO audit_log (action, entity_name, performed_by) VALUES ('USER_LOGIN', 'app_user', $1) RETURNING log_id`,
        [user_id],
      );
      await f.q(`DELETE FROM app_user WHERE user_id = $1`, [user_id]);
      const row = await f.one<{ performed_by: number | null }>(`SELECT performed_by FROM audit_log WHERE log_id = $1`, [log_id]);
      assert.equal(row.performed_by, null);
    }));
});
