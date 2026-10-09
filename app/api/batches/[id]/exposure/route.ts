import { requireUser } from "@/lib/auth/guard";
import * as graph from "@/lib/graph";
import { handle, idParam, json, notFound } from "@/lib/http";
import type { ExposureReport } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/batches/:id/exposure (any): forward traversal in Neo4j.
 * Every batch downstream of this one (shipped or not), the WENT_INTO edges
 * between them, and every outlet that received any of them.
 */
export const GET = handle(async (_req, { params }: Ctx) => {
  await requireUser();
  const id = idParam((await params).id);

  const started = performance.now();
  const source = await graph.batchNode(id);
  if (!source) throw notFound(`Batch ${id} is not in the graph. Run npm run graph:resync if it exists in PostgreSQL.`);
  const [downstream, edges, outlets] = await Promise.all([
    graph.downstreamBatches(id),
    graph.downstreamEdges(id),
    graph.exposureOutlets(id),
  ]);

  const report: ExposureReport = {
    source,
    downstream: downstream.filter((b) => b.batchId !== id),
    edges,
    outlets,
    engine: "neo4j",
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
  return json(report);
});
