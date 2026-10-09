import type { PoolClient } from "pg";
import { query, queryOne } from "@/lib/db/postgres";
import type { Recall } from "@/lib/types";

/* SQL for recalls. The cascade itself lives in sp_initiate_recall. */

const RECALL_SELECT = `
  SELECT r.recall_id, r.batch_id, b.batch_code, b.product_name, r.reason,
         ui.username AS initiated_by, r.initiated_at, r.recall_status,
         uc.username AS closed_by, r.closed_at,
         (SELECT COUNT(*)::int FROM recall_batch rb WHERE rb.recall_id = r.recall_id) AS batches_in_scope,
         (SELECT COUNT(DISTINCT s.outlet_id)::int
            FROM recall_batch rb
            JOIN shipment_line sl ON sl.batch_id = rb.batch_id
            JOIN shipment s       ON s.shipment_id = sl.shipment_id
           WHERE rb.recall_id = r.recall_id) AS outlets_exposed,
         (SELECT COALESCE(SUM(i.quantity_on_hand), 0)
            FROM recall_batch rb
            JOIN inventory i ON i.batch_id = rb.batch_id
           WHERE rb.recall_id = r.recall_id AND i.stock_status = 'QUARANTINED') AS units_quarantined
    FROM recall r
    JOIN batch    b  ON b.batch_id  = r.batch_id
    JOIN app_user ui ON ui.user_id  = r.initiated_by
    LEFT JOIN app_user uc ON uc.user_id = r.closed_by`;

export function listRecalls(status?: "OPEN" | "CLOSED"): Promise<Recall[]> {
  return query<Recall>(
    `${RECALL_SELECT}
     ${status ? "WHERE r.recall_status = $1" : ""}
     ORDER BY r.initiated_at DESC`,
    status ? [status] : [],
  );
}

export function getRecall(recallId: number, client?: PoolClient): Promise<Recall | undefined> {
  return queryOne<Recall>(`${RECALL_SELECT} WHERE r.recall_id = $1`, [recallId], client);
}

export function recallScope(recallId: number) {
  return query<{ batch_id: number; batch_code: string; product_name: string; hop_depth: number }>(
    `SELECT rb.batch_id, b.batch_code, b.product_name, rb.hop_depth
       FROM recall_batch rb JOIN batch b ON b.batch_id = rb.batch_id
      WHERE rb.recall_id = $1
      ORDER BY rb.hop_depth, b.batch_code`,
    [recallId],
  );
}

/**
 * CALL the procedure inside the caller's transaction. Everything it does
 * (recall row, scope, statuses, quarantine, audit) commits or rolls back
 * with that transaction.
 */
export async function callInitiateRecall(
  client: PoolClient,
  args: { batchId: number; reason: string; userId: number; affected: { batchId: number; hopDepth: number }[] },
): Promise<number> {
  const row = await queryOne<{ p_recall_id: number }>(
    `CALL sp_initiate_recall($1, $2, $3, $4::bigint[], $5::int[], NULL)`,
    [
      args.batchId,
      args.reason,
      args.userId,
      args.affected.map((a) => a.batchId),
      args.affected.map((a) => a.hopDepth),
    ],
    client,
  );
  return row!.p_recall_id;
}

export async function callCloseRecall(client: PoolClient, recallId: number, userId: number) {
  await client.query(`CALL sp_close_recall($1, $2)`, [recallId, userId]);
}
