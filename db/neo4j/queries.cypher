// VERITRACE: the graph queries, for reading and for pasting into Neo4j Browser.
// The application runs exactly these (lib/graph/cypher.ts).
//
// Model
//   (:Batch  {batch_id, batch_code, product_name, status})
//   (:Outlet {outlet_id, outlet_name, city})
//   (:Batch)-[:WENT_INTO  {quantity_used}]->(:Batch)        input -> consumer
//   (:Batch)-[:SHIPPED_TO {shipment_id, quantity, shipment_date}]->(:Outlet)
//
// In Neo4j Browser set a parameter first, e.g.
//   :param batchId => 3

// ------------------------------------------------------------------
// 1. Forward exposure: every outlet that received anything containing
//    this batch, at ANY depth. *0.. includes the batch's own shipments;
//    *1.. would silently drop the outlets that got it directly.
//    (The recursive CTE for the same question is in 03_queries.sql.)
// ------------------------------------------------------------------
MATCH (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(d:Batch)
      -[s:SHIPPED_TO]->(o:Outlet)
RETURN DISTINCT o.outlet_id AS outletId, d.batch_id AS batchId,
       s.shipment_id AS shipmentId, s.quantity AS quantity;

// 1b. The same, with the number of processing steps to each outlet.
MATCH p = (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(d:Batch)
      -[s:SHIPPED_TO]->(o:Outlet)
WITH o, d, s, min(length(p)) - 1 AS hopDepth
RETURN o.outlet_name AS outlet, o.city AS city, d.batch_code AS batch,
       hopDepth, s.quantity AS quantity
ORDER BY hopDepth DESC, outlet;

// ------------------------------------------------------------------
// 2. Recall scope: every batch downstream, shipped or not.
//    This is what the API hands to sp_initiate_recall.
// ------------------------------------------------------------------
MATCH p = (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(d:Batch)
RETURN d.batch_id AS batchId, d.batch_code AS batchCode,
       min(length(p)) AS hopDepth
ORDER BY hopDepth, batchCode;

// ------------------------------------------------------------------
// 3. Backward provenance: every input at any depth. *1.. because a
//    batch is not its own input.
// ------------------------------------------------------------------
MATCH p = (src:Batch)-[:WENT_INTO*1..]->(b:Batch {batch_id: $batchId})
RETURN src.batch_code AS input, src.product_name AS product,
       min(length(p)) AS hopsUp
ORDER BY hopsUp, input;

// ------------------------------------------------------------------
// 4. Filtering on the links themselves, mid traversal: only paths where
//    every step used at least 100 units of the input. This is the kind of
//    per-edge condition that is awkward to express in a recursive CTE.
// ------------------------------------------------------------------
MATCH p = (b:Batch {batch_id: $batchId})-[ws:WENT_INTO*1..]->(d:Batch)
WHERE all(w IN ws WHERE w.quantity_used >= 100)
RETURN d.batch_code AS batch, length(p) AS hops,
       [w IN ws | w.quantity_used] AS quantitiesAlongPath
ORDER BY hops;

// ------------------------------------------------------------------
// 5. The whole picture for Neo4j Browser: a batch, everything downstream,
//    and the outlets. Switch to graph view.
// ------------------------------------------------------------------
MATCH p = (b:Batch {batch_id: $batchId})-[:WENT_INTO*0..]->(:Batch)-[:SHIPPED_TO]->(:Outlet)
RETURN p;

// ------------------------------------------------------------------
// 6. Outlets reached through the most distinct processing chains.
// ------------------------------------------------------------------
MATCH p = (:Batch)-[:WENT_INTO*1..]->(:Batch)-[:SHIPPED_TO]->(o:Outlet)
RETURN o.outlet_name AS outlet, count(p) AS chains, max(length(p)) - 1 AS deepest
ORDER BY chains DESC
LIMIT 10;
