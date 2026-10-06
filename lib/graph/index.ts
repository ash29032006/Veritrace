import { cypherRead, cypherWrite, int } from "@/lib/db/neo4j";
import * as Q from "@/lib/graph/cypher";
import type { BatchStatus, ExposureRow, LineageEdge, LineageNode } from "@/lib/types";

/*
 * Neo4j access. Reads answer exposure and provenance; writes keep the
 * projection in step with PostgreSQL, in the same request, after Postgres
 * has committed. A write that matches nothing means the projection has
 * drifted, and that is raised, never ignored.
 *
 * Ids are always sent as Neo4j integers (int()). A plain JS number would
 * arrive as a float and the node would be stored with batch_id 7.0.
 */

export class GraphDriftError extends Error {
  constructor(what: string) {
    super(`Graph projection is missing ${what}. Run npm run graph:resync.`);
    this.name = "GraphDriftError";
  }
}

/* ---------- reads ---------- */

export async function batchNode(batchId: number): Promise<LineageNode | null> {
  const [row] = await cypherRead<Omit<LineageNode, "hopDepth">>(Q.BATCH_NODE, { batchId: int(batchId) });
  return row ? { ...row, hopDepth: 0 } : null;
}

export function downstreamBatches(batchId: number): Promise<LineageNode[]> {
  return cypherRead<LineageNode>(Q.DOWNSTREAM_BATCHES, { batchId: int(batchId) });
}

export function downstreamEdges(batchId: number): Promise<LineageEdge[]> {
  return cypherRead<LineageEdge>(Q.DOWNSTREAM_EDGES, { batchId: int(batchId) });
}

export function exposureOutlets(batchId: number): Promise<ExposureRow[]> {
  return cypherRead<ExposureRow>(Q.EXPOSURE_OUTLETS, { batchId: int(batchId) });
}

export function provenanceBatches(batchId: number): Promise<LineageNode[]> {
  return cypherRead<LineageNode>(Q.PROVENANCE_BATCHES, { batchId: int(batchId) });
}

export function provenanceEdges(batchId: number): Promise<LineageEdge[]> {
  return cypherRead<LineageEdge>(Q.PROVENANCE_EDGES, { batchId: int(batchId) });
}

export function exposureForComparison(batchId: number) {
  return cypherRead<{ outletId: number; batchId: number; shipmentId: number; quantity: number }>(
    Q.EXPOSURE_COMPARE,
    { batchId: int(batchId) },
  );
}

/* ---------- writes ---------- */

export async function mergeBatch(b: {
  batch_id: number;
  batch_code: string;
  product_name: string;
  status: BatchStatus;
}): Promise<void> {
  await cypherWrite(Q.MERGE_BATCH, {
    batchId: int(b.batch_id),
    batchCode: b.batch_code,
    productName: b.product_name,
    status: b.status,
  });
}

export async function mergeComposition(parentId: number, childId: number, quantityUsed: number) {
  const [row] = await cypherWrite<{ merged: number }>(Q.MERGE_COMPOSITION, {
    parentId: int(parentId),
    childId: int(childId),
    quantityUsed,
  });
  if (!row || row.merged === 0) throw new GraphDriftError(`batch node ${parentId} or ${childId}`);
}

export async function mergeOutlet(o: { outlet_id: number; outlet_name: string; city: string }) {
  await cypherWrite(Q.MERGE_OUTLET, { outletId: int(o.outlet_id), outletName: o.outlet_name, city: o.city });
}

export async function mergeShipment(s: {
  shipment_id: number;
  outlet: { outlet_id: number; outlet_name: string; city: string };
  shipment_date: string;
  lines: { batch_id: number; quantity: number }[];
}): Promise<void> {
  await mergeOutlet(s.outlet);
  const [row] = await cypherWrite<{ merged: number }>(Q.MERGE_SHIPMENT_LINES, {
    outletId: int(s.outlet.outlet_id),
    shipmentId: int(s.shipment_id),
    shipmentDate: s.shipment_date,
    lines: s.lines.map((l) => ({ batchId: int(l.batch_id), quantity: l.quantity })),
  });
  const merged = row?.merged ?? 0;
  if (merged !== s.lines.length) {
    throw new GraphDriftError(`${s.lines.length - merged} batch node(s) for shipment ${s.shipment_id}`);
  }
}

export async function deleteShipment(shipmentId: number): Promise<void> {
  await cypherWrite(Q.DELETE_SHIPMENT, { shipmentId: int(shipmentId) });
}

export async function setStatus(batchIds: number[], status: BatchStatus): Promise<void> {
  if (batchIds.length === 0) return;
  const [row] = await cypherWrite<{ updated: number }>(Q.SET_STATUS, { batchIds: batchIds.map(int), status });
  const updated = row?.updated ?? 0;
  if (updated !== batchIds.length) {
    throw new GraphDriftError(`${batchIds.length - updated} of ${batchIds.length} batch node(s)`);
  }
}
