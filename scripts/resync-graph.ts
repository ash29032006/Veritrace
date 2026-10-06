/*
 * npm run graph:resync
 *
 * Rebuilds the entire Neo4j projection from PostgreSQL, the source of truth.
 * Use it to populate the graph after seeding, to recover after a failed
 * sync, and at the demo to show that the graph is derived data.
 *
 * Everything is MERGE-based and batched with UNWIND, so it is safe to run
 * repeatedly; anything in the graph that Postgres no longer has is removed.
 */
import "./_env";
import { closeDriver, cypherRead, cypherWrite, int } from "@/lib/db/neo4j";
import { closePool, query } from "@/lib/db/postgres";

const CHUNK = 500;

async function inChunks<T>(rows: T[], run: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await run(rows.slice(i, i + CHUNK));
}

async function main() {
  const started = performance.now();

  const batches = await query<{ batch_id: number; batch_code: string; product_name: string; status: string }>(
    `SELECT batch_id, batch_code, product_name, status FROM batch`,
  );
  const outlets = await query<{ outlet_id: number; outlet_name: string; city: string }>(
    `SELECT outlet_id, outlet_name, city FROM outlet`,
  );
  const compositions = await query<{ parent_batch_id: number; child_batch_id: number; quantity_used: number }>(
    `SELECT parent_batch_id, child_batch_id, quantity_used FROM batch_composition`,
  );
  const lines = await query<{
    shipment_id: number;
    outlet_id: number;
    batch_id: number;
    quantity: number;
    shipment_date: string;
  }>(
    `SELECT s.shipment_id, s.outlet_id, sl.batch_id, sl.quantity, s.shipment_date
       FROM shipment_line sl JOIN shipment s ON s.shipment_id = sl.shipment_id`,
  );

  // 1. start clean: a resync is a rebuild, not a patch
  await cypherWrite(`MATCH (n) WHERE n:Batch OR n:Outlet DETACH DELETE n`);

  // 2. nodes
  await inChunks(batches, (rows) =>
    cypherWrite(
      `UNWIND $rows AS r
       MERGE (b:Batch {batch_id: r.id})
       SET b.batch_code = r.code, b.product_name = r.product, b.status = r.status`,
      { rows: rows.map((b) => ({ id: int(b.batch_id), code: b.batch_code, product: b.product_name, status: b.status })) },
    ),
  );
  await inChunks(outlets, (rows) =>
    cypherWrite(
      `UNWIND $rows AS r
       MERGE (o:Outlet {outlet_id: r.id})
       SET o.outlet_name = r.name, o.city = r.city`,
      { rows: rows.map((o) => ({ id: int(o.outlet_id), name: o.outlet_name, city: o.city })) },
    ),
  );

  // 3. lineage: parent WENT_INTO child, same direction as batch_composition
  await inChunks(compositions, (rows) =>
    cypherWrite(
      `UNWIND $rows AS r
       MATCH (p:Batch {batch_id: r.parent}), (c:Batch {batch_id: r.child})
       MERGE (p)-[w:WENT_INTO]->(c)
       SET w.quantity_used = r.qty`,
      { rows: rows.map((c) => ({ parent: int(c.parent_batch_id), child: int(c.child_batch_id), qty: c.quantity_used })) },
    ),
  );

  // 4. distribution: one SHIPPED_TO per shipment line
  await inChunks(lines, (rows) =>
    cypherWrite(
      `UNWIND $rows AS r
       MATCH (b:Batch {batch_id: r.batch}), (o:Outlet {outlet_id: r.outlet})
       MERGE (b)-[s:SHIPPED_TO {shipment_id: r.shipment}]->(o)
       SET s.quantity = r.qty, s.shipment_date = date(r.date)`,
      {
        rows: rows.map((l) => ({
          batch: int(l.batch_id),
          outlet: int(l.outlet_id),
          shipment: int(l.shipment_id),
          qty: l.quantity,
          date: l.shipment_date,
        })),
      },
    ),
  );

  // 5. prove it: counts on both sides must match
  const [g] = await cypherRead<{ batches: number; outlets: number; wentInto: number; shippedTo: number }>(`
    OPTIONAL MATCH (b:Batch)                WITH count(b) AS batches
    OPTIONAL MATCH (o:Outlet)               WITH batches, count(o) AS outlets
    OPTIONAL MATCH ()-[w:WENT_INTO]->()     WITH batches, outlets, count(w) AS wentInto
    OPTIONAL MATCH ()-[s:SHIPPED_TO]->()
    RETURN batches, outlets, wentInto, count(s) AS shippedTo`);
  const expected = {
    batches: batches.length,
    outlets: outlets.length,
    wentInto: compositions.length,
    shippedTo: lines.length,
  };
  console.table({ postgres: expected, neo4j: g });
  const ok = g && Object.entries(expected).every(([k, v]) => g[k as keyof typeof g] === v);
  console.log(ok ? `graph rebuilt in ${Math.round(performance.now() - started)} ms` : "MISMATCH between PostgreSQL and Neo4j");
  if (!ok) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDriver();
    await closePool();
  });
