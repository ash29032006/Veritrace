import { requireUser } from "@/lib/auth/guard";
import { getBatch } from "@/lib/data/batches";
import { callInitiateRecall, getRecall, listRecalls, recallScope } from "@/lib/data/recalls";
import { withTransaction } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";
import { ApiError, handle, json, notFound, readJson } from "@/lib/http";
import { newSyncStatus, project } from "@/lib/sync";
import { recallCreateSchema } from "@/lib/validation";
import * as vector from "@/lib/vector";

/** GET /api/recalls (any): newest first; ?status=OPEN|CLOSED to filter. */
export const GET = handle(async (req) => {
  await requireUser();
  const s = new URL(req.url).searchParams.get("status");
  return json(await listRecalls(s === "OPEN" || s === "CLOSED" ? s : undefined));
});

/**
 * POST /api/recalls (MANUFACTURER): the recall cascade.
 *
 *   1. role check (here, and again inside the procedure)
 *   2. Neo4j resolves the affected set: every batch downstream of the
 *      source, at any depth, shipped or not, with its hop depth
 *   3. sp_initiate_recall does all PostgreSQL work in ONE transaction:
 *      recall + scope rows, batch statuses, inventory quarantine, audit.
 *      It also re-derives the downstream set with a recursive CTE and
 *      refuses if the graph missed anything.
 *   4. Neo4j node statuses and Qdrant payloads are updated
 *   5. the exposure report is returned
 *
 * The cross-database boundary is this handler, not the procedure: a
 * PostgreSQL procedure cannot query Neo4j.
 */
export const POST = handle(async (req) => {
  const user = await requireUser("MANUFACTURER");
  const { batchId, reason } = recallCreateSchema.parse(await readJson(req));
  const batch = await getBatch(batchId);
  if (!batch) throw notFound(`Batch ${batchId} does not exist`);

  // 2. resolve the affected set in the graph. If Neo4j is down we fail
  //    closed: a recall with an unknown scope is worse than no recall yet.
  let downstream;
  try {
    downstream = await graph.downstreamBatches(batchId);
  } catch (err) {
    throw new ApiError(
      503,
      `Cannot resolve the recall scope because Neo4j is unavailable (${(err as Error).message}). Nothing was changed.`,
      "graph_unavailable",
      { source: "graph" },
    );
  }
  if (!downstream.some((b) => b.batchId === batchId)) {
    throw new ApiError(409, `Batch ${batch.batch_code} is missing from the graph. Run npm run graph:resync.`, "graph_drift", {
      source: "graph",
    });
  }
  const affected = downstream.filter((b) => b.batchId !== batchId);

  // 3. one transaction, one procedure call
  const recallId = await withTransaction(user.userId, (client) =>
    callInitiateRecall(client, {
      batchId,
      reason,
      userId: user.userId,
      affected: affected.map((b) => ({ batchId: b.batchId, hopDepth: b.hopDepth })),
    }),
  );

  // 4. bring the projections in line
  const scope = await recallScope(recallId);
  const scopeIds = scope.map((s) => s.batch_id);
  const sync = newSyncStatus();
  await project(sync, "graph", `recall ${recallId}`, user.userId, () => graph.setStatus(scopeIds, "RECALLED"));
  await project(sync, "vector", `recall ${recallId}`, user.userId, () => vector.setBatchStatus(scopeIds, "RECALLED"));

  // 5. the report
  const outlets = await graph.exposureOutlets(batchId).catch(() => []);
  return json({ recall: await getRecall(recallId), scope, outlets, sync }, 201);
});
