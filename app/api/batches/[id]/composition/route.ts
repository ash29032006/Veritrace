import { requireUser } from "@/lib/auth/guard";
import { getBatch, getBatchInputs, insertComposition } from "@/lib/data/batches";
import { withTransaction } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";
import { handle, idParam, json, notFound, readJson } from "@/lib/http";
import { newSyncStatus, project } from "@/lib/sync";
import { compositionSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/batches/:id/composition (MANUFACTURER): record that existing
 * batches went INTO this one. trg_guard_composition refuses recalled
 * inputs, overuse, inputs newer than the batch, and cycles; each refusal
 * comes back as 409 with the trigger's own message.
 */
export const POST = handle(async (req, { params }: Ctx) => {
  const user = await requireUser("MANUFACTURER");
  const childId = idParam((await params).id);
  const { inputs } = compositionSchema.parse(await readJson(req));
  if (!(await getBatch(childId))) throw notFound(`Batch ${childId} does not exist`);

  await withTransaction(user.userId, (client) => insertComposition(client, childId, inputs));

  const sync = newSyncStatus();
  await project(sync, "graph", `composition of batch ${childId}`, user.userId, async () => {
    for (const i of inputs) await graph.mergeComposition(i.batchId, childId, i.quantityUsed);
  });

  return json({ inputs: await getBatchInputs(childId), sync }, 201);
});
