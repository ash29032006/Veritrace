import { requireUser } from "@/lib/auth/guard";
import { getBatch, insertBatch, insertComposition, listBatches } from "@/lib/data/batches";
import { withTransaction } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";
import { handle, json, readJson } from "@/lib/http";
import { newSyncStatus, project } from "@/lib/sync";
import { batchCreateSchema, batchListSchema, searchParams } from "@/lib/validation";
import * as vector from "@/lib/vector";

/** GET /api/batches (any): search by code or product, filter by status and stage. */
export const GET = handle(async (req) => {
  await requireUser();
  const filters = batchListSchema.parse(searchParams(req));
  return json(await listBatches(filters));
});

/**
 * POST /api/batches (MANUFACTURER): register a batch, optionally with the
 * batches it was made from. Postgres commits first (the composition trigger
 * checks every input), then the Neo4j node and edges and the Qdrant vector.
 */
export const POST = handle(async (req) => {
  const user = await requireUser("MANUFACTURER");
  const input = batchCreateSchema.parse(await readJson(req));

  const created = await withTransaction(user.userId, async (client) => {
    const batch = await insertBatch(client, input);
    await insertComposition(client, batch.batch_id, input.inputs);
    return batch;
  });

  const sync = newSyncStatus();
  await project(sync, "graph", `batch ${created.batch_code}`, user.userId, async () => {
    await graph.mergeBatch(created);
    for (const i of input.inputs) await graph.mergeComposition(i.batchId, created.batch_id, i.quantityUsed);
  });
  await project(sync, "vector", `batch ${created.batch_code}`, user.userId, () =>
    vector.upsertBatches([created]),
  );

  return json({ batch: await getBatch(created.batch_id), sync }, 201);
});
