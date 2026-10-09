import { requireUser } from "@/lib/auth/guard";
import { listAudit } from "@/lib/data/audit";
import { handle, json } from "@/lib/http";
import { auditListSchema, searchParams } from "@/lib/validation";

/** GET /api/audit (REGULATOR): paginated, filterable by action and date range. */
export const GET = handle(async (req) => {
  await requireUser("REGULATOR");
  return json(await listAudit(auditListSchema.parse(searchParams(req))));
});
