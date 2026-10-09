import { requireUser } from "@/lib/auth/guard";
import { exposureSummary } from "@/lib/data/exposure";
import { handle, json } from "@/lib/http";

/** GET /api/exposure-summary (any): reads the v_outlet_exposure view. */
export const GET = handle(async () => {
  await requireUser();
  return json(await exposureSummary());
});
