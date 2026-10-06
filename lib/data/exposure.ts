import { query } from "@/lib/db/postgres";
import type { OutletExposure } from "@/lib/types";

/*
 * The SQL side of exposure: the summary view, and the recursive CTE that is
 * run next to the Cypher query on the comparison screen.
 */

export function exposureSummary(): Promise<OutletExposure[]> {
  return query<OutletExposure>(
    `SELECT * FROM v_outlet_exposure ORDER BY recall_id DESC, units_quarantined DESC, outlet_name`,
  );
}

/** Same question as graph EXPOSURE_COMPARE, same output keys. */
export const EXPOSURE_CTE = `WITH RECURSIVE downstream (batch_id) AS (
    SELECT b.batch_id
      FROM batch b
     WHERE b.batch_id = $1

    UNION

    SELECT bc.child_batch_id
      FROM batch_composition bc
      JOIN downstream d ON d.batch_id = bc.parent_batch_id
)
SELECT DISTINCT o.outlet_id   AS "outletId",
                d.batch_id    AS "batchId",
                s.shipment_id AS "shipmentId",
                sl.quantity   AS "quantity"
  FROM downstream    d
  JOIN shipment_line sl ON sl.batch_id = d.batch_id
  JOIN shipment      s  ON s.shipment_id = sl.shipment_id
  JOIN outlet        o  ON o.outlet_id = s.outlet_id`;

export function exposureViaCte(batchId: number) {
  return query<{ outletId: number; batchId: number; shipmentId: number; quantity: number }>(
    EXPOSURE_CTE,
    [batchId],
  );
}

/** Postgres's own view of the downstream set, used to cross-check the graph. */
export function downstreamViaSql(batchId: number) {
  return query<{ batch_id: number; hop_depth: number }>(
    `SELECT batch_id, hop_depth FROM fn_downstream_batches($1) ORDER BY hop_depth, batch_id`,
    [batchId],
  );
}
