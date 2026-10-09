import type { PoolClient } from "pg";
import { query, queryOne } from "@/lib/db/postgres";
import type { Outlet, Shipment } from "@/lib/types";

/* SQL for outlets and shipments. */

export function listOutlets(): Promise<Outlet[]> {
  return query<Outlet>(
    `SELECT outlet_id, outlet_name, city, contact_email FROM outlet ORDER BY city, outlet_name`,
  );
}

export function getOutlet(outletId: number, client?: PoolClient) {
  return queryOne<Outlet>(
    `SELECT outlet_id, outlet_name, city, contact_email FROM outlet WHERE outlet_id = $1`,
    [outletId],
    client,
  );
}

const SHIPMENT_SELECT = `
  SELECT s.shipment_id, s.outlet_id, o.outlet_name, o.city, s.shipment_date,
         u.username AS dispatched_by,
         COALESCE(SUM(sl.quantity), 0) AS total_units,
         COALESCE(
           json_agg(json_build_object(
             'batch_id', b.batch_id, 'batch_code', b.batch_code,
             'product_name', b.product_name, 'status', b.status,
             'quantity', sl.quantity) ORDER BY b.batch_code)
           FILTER (WHERE sl.batch_id IS NOT NULL), '[]') AS lines
    FROM shipment s
    JOIN outlet   o ON o.outlet_id = s.outlet_id
    JOIN app_user u ON u.user_id   = s.dispatched_by
    LEFT JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
    LEFT JOIN batch         b  ON b.batch_id     = sl.batch_id`;

export async function listShipments(f: { outletId?: number; limit: number }): Promise<Shipment[]> {
  const params: unknown[] = [];
  let where = "";
  if (f.outletId) {
    params.push(f.outletId);
    where = `WHERE s.outlet_id = $1`;
  }
  params.push(f.limit);
  return query<Shipment>(
    `${SHIPMENT_SELECT}
     ${where}
     GROUP BY s.shipment_id, o.outlet_name, o.city, u.username
     ORDER BY s.shipment_date DESC, s.shipment_id DESC
     LIMIT $${params.length}`,
    params,
  );
}

export async function getShipment(shipmentId: number, client?: PoolClient): Promise<Shipment | undefined> {
  return queryOne<Shipment>(
    `${SHIPMENT_SELECT}
     WHERE s.shipment_id = $1
     GROUP BY s.shipment_id, o.outlet_name, o.city, u.username`,
    [shipmentId],
    client,
  );
}

export async function insertShipment(
  client: PoolClient,
  s: { outletId: number; shipmentDate?: string; dispatchedBy: number },
): Promise<{ shipment_id: number; shipment_date: string }> {
  const row = await queryOne<{ shipment_id: number; shipment_date: string }>(
    `INSERT INTO shipment (outlet_id, shipment_date, dispatched_by)
     VALUES ($1, COALESCE($2::date, CURRENT_DATE), $3)
     RETURNING shipment_id, shipment_date`,
    [s.outletId, s.shipmentDate ?? null, s.dispatchedBy],
    client,
  );
  return row!;
}

/** Each line passes trg_block_unsafe_shipment; trg_inventory_receive then books the stock. */
export async function insertShipmentLines(
  client: PoolClient,
  shipmentId: number,
  lines: { batchId: number; quantity: number }[],
): Promise<void> {
  for (const line of lines) {
    await client.query(
      `INSERT INTO shipment_line (shipment_id, batch_id, quantity) VALUES ($1, $2, $3)`,
      [shipmentId, line.batchId, line.quantity],
    );
  }
}

/** trg_shipment_cancel releases the stock (or refuses), then the lines cascade away. */
export async function deleteShipment(client: PoolClient, shipmentId: number): Promise<boolean> {
  const res = await client.query(`DELETE FROM shipment WHERE shipment_id = $1`, [shipmentId]);
  return (res.rowCount ?? 0) > 0;
}

/** Batches shipped to an outlet, most recent first: the candidate set for complaint matching. */
export function batchesShippedToOutlet(outletId: number) {
  return query<{ batch_id: number; last_shipped: string }>(
    `SELECT sl.batch_id, MAX(s.shipment_date) AS last_shipped
       FROM shipment s
       JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
      WHERE s.outlet_id = $1
      GROUP BY sl.batch_id`,
    [outletId],
  );
}

/** Every batch that has reached any outlet: what a customer could possibly have bought. */
export function batchesShippedAnywhere() {
  return query<{ batch_id: number; last_shipped: string }>(
    `SELECT sl.batch_id, MAX(s.shipment_date) AS last_shipped
       FROM shipment s
       JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
      GROUP BY sl.batch_id`,
  );
}
