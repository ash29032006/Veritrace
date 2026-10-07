import { BATCH_COLLECTION, COMPLAINT_COLLECTION, qdrant } from "@/lib/db/qdrant";
import { batchText, embed } from "@/lib/embedding";
import type { BatchStatus } from "@/lib/types";

/*
 * Qdrant access. Point ids are the PostgreSQL primary keys, so a vector can
 * always be traced back to its row. Qdrant returns cosine SIMILARITY as the
 * score (higher is closer), unlike pgvector's <=> which returns distance.
 */

export interface BatchForVector {
  batch_id: number;
  batch_code: string;
  product_name: string;
  description: string | null;
  status: BatchStatus;
}

export async function upsertBatches(batches: BatchForVector[]): Promise<void> {
  if (batches.length === 0) return;
  const vectors = await embed(batches.map(batchText));
  await qdrant().upsert(BATCH_COLLECTION, {
    wait: true,
    points: batches.map((b, i) => ({
      id: b.batch_id,
      vector: vectors[i]!,
      payload: {
        batch_id: b.batch_id,
        batch_code: b.batch_code,
        product_name: b.product_name,
        status: b.status,
      },
    })),
  });
}

export async function setBatchStatus(batchIds: number[], status: BatchStatus): Promise<void> {
  if (batchIds.length === 0) return;
  await qdrant().setPayload(BATCH_COLLECTION, { wait: true, points: batchIds, payload: { status } });
}

export async function upsertComplaint(
  complaintId: number,
  vector: number[],
  payload: { outlet_id: number | null; matched_batch_id: number | null },
): Promise<void> {
  await qdrant().upsert(COMPLAINT_COLLECTION, {
    wait: true,
    points: [{ id: complaintId, vector, payload: { complaint_id: complaintId, ...payload } }],
  });
}

export interface ScoredBatch {
  batchId: number;
  score: number;
}

/**
 * Nearest batch descriptions. With `candidateIds` the search is restricted
 * to those batches (for example: only what was shipped to the complaint's
 * outlet); Qdrant applies the filter during the HNSW search, so it still
 * returns `limit` results when enough candidates exist.
 */
export async function searchBatches(
  vector: number[],
  opts: { candidateIds?: number[]; limit?: number } = {},
): Promise<ScoredBatch[]> {
  const res = await qdrant().query(BATCH_COLLECTION, {
    query: vector,
    limit: opts.limit ?? 5,
    with_payload: false,
    filter: opts.candidateIds
      ? { must: [{ key: "batch_id", match: { any: opts.candidateIds } }] }
      : undefined,
  });
  return res.points.map((p) => ({ batchId: Number(p.id), score: p.score }));
}

export async function searchComplaints(
  vector: number[],
  opts: { excludeId?: number; limit?: number } = {},
): Promise<ScoredBatch[]> {
  const res = await qdrant().query(COMPLAINT_COLLECTION, {
    query: vector,
    limit: opts.limit ?? 3,
    with_payload: false,
    filter: opts.excludeId ? { must_not: [{ has_id: [opts.excludeId] }] } : undefined,
  });
  return res.points.map((p) => ({ batchId: Number(p.id), score: p.score }));
}
