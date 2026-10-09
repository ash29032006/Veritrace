import { requireUser } from "@/lib/auth/guard";
import { matchComplaint } from "@/lib/complaint-matching";
import { getComplaint, insertComplaint, listComplaints } from "@/lib/data/complaints";
import { getOutlet } from "@/lib/data/shipments";
import { withTransaction } from "@/lib/db/postgres";
import { handle, json, notFound, readJson } from "@/lib/http";
import { newSyncStatus } from "@/lib/sync";
import type { ComplaintAnalysis, SyncStatus } from "@/lib/types";
import { complaintCreateSchema } from "@/lib/validation";

/** GET /api/complaints (REGULATOR): every complaint with its matched batch and score. */
export const GET = handle(async () => {
  await requireUser("REGULATOR");
  return json(await listComplaints());
});

/**
 * POST /api/complaints (any): store the complaint in PostgreSQL (the audit
 * trigger records it), then match it to a batch by meaning, not keywords.
 * See lib/complaint-matching.ts for the pipeline.
 */
export const POST = handle(async (req) => {
  const user = await requireUser();
  const input = complaintCreateSchema.parse(await readJson(req));
  const outletId = input.outletId ?? null;
  if (outletId && !(await getOutlet(outletId))) throw notFound(`Outlet ${outletId} does not exist`);

  const complaintId = await withTransaction(user.userId, (client) =>
    insertComplaint(client, { outletId, text: input.text }),
  );
  const { vectorError, ...match } = await matchComplaint({ complaintId, text: input.text, outletId });

  const sync: SyncStatus = newSyncStatus();
  sync.vector = vectorError ? "failed" : "ok";
  if (vectorError) sync.errors.push(`Qdrant / embedding: ${vectorError}`);

  const body: ComplaintAnalysis & { sync: SyncStatus } = {
    complaint: (await getComplaint(complaintId))!,
    ...match,
    sync,
  };
  return json(body, 201);
});
