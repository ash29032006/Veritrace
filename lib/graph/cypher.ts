/*
 * Every Cypher statement the application runs. Kept as named constants so
 * the comparison screen can show exactly what executed, and so
 * db/neo4j/queries.cypher can be checked against them.
 *
 * Direction: (input:Batch)-[:WENT_INTO]->(consumer:Batch), the same way
 * round as batch_composition(parent_batch_id -> child_batch_id).
 */

/* ---------- reads ---------- */

/** The three-line exposure query shown side by side with the recursive CTE. */
export const EXPOSURE_COMPARE = `MATCH (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(d:Batch)
      -[s:SHIPPED_TO]->(o:Outlet)
RETURN DISTINCT o.outlet_id AS outletId, d.batch_id AS batchId,
       s.shipment_id AS shipmentId, s.quantity AS quantity`;

/**
 * Forward exposure with depth. *0.. includes the batch's own direct
 * shipments; *1.. here would silently drop every outlet that received the
 * contaminated batch itself.
 */
export const EXPOSURE_OUTLETS = `MATCH p = (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(d:Batch)
      -[s:SHIPPED_TO]->(o:Outlet)
WITH o, d, s, min(length(p)) - 1 AS hopDepth
RETURN o.outlet_id AS outletId, o.outlet_name AS outletName, o.city AS city,
       d.batch_id AS affectedBatchId, d.batch_code AS affectedBatchCode,
       hopDepth, s.shipment_id AS shipmentId, s.quantity AS quantity
ORDER BY outletName, hopDepth, affectedBatchCode`;

/** Every batch downstream, shipped or not. This is the recall scope. */
export const DOWNSTREAM_BATCHES = `MATCH p = (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(d:Batch)
RETURN d.batch_id AS batchId, d.batch_code AS batchCode,
       d.product_name AS productName, d.status AS status,
       min(length(p)) AS hopDepth
ORDER BY hopDepth, batchCode`;

export const DOWNSTREAM_EDGES = `MATCH (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(x:Batch)
      -[w:WENT_INTO]->(y:Batch)
RETURN DISTINCT x.batch_id AS from, y.batch_id AS to, w.quantity_used AS quantityUsed`;

/** Backward provenance. *1.. because a batch is not its own input. */
export const PROVENANCE_BATCHES = `MATCH p = (src:Batch)-[:WENT_INTO*1..]->(b:Batch {batch_id: $batchId})
RETURN src.batch_id AS batchId, src.batch_code AS batchCode,
       src.product_name AS productName, src.status AS status,
       min(length(p)) AS hopDepth
ORDER BY hopDepth, batchCode`;

export const PROVENANCE_EDGES = `MATCH (x:Batch)-[w:WENT_INTO]->(y:Batch)
      -[:WENT_INTO*0..]->(b:Batch {batch_id: $batchId})
RETURN DISTINCT x.batch_id AS from, y.batch_id AS to, w.quantity_used AS quantityUsed`;

export const BATCH_NODE = `MATCH (b:Batch {batch_id: $batchId})
RETURN b.batch_id AS batchId, b.batch_code AS batchCode,
       b.product_name AS productName, b.status AS status`;

/* ---------- writes (always MERGE, so a retry never duplicates) ---------- */

export const MERGE_BATCH = `MERGE (b:Batch {batch_id: $batchId})
SET b.batch_code = $batchCode, b.product_name = $productName, b.status = $status`;

export const MERGE_COMPOSITION = `MATCH (p:Batch {batch_id: $parentId}), (c:Batch {batch_id: $childId})
MERGE (p)-[w:WENT_INTO]->(c)
SET w.quantity_used = $quantityUsed
RETURN count(w) AS merged`;

export const MERGE_OUTLET = `MERGE (o:Outlet {outlet_id: $outletId})
SET o.outlet_name = $outletName, o.city = $city`;

/** One SHIPPED_TO per shipment line, keyed by shipment_id so repeat shipments stay distinct. */
export const MERGE_SHIPMENT_LINES = `MATCH (o:Outlet {outlet_id: $outletId})
UNWIND $lines AS line
MATCH (b:Batch {batch_id: line.batchId})
MERGE (b)-[s:SHIPPED_TO {shipment_id: $shipmentId}]->(o)
SET s.quantity = line.quantity, s.shipment_date = date($shipmentDate)
RETURN count(s) AS merged`;

export const DELETE_SHIPMENT = `MATCH (:Batch)-[s:SHIPPED_TO {shipment_id: $shipmentId}]->(:Outlet)
DELETE s`;

export const SET_STATUS = `UNWIND $batchIds AS id
MATCH (b:Batch {batch_id: id})
SET b.status = $status
RETURN count(b) AS updated`;
