import { requireUser } from "@/lib/auth/guard";
import { REPORTS } from "@/lib/data/reports";
import { handle, json } from "@/lib/http";

/** GET /api/reports (any): the catalogue of requirement 6 queries. */
export const GET = handle(async () => {
  await requireUser();
  return json(REPORTS.map(({ id, title, summary, features }) => ({ id, title, summary, features })));
});
