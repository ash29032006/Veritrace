import { query } from "@/lib/db/postgres";
import type { SyncStatus } from "@/lib/types";

/*
 * PostgreSQL commits first. Neo4j and Qdrant are then updated in the same
 * request. If either fails, the Postgres change stands (it is the source of
 * truth), the failure is logged to the console and to audit_log, and the
 * response says so. Nothing is swallowed.
 */

export function newSyncStatus(): SyncStatus {
  return { graph: "skipped", vector: "skipped", errors: [] };
}

export async function project(
  status: SyncStatus,
  target: "graph" | "vector",
  what: string,
  userId: number | null,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await work();
    if (status[target] !== "failed") status[target] = "ok";
  } catch (err) {
    status[target] = "failed";
    const message = err instanceof Error ? err.message : String(err);
    const label = target === "graph" ? "Neo4j" : "Qdrant";
    status.errors.push(`${label}: ${message}`);
    console.error(`[veritrace] ${label} sync failed for ${what}:`, err);
    await query(
      `INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
       VALUES ($1, $2, NULL, $3, $4)`,
      [target === "graph" ? "GRAPH_SYNC_FAILED" : "VECTOR_SYNC_FAILED", target, userId, `${what}: ${message}`.slice(0, 1000)],
    ).catch((auditErr) => console.error("[veritrace] could not record sync failure", auditErr));
  }
}
