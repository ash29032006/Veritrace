import { requireUser } from "@/lib/auth/guard";
import { batchesForPicker } from "@/lib/data/batches";
import { handle, json } from "@/lib/http";

/**
 * GET /api/batches/picker (any): compact list for dropdowns.
 * ?shippable=1 keeps only batches with stock left. Recalled batches are
 * deliberately NOT filtered out, so the trigger can be shown refusing them.
 */
export const GET = handle(async (req) => {
  await requireUser();
  const shippable = new URL(req.url).searchParams.get("shippable") === "1";
  return json(await batchesForPicker(shippable));
});
