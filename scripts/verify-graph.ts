/*
 * npm run graph:verify
 *
 * Build-order step 11: forward exposure, recall scope and provenance must
 * agree EXACTLY between the recursive CTEs in PostgreSQL and the Cypher
 * traversals in Neo4j, for every batch. Prints a per-batch table and exits
 * non-zero on any disagreement.
 */
import "./_env";
import { exposureViaCte } from "@/lib/data/exposure";
import { closeDriver } from "@/lib/db/neo4j";
import { closePool, query } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";

const setOf = (xs: string[]) => new Set(xs);
const same = (a: Set<string>, b: Set<string>) => a.size === b.size && [...a].every((x) => b.has(x));

async function main() {
  const batches = await query<{ batch_id: number; batch_code: string }>(
    `SELECT batch_id, batch_code FROM batch ORDER BY batch_id`,
  );
  let failures = 0;
  const rows: Record<string, string | number>[] = [];

  for (const b of batches) {
    // forward exposure: (outlet, batch, shipment)
    const sqlExp = setOf((await exposureViaCte(b.batch_id)).map((r) => `${r.outletId}:${r.batchId}:${r.shipmentId}`));
    const cyExp = setOf(
      (await graph.exposureForComparison(b.batch_id)).map((r) => `${r.outletId}:${r.batchId}:${r.shipmentId}`),
    );

    // recall scope with depth
    const sqlDown = setOf(
      (await query<{ batch_id: number; hop_depth: number }>(`SELECT * FROM fn_downstream_batches($1)`, [b.batch_id])).map(
        (r) => `${r.batch_id}@${r.hop_depth}`,
      ),
    );
    const cyDown = setOf((await graph.downstreamBatches(b.batch_id)).map((r) => `${r.batchId}@${r.hopDepth}`));

    // provenance with depth
    const sqlUp = setOf(
      (await query<{ batch_id: number; hop_depth: number }>(`SELECT * FROM fn_upstream_batches($1)`, [b.batch_id])).map(
        (r) => `${r.batch_id}@${r.hop_depth}`,
      ),
    );
    const cyUp = setOf((await graph.provenanceBatches(b.batch_id)).map((r) => `${r.batchId}@${r.hopDepth}`));

    const ok = same(sqlExp, cyExp) && same(sqlDown, cyDown) && same(sqlUp, cyUp);
    if (!ok) failures++;
    rows.push({
      batch: b.batch_code,
      exposure: `${sqlExp.size} / ${cyExp.size}`,
      downstream: `${sqlDown.size} / ${cyDown.size}`,
      provenance: `${sqlUp.size} / ${cyUp.size}`,
      agree: ok ? "yes" : "NO",
    });
  }

  console.log("columns show  SQL rows / Cypher rows");
  console.table(rows);
  console.log(
    failures === 0
      ? `All ${batches.length} batches agree: recursive CTE and Cypher return identical sets.`
      : `${failures} batch(es) disagree. Run npm run graph:resync and check the direction of WENT_INTO.`,
  );
  if (failures) process.exitCode = 1;
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
