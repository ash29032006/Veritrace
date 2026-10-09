import { requireUser } from "@/lib/auth/guard";
import { getOutlet, getShipment, insertShipment, insertShipmentLines, listShipments } from "@/lib/data/shipments";
import { withTransaction } from "@/lib/db/postgres";
import * as graph from "@/lib/graph";
import { handle, json, notFound, readJson } from "@/lib/http";
import { newSyncStatus, project } from "@/lib/sync";
import { shipmentCreateSchema } from "@/lib/validation";

/** GET /api/shipments (any): newest first, optionally for one outlet. */
export const GET = handle(async (req) => {
  await requireUser();
  const params = new URL(req.url).searchParams;
  const outletId = Number(params.get("outletId")) || undefined;
  const limit = Math.min(Number(params.get("limit")) || 100, 500);
  return json(await listShipments({ outletId, limit }));
});

/**
 * POST /api/shipments (MANUFACTURER): header plus lines in one transaction.
 * trg_block_unsafe_shipment may refuse a line (recalled, quarantined, or not
 * enough stock); the whole shipment then rolls back and the trigger's
 * message is returned as 409. On success the outlet's inventory has already
 * been booked by trg_inventory_receive, and SHIPPED_TO edges are merged.
 */
export const POST = handle(async (req) => {
  const user = await requireUser("MANUFACTURER");
  const input = shipmentCreateSchema.parse(await readJson(req));
  const outlet = await getOutlet(input.outletId);
  if (!outlet) throw notFound(`Outlet ${input.outletId} does not exist`);

  const header = await withTransaction(user.userId, async (client) => {
    const h = await insertShipment(client, {
      outletId: input.outletId,
      shipmentDate: input.shipmentDate,
      dispatchedBy: user.userId,
    });
    await insertShipmentLines(client, h.shipment_id, input.lines);
    return h;
  });

  const sync = newSyncStatus();
  await project(sync, "graph", `shipment ${header.shipment_id}`, user.userId, () =>
    graph.mergeShipment({
      shipment_id: header.shipment_id,
      outlet,
      shipment_date: header.shipment_date,
      lines: input.lines.map((l) => ({ batch_id: l.batchId, quantity: l.quantity })),
    }),
  );

  return json({ shipment: await getShipment(header.shipment_id), sync }, 201);
});
