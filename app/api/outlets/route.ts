import { requireUser } from "@/lib/auth/guard";
import { listOutlets } from "@/lib/data/shipments";
import { handle, json } from "@/lib/http";

/** GET /api/outlets (any): every outlet, for pickers. */
export const GET = handle(async () => {
  await requireUser();
  return json(await listOutlets());
});
