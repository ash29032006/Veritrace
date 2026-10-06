import { query, queryOne, type Queryable } from "@/lib/db/postgres";
import type { AuditEntry, Page } from "@/lib/types";

/*
 * The audit log is append only (trg_audit_append_only). Most rows are
 * written by triggers and procedures inside the transaction they describe;
 * the API itself only records sign-ins and sign-outs.
 */

export async function writeAudit(
  e: { action: string; entity: string; entityId?: number | null; userId: number | null; details?: string },
  client?: Queryable,
): Promise<void> {
  await query(
    `INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
     VALUES ($1, $2, $3, $4, $5)`,
    [e.action, e.entity, e.entityId ?? null, e.userId, e.details ?? null],
    client,
  );
}

export async function listAudit(f: {
  action?: string;
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}): Promise<Page<AuditEntry> & { actions: string[] }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.action) {
    params.push(f.action);
    where.push(`a.action = $${params.length}`);
  }
  if (f.from) {
    params.push(f.from);
    where.push(`a.performed_at >= $${params.length}::date`);
  }
  if (f.to) {
    params.push(f.to);
    where.push(`a.performed_at < $${params.length}::date + 1`);
  }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await queryOne<{ n: number }>(`SELECT COUNT(*)::int AS n FROM audit_log a ${clause}`, params);
  const rows = await query<AuditEntry>(
    `SELECT a.log_id, a.action, a.entity_name, a.entity_id, u.username AS performed_by,
            a.performed_at, a.details
       FROM audit_log a
       LEFT JOIN app_user u ON u.user_id = a.performed_by
       ${clause}
      ORDER BY a.performed_at DESC, a.log_id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.pageSize, (f.page - 1) * f.pageSize],
  );
  const actions = await query<{ action: string }>(`SELECT DISTINCT action FROM audit_log ORDER BY action`);
  return {
    rows,
    total: total?.n ?? 0,
    page: f.page,
    pageSize: f.pageSize,
    actions: actions.map((a) => a.action),
  };
}
