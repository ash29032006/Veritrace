// VERITRACE: Neo4j schema. Applied by `npm run graph:setup`; safe to rerun.
//
// Uniqueness constraints also create the backing range indexes, which is
// what lets every traversal start with an index seek on batch_id.

CREATE CONSTRAINT batch_id_unique IF NOT EXISTS
  FOR (b:Batch) REQUIRE b.batch_id IS UNIQUE;

CREATE CONSTRAINT outlet_id_unique IF NOT EXISTS
  FOR (o:Outlet) REQUIRE o.outlet_id IS UNIQUE;

// Batch codes are looked up by humans in the browser; keep them unique too.
CREATE CONSTRAINT batch_code_unique IF NOT EXISTS
  FOR (b:Batch) REQUIRE b.batch_code IS UNIQUE;

// Cancelling a shipment deletes its SHIPPED_TO edges by shipment_id.
CREATE INDEX shipped_to_shipment IF NOT EXISTS
  FOR ()-[s:SHIPPED_TO]-() ON (s.shipment_id);

// The exposure screen filters affected nodes by status.
CREATE INDEX batch_status IF NOT EXISTS
  FOR (b:Batch) ON (b.status);
