import type { PoolClient } from "pg";
import { query, queryOne } from "@/lib/db/postgres";
import type { BatchStatus, Complaint, KeywordMatch } from "@/lib/types";

/* SQL for complaints, plus the full-text keyword baseline. */

const COMPLAINT_SELECT = `
  SELECT c.complaint_id, c.outlet_id, o.outlet_name, c.complaint_text, c.received_at,
         c.matched_batch_id, b.batch_code AS matched_batch_code,
         b.product_name AS matched_product, c.similarity_score
    FROM complaint c
    LEFT JOIN outlet o ON o.outlet_id = c.outlet_id
    LEFT JOIN batch  b ON b.batch_id  = c.matched_batch_id`;

export function listComplaints(limit = 100): Promise<Complaint[]> {
  return query<Complaint>(`${COMPLAINT_SELECT} ORDER BY c.received_at DESC LIMIT $1`, [limit]);
}

export function getComplaint(complaintId: number): Promise<Complaint | undefined> {
  return queryOne<Complaint>(`${COMPLAINT_SELECT} WHERE c.complaint_id = $1`, [complaintId]);
}

export function getComplaintsByIds(ids: number[]): Promise<Complaint[]> {
  if (ids.length === 0) return Promise.resolve([]);
  return query<Complaint>(`${COMPLAINT_SELECT} WHERE c.complaint_id = ANY($1::bigint[])`, [ids]);
}

export async function insertComplaint(
  client: PoolClient,
  c: { outletId: number | null; text: string },
): Promise<number> {
  const row = await queryOne<{ complaint_id: number }>(
    `INSERT INTO complaint (outlet_id, complaint_text) VALUES ($1, $2) RETURNING complaint_id`,
    [c.outletId, c.text],
    client,
  );
  return row!.complaint_id;
}

export async function recordMatch(complaintId: number, batchId: number, similarity: number) {
  // the stored score is clamped into the CHECK range [0, 1]
  const score = Math.min(1, Math.max(0, Math.round(similarity * 100000) / 100000));
  await query(
    `UPDATE complaint SET matched_batch_id = $2, similarity_score = $3 WHERE complaint_id = $1`,
    [complaintId, batchId, score],
  );
}

export function batchesByIds(ids: number[]) {
  if (ids.length === 0) return Promise.resolve([]);
  return query<{ batch_id: number; batch_code: string; product_name: string; status: BatchStatus }>(
    `SELECT batch_id, batch_code, product_name, status FROM batch WHERE batch_id = ANY($1::bigint[])`,
    [ids],
  );
}

/**
 * The keyword baseline: PostgreSQL full-text search of the complaint against
 * batch descriptions. Every lexeme is OR-ed, so a single shared word stem is
 * enough to match. Paraphrased complaints still come back empty, which is
 * why the vector search exists.
 */
export async function keywordSearch(text: string): Promise<{ query: string; matches: KeywordMatch[] }> {
  const q = await queryOne<{ query: string }>(
    `SELECT COALESCE(
              array_to_string(ARRAY(SELECT quote_literal(l)
                                       FROM unnest(tsvector_to_array(to_tsvector('english', $1))) AS l),
                              ' | '),
              '') AS query`,
    [text],
  );
  const tsq = q?.query ?? "";
  if (!tsq) return { query: "", matches: [] };
  const matches = await query<KeywordMatch>(
    `WITH q AS (SELECT to_tsquery('english', $1) AS query)
     SELECT b.batch_id AS "batchId", b.batch_code AS "batchCode", b.product_name AS "productName",
            ts_rank(to_tsvector('english', b.product_name || ' ' || COALESCE(b.description, '')), q.query) AS rank
       FROM batch b, q
      WHERE to_tsvector('english', b.product_name || ' ' || COALESCE(b.description, '')) @@ q.query
      ORDER BY rank DESC, b.batch_code
      LIMIT 5`,
    [tsq],
  );
  return { query: tsq.replaceAll("'", ""), matches };
}
