import { requireUser } from "@/lib/auth/guard";
import * as graph from "@/lib/graph";
import { handle, idParam, json, notFound } from "@/lib/http";
import type { ProvenanceReport } from "@/lib/types";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/batches/:id/provenance (any): backward traversal in Neo4j, every input at any depth. */
export const GET = handle(async (_req, { params }: Ctx) => {
  await requireUser();
  const id = idParam((await params).id);

  const started = performance.now();
  const source = await graph.batchNode(id);
  if (!source) throw notFound(`Batch ${id} is not in the graph. Run npm run graph:resync if it exists in PostgreSQL.`);
  const [upstream, edges] = await Promise.all([graph.provenanceBatches(id), graph.provenanceEdges(id)]);

  const report: ProvenanceReport = {
    source,
    upstream,
    edges,
    engine: "neo4j",
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
  return json(report);
});
