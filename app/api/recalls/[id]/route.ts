import { requireUser } from "@/lib/auth/guard";
import { callCloseRecall, getRecall, recallScope } from "@/lib/data/recalls";
import { withTransaction } from "@/lib/db/postgres";
import { handle, idParam, json, notFound, readJson } from "@/lib/http";
import { recallPatchSchema } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/recalls/:id (any): the recall and its persisted scope. */
export const GET = handle(async (_req, { params }: Ctx) => {
  await requireUser();
  const id = idParam((await params).id);
  const recall = await getRecall(id);
  if (!recall) throw notFound(`Recall ${id} does not exist`);
  return json({ recall, scope: await recallScope(id) });
});

/**
 * PATCH /api/recalls/:id (REGULATOR): close a recall. sp_close_recall
 * checks the role again and refuses while any affected stock is still
 * available for sale anywhere.
 */
export const PATCH = handle(async (req, { params }: Ctx) => {
  const user = await requireUser("REGULATOR");
  const id = idParam((await params).id);
  recallPatchSchema.parse(await readJson(req));
  await withTransaction(user.userId, (client) => callCloseRecall(client, id, user.userId));
  return json({ recall: await getRecall(id) });
});
