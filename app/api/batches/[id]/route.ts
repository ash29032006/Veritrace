import { requireUser } from "@/lib/auth/guard";
import { getBatch, getBatchInputs, getBatchOutputs, updateBatchStatus } from "@/lib/data/batches";
import { withTransaction } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";
import { handle, idParam, json, notFound, readJson } from "@/lib/http";
import { newSyncStatus, project } from "@/lib/sync";
import { batchStatusSchema } from "@/lib/validation";
import * as vector from "@/lib/vector";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/batches/:id (any): the batch, its direct inputs and what it went into. */
export const GET = handle(async (_req, { params }: Ctx) => {
  await requireUser();
  const id = idParam((await params).id);
  const batch = await getBatch(id);
  if (!batch) throw notFound(`Batch ${id} does not exist`);
  const [inputs, outputs] = await Promise.all([getBatchInputs(id), getBatchOutputs(id)]);
  return json({ batch, inputs, outputs });
});

/**
 * PATCH /api/batches/:id (MANUFACTURER): put a batch on hold (QUARANTINED)
 * or release it (ACTIVE). RECALLED is refused by trg_batch_status_guard
 * unless it comes from sp_initiate_recall.
 */
export const PATCH = handle(async (req, { params }: Ctx) => {
  const user = await requireUser("MANUFACTURER");
  const id = idParam((await params).id);
  const { status } = batchStatusSchema.parse(await readJson(req));

  const updated = await withTransaction(user.userId, (client) => updateBatchStatus(client, id, status));
  if (!updated) throw notFound(`Batch ${id} does not exist`);

  const sync = newSyncStatus();
  await project(sync, "graph", `status of batch ${id}`, user.userId, () => graph.setStatus([id], status));
  await project(sync, "vector", `status of batch ${id}`, user.userId, () => vector.setBatchStatus([id], status));
  return json({ batch: await getBatch(id), sync });
});
