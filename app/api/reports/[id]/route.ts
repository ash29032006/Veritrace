import { requireUser } from "@/lib/auth/guard";
import { runReport } from "@/lib/data/reports";
import { handle, json, notFound } from "@/lib/http";
import { searchParams } from "@/lib/validation";

type Ctx = { params: Promise<{ id: string }> };

/** GET /api/reports/:id (any): run one query and return its SQL, columns and rows. */
export const GET = handle(async (req, { params }: Ctx) => {
  await requireUser();
  const { id } = await params;
  const report = await runReport(id, searchParams(req));
  if (!report) throw notFound(`No report called ${id}`);
  return json(report);
});
