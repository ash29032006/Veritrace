import type { PoolClient } from "pg";
import { query, queryOne, type Queryable } from "@/lib/db/postgres";
import type { Batch, BatchStatus, CompositionInput, Page } from "@/lib/types";

/* SQL for batches and their composition. */

const BATCH_COLUMNS = `
    s.batch_id, s.batch_code, s.product_name, b.description, s.manufacture_date,
    s.quantity_produced, s.status, s.quantity_consumed, s.quantity_shipped,
    s.quantity_available, s.input_count::int AS input_count, s.output_count::int AS output_count`;

export async function listBatches(f: {
  q?: string;
  status?: BatchStatus;
  stage?: "raw" | "intermediate" | "finished";
  page: number;
  pageSize: number;
}): Promise<Page<Batch>> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (f.q) {
    params.push(`%${f.q}%`);
    where.push(`(s.batch_code ILIKE $${params.length} OR s.product_name ILIKE $${params.length})`);
  }
  if (f.status) {
    params.push(f.status);
    where.push(`s.status = $${params.length}`);
  }
  if (f.stage === "raw") where.push("s.input_count = 0");
  if (f.stage === "finished") where.push("s.input_count > 0 AND s.output_count = 0");
  if (f.stage === "intermediate") where.push("s.input_count > 0 AND s.output_count > 0");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const total = await queryOne<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM v_batch_stock s ${clause}`,
    params,
  );
  params.push(f.pageSize, (f.page - 1) * f.pageSize);
  const rows = await query<Batch>(
    `SELECT ${BATCH_COLUMNS}
       FROM v_batch_stock s
       JOIN batch b ON b.batch_id = s.batch_id
       ${clause}
      ORDER BY s.manufacture_date DESC, s.batch_code
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  return { rows, total: total?.n ?? 0, page: f.page, pageSize: f.pageSize };
}

export async function getBatch(batchId: number, client?: Queryable): Promise<Batch | undefined> {
  return queryOne<Batch>(
    `SELECT ${BATCH_COLUMNS}
       FROM v_batch_stock s
       JOIN batch b ON b.batch_id = s.batch_id
      WHERE s.batch_id = $1`,
    [batchId],
    client,
  );
}

export async function getBatchInputs(batchId: number): Promise<CompositionInput[]> {
  return query<CompositionInput>(
    `SELECT b.batch_id, b.batch_code, b.product_name, b.status, bc.quantity_used
       FROM batch_composition bc
       JOIN batch b ON b.batch_id = bc.parent_batch_id
      WHERE bc.child_batch_id = $1
      ORDER BY b.batch_code`,
    [batchId],
  );
}

export async function getBatchOutputs(batchId: number): Promise<CompositionInput[]> {
  return query<CompositionInput>(
    `SELECT b.batch_id, b.batch_code, b.product_name, b.status, bc.quantity_used
       FROM batch_composition bc
       JOIN batch b ON b.batch_id = bc.child_batch_id
      WHERE bc.parent_batch_id = $1
      ORDER BY b.batch_code`,
    [batchId],
  );
}

export interface NewBatch {
  batchCode: string;
  productName: string;
  description: string | null;
  manufactureDate: string;
  quantityProduced: number;
}

export async function insertBatch(client: PoolClient, b: NewBatch) {
  const row = await queryOne<{
    batch_id: number;
    batch_code: string;
    product_name: string;
    description: string | null;
    status: BatchStatus;
  }>(
    `INSERT INTO batch (batch_code, product_name, description, manufacture_date, quantity_produced)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING batch_id, batch_code, product_name, description, status`,
    [b.batchCode, b.productName, b.description, b.manufactureDate, b.quantityProduced],
    client,
  );
  return row!;
}

/** Each row passes trg_guard_composition: safe inputs, enough stock, no cycle. */
export async function insertComposition(
  client: PoolClient,
  childId: number,
  inputs: { batchId: number; quantityUsed: number }[],
): Promise<void> {
  for (const input of inputs) {
    await client.query(
      `INSERT INTO batch_composition (parent_batch_id, child_batch_id, quantity_used)
       VALUES ($1, $2, $3)`,
      [input.batchId, childId, input.quantityUsed],
    );
  }
}

export async function updateBatchStatus(client: PoolClient, batchId: number, status: BatchStatus) {
  return queryOne<{ batch_id: number; status: BatchStatus }>(
    `UPDATE batch SET status = $2 WHERE batch_id = $1 RETURNING batch_id, status`,
    [batchId, status],
    client,
  );
}

export async function batchesForPicker(onlyShippable: boolean) {
  return query<{
    batch_id: number;
    batch_code: string;
    product_name: string;
    status: BatchStatus;
    quantity_available: number;
    manufacture_date: string;
  }>(
    `SELECT batch_id, batch_code, product_name, status, quantity_available, manufacture_date
       FROM v_batch_stock
      ${onlyShippable ? "WHERE quantity_available > 0" : ""}
      ORDER BY batch_code`,
  );
}
