import { requireUser } from "@/lib/auth/guard";
import { deleteShipment, getShipment } from "@/lib/data/shipments";
import { withTransaction } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";
import { handle, idParam, json, notFound } from "@/lib/http";
import { newSyncStatus, project } from "@/lib/sync";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/shipments/:id (MANUFACTURER): cancel a shipment. The header
 * DELETE cascades to its lines; trg_shipment_cancel first returns the stock
 * from the outlet, and refuses if any batch on it is recalled (the shipment
 * is evidence of exposure) or if the outlet has already sold some of it.
 */
export const DELETE = handle(async (_req, { params }: Ctx) => {
  const user = await requireUser("MANUFACTURER");
  const id = idParam((await params).id);
  const shipment = await getShipment(id);
  if (!shipment) throw notFound(`Shipment ${id} does not exist`);

  await withTransaction(user.userId, (client) => deleteShipment(client, id));

  const sync = newSyncStatus();
  await project(sync, "graph", `cancel shipment ${id}`, user.userId, () => graph.deleteShipment(id));
  return json({ cancelled: shipment, sync });
});
