import { requireUser } from "@/lib/auth/guard";
import { getBatch } from "@/lib/data/batches";
import { EXPOSURE_CTE, exposureViaCte } from "@/lib/data/exposure";
import * as graph from "@/lib/graph";
import { EXPOSURE_COMPARE } from "@/lib/graph/cypher";
import { handle, idParam, json, notFound } from "@/lib/http";
import type { ComparisonReport } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

const key = (r: { outletId: number; batchId: number; shipmentId: number }) =>
  `outlet ${r.outletId} · batch ${r.batchId} · shipment ${r.shipmentId}`;

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const started = performance.now();
  const value = await fn();
  return [value, Math.round((performance.now() - started) * 10) / 10];
}

/**
 * GET /api/batches/:id/compare (any): the requirement 18 demonstration.
 * The same forward-exposure question as a recursive CTE in PostgreSQL and as
 * a variable-length pattern in Neo4j. The two result sets must be identical.
 */
export const GET = handle(async (_req, { params }: Ctx) => {
  await requireUser();
  const id = idParam((await params).id);
  const batch = await getBatch(id);
  if (!batch) throw notFound(`Batch ${id} does not exist`);

  const [sqlRows, sqlMs] = await timed(() => exposureViaCte(id));
  const [cypherRows, cypherMs] = await timed(() => graph.exposureForComparison(id));

  const sqlKeys = new Set(sqlRows.map(key));
  const cypherKeys = new Set(cypherRows.map(key));
  const onlyInSql = [...sqlKeys].filter((k) => !cypherKeys.has(k)).sort();
  const onlyInCypher = [...cypherKeys].filter((k) => !sqlKeys.has(k)).sort();

  const report: ComparisonReport = {
    batchCode: batch.batch_code,
    sql: { engine: "postgres", query: EXPOSURE_CTE, rows: sqlRows.length, elapsedMs: sqlMs, keys: [...sqlKeys].sort() },
    cypher: {
      engine: "neo4j",
      query: EXPOSURE_COMPARE,
      rows: cypherRows.length,
      elapsedMs: cypherMs,
      keys: [...cypherKeys].sort(),
    },
    agree: onlyInSql.length === 0 && onlyInCypher.length === 0,
    onlyInSql,
    onlyInCypher,
  };
  return json(report);
});
