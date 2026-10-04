/* =========================================================
   VERITRACE
   File 03 : important queries (requirement 6) and the SQL
             side of the SQL-versus-Cypher comparison

   Read-only. Run in psql after seeding:
       psql "$DATABASE_URL" -f db/postgres/03_queries.sql

   Parameters are psql variables so every query runs as-is.
   The same queries power the Reports tab of the Exposure
   screen (lib/data/reports.ts) with $1-style parameters.
   ========================================================= */

\set source_batch  '''SUG-RAW-001'''
\set threshold     100
\set complaint     '''the tropical juice smelled fermented and fizzy'''

\pset null '(null)'


/* =========================================================
   0. THE COMPARISON  (requirement 18)
   Forward exposure: every outlet that received anything
   containing material from :source_batch, at any depth.

   Neo4j (db/neo4j/queries.cypher) says the same thing in
   three lines:

     MATCH (b:Batch {batch_id: $id})-[:WENT_INTO*0..]->(d:Batch)
           -[s:SHIPPED_TO]->(o:Outlet)
     RETURN DISTINCT o.outlet_id, o.outlet_name, d.batch_code, s.quantity;
   ========================================================= */
\echo '== 0. Forward exposure, recursive CTE =='
WITH RECURSIVE downstream (batch_id, hop_depth) AS (
    /* anchor: the contaminated batch itself (Cypher's *0..) */
    SELECT b.batch_id, 0
      FROM batch b
     WHERE b.batch_code = :source_batch

    UNION ALL

    /* step: whatever each reached batch went into */
    SELECT bc.child_batch_id, d.hop_depth + 1
      FROM batch_composition bc
      JOIN downstream d ON d.batch_id = bc.parent_batch_id
),
reached AS (
    SELECT batch_id, MIN(hop_depth) AS hop_depth
      FROM downstream
     GROUP BY batch_id
)
SELECT o.outlet_id,
       o.outlet_name,
       o.city,
       b.batch_code       AS affected_batch,
       r.hop_depth,
       s.shipment_id,
       sl.quantity
  FROM reached       r
  JOIN shipment_line sl ON sl.batch_id   = r.batch_id
  JOIN shipment      s  ON s.shipment_id = sl.shipment_id
  JOIN outlet        o  ON o.outlet_id   = s.outlet_id
  JOIN batch         b  ON b.batch_id    = r.batch_id
 ORDER BY o.outlet_name, r.hop_depth, b.batch_code;


\echo '== 0b. Backward provenance, recursive CTE =='
/* every input that went into a finished batch, at any depth */
WITH RECURSIVE upstream (batch_id, hop_depth) AS (
    SELECT bc.parent_batch_id, 1
      FROM batch_composition bc
      JOIN batch b ON b.batch_id = bc.child_batch_id
     WHERE b.batch_code = 'CCB-FIN-001'
    UNION ALL
    SELECT bc.parent_batch_id, u.hop_depth + 1
      FROM batch_composition bc
      JOIN upstream u ON u.batch_id = bc.child_batch_id
)
SELECT b.batch_code, b.product_name, MIN(u.hop_depth) AS hops_up
  FROM upstream u
  JOIN batch b ON b.batch_id = u.batch_id
 GROUP BY b.batch_code, b.product_name
 ORDER BY hops_up, b.batch_code;


/* =========================================================
   1. EXPOSURE BY OUTLET
   Total units of every batch in each open recall's scope that
   each outlet received.
   JOIN, GROUP BY, SUM, COUNT, ORDER BY
   ========================================================= */
\echo '== 1. Exposure by outlet =='
SELECT r.recall_id,
       src.batch_code                  AS recalled_batch,
       o.outlet_name,
       o.city,
       COUNT(DISTINCT sl.batch_id)     AS affected_batches,
       SUM(sl.quantity)                AS units_received
  FROM recall        r
  JOIN batch         src ON src.batch_id   = r.batch_id
  JOIN recall_batch  rb  ON rb.recall_id   = r.recall_id
  JOIN shipment_line sl  ON sl.batch_id    = rb.batch_id
  JOIN shipment      s   ON s.shipment_id  = sl.shipment_id
  JOIN outlet        o   ON o.outlet_id    = s.outlet_id
 WHERE r.recall_status = 'OPEN'
 GROUP BY r.recall_id, src.batch_code, o.outlet_name, o.city
 ORDER BY units_received DESC, o.outlet_name;


/* =========================================================
   2. HEAVILY AFFECTED OUTLETS
   Same, keeping only outlets that still hold more than
   :threshold quarantined units. These are the ones a field
   team should visit first.
   JOIN, GROUP BY, HAVING, SUM, ORDER BY
   ========================================================= */
\echo '== 2. Heavily affected outlets (HAVING) =='
SELECT o.outlet_name,
       o.city,
       COUNT(*)                  AS quarantined_lines,
       SUM(i.quantity_on_hand)   AS units_held
  FROM inventory i
  JOIN outlet    o ON o.outlet_id = i.outlet_id
 WHERE i.stock_status = 'QUARANTINED'
 GROUP BY o.outlet_id, o.outlet_name, o.city
HAVING SUM(i.quantity_on_hand) > :threshold
 ORDER BY units_held DESC;


/* =========================================================
   3. FINISHED STOCK NEVER SHIPPED
   Batches that were neither consumed by another batch nor
   shipped anywhere: stock sitting in the warehouse.
   NOT EXISTS subqueries
   ========================================================= */
\echo '== 3. Batches never shipped and never consumed (NOT EXISTS) =='
SELECT b.batch_code,
       b.product_name,
       b.manufacture_date,
       b.quantity_produced,
       CURRENT_DATE - b.manufacture_date AS days_in_warehouse
  FROM batch b
 WHERE NOT EXISTS (SELECT 1 FROM shipment_line sl
                    WHERE sl.batch_id = b.batch_id)
   AND NOT EXISTS (SELECT 1 FROM batch_composition bc
                    WHERE bc.parent_batch_id = b.batch_id)
 ORDER BY days_in_warehouse DESC;


/* =========================================================
   4. AVERAGE SHIPMENT SIZE PER CITY
   A shipment's size is the sum of its lines, so this is an
   aggregate over an aggregate: a derived table, then AVG.
   JOIN, derived table, GROUP BY, AVG, COUNT, ROUND
   ========================================================= */
\echo '== 4. Average shipment size per city =='
SELECT o.city,
       COUNT(*)                        AS shipments,
       ROUND(AVG(sz.units), 1)         AS avg_units_per_shipment,
       MAX(sz.units)                   AS largest_shipment
  FROM (SELECT sl.shipment_id, SUM(sl.quantity) AS units
          FROM shipment_line sl
         GROUP BY sl.shipment_id) sz
  JOIN shipment s ON s.shipment_id = sz.shipment_id
  JOIN outlet   o ON o.outlet_id   = s.outlet_id
 GROUP BY o.city
 ORDER BY avg_units_per_shipment DESC;


/* =========================================================
   5. MOST RECENT RECALL TOUCHING EACH BATCH
   Correlated subquery: for every recalled batch, the newest
   recall whose scope includes it.
   ========================================================= */
\echo '== 5. Most recent recall per batch (correlated subquery) =='
SELECT b.batch_code,
       b.status,
       rb.recall_id,
       rb.hop_depth,
       r.initiated_at,
       r.recall_status
  FROM batch b
  JOIN recall_batch rb ON rb.batch_id = b.batch_id
  JOIN recall       r  ON r.recall_id = rb.recall_id
 WHERE r.initiated_at = (SELECT MAX(r2.initiated_at)
                           FROM recall_batch rb2
                           JOIN recall r2 ON r2.recall_id = rb2.recall_id
                          WHERE rb2.batch_id = b.batch_id)
 ORDER BY r.initiated_at DESC, rb.hop_depth, b.batch_code;


/* =========================================================
   6. BATCHES WITH THE DEEPEST LINEAGE
   How many transformation steps separate each batch from its
   furthest raw material. Recursive CTE plus MAX, then RANK.
   ========================================================= */
\echo '== 6. Deepest lineage (recursive CTE + aggregate + window) =='
WITH RECURSIVE chain (batch_id, ancestor_id, depth) AS (
    SELECT bc.child_batch_id, bc.parent_batch_id, 1
      FROM batch_composition bc
    UNION ALL
    SELECT c.batch_id, bc.parent_batch_id, c.depth + 1
      FROM chain c
      JOIN batch_composition bc ON bc.child_batch_id = c.ancestor_id
)
SELECT b.batch_code,
       b.product_name,
       MAX(c.depth)                         AS lineage_depth,
       COUNT(DISTINCT c.ancestor_id)        AS total_inputs,
       RANK() OVER (ORDER BY MAX(c.depth) DESC) AS depth_rank
  FROM chain c
  JOIN batch b ON b.batch_id = c.batch_id
 GROUP BY b.batch_id, b.batch_code, b.product_name
 ORDER BY lineage_depth DESC, total_inputs DESC, b.batch_code
 LIMIT 10;


/* =========================================================
   7. COMPLAINTS PER OUTLET, AND HOW MANY ARE UNMATCHED
   LEFT JOIN keeps outlets with no complaints; COUNT on a
   nullable column and IS NULL separate matched from not.
   ========================================================= */
\echo '== 7. Complaints per outlet, matched vs unmatched (LEFT JOIN + IS NULL) =='
SELECT o.outlet_name,
       o.city,
       COUNT(c.complaint_id)                               AS complaints,
       COUNT(c.matched_batch_id)                           AS matched,
       COUNT(c.complaint_id) - COUNT(c.matched_batch_id)   AS unmatched,
       ROUND(AVG(c.similarity_score), 3)                   AS avg_similarity
  FROM outlet o
  LEFT JOIN complaint c ON c.outlet_id = o.outlet_id
 GROUP BY o.outlet_id, o.outlet_name, o.city
HAVING COUNT(c.complaint_id) > 0
 ORDER BY complaints DESC, o.outlet_name;

\echo '-- complaints with no matched batch at all'
SELECT c.complaint_id, LEFT(c.complaint_text, 60) AS complaint, c.received_at
  FROM complaint c
 WHERE c.matched_batch_id IS NULL
 ORDER BY c.received_at DESC;


/* =========================================================
   8. OUTLETS NEVER EXPOSED TO A RECALLED BATCH
   NOT EXISTS against the exposure set of every recall ever
   initiated. These outlets need no contact at all.
   ========================================================= */
\echo '== 8. Outlets never exposed to any recall (NOT EXISTS) =='
SELECT o.outlet_name, o.city
  FROM outlet o
 WHERE NOT EXISTS (
        SELECT 1
          FROM shipment      s
          JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
          JOIN recall_batch  rb ON rb.batch_id    = sl.batch_id
         WHERE s.outlet_id = o.outlet_id)
 ORDER BY o.city, o.outlet_name;


/* =========================================================
   9. KEYWORD BASELINE  (why the vector search exists)
   Full text search of a complaint against batch descriptions.
   Any shared stem is enough to match (terms are OR-ed), and
   paraphrased complaints still find nothing. Compare with the
   Qdrant result on the Complaints screen.
   ========================================================= */
\echo '== 9. Keyword baseline: full text search (usually empty) =='
WITH q AS (
    SELECT to_tsquery('english',
             COALESCE(NULLIF(array_to_string(tsvector_to_array(to_tsvector('english', :complaint)), ' | '), ''),
                      'nothing')) AS query
)
SELECT b.batch_code,
       b.product_name,
       ts_rank(to_tsvector('english', b.product_name || ' ' || COALESCE(b.description, '')), q.query) AS rank
  FROM batch b, q
 WHERE to_tsvector('english', b.product_name || ' ' || COALESCE(b.description, '')) @@ q.query
 ORDER BY rank DESC
 LIMIT 5;


/* =========================================================
   10. WINDOW FUNCTION: each outlet's share of its city
   ========================================================= */
\echo '== 10. Outlet share of city volume (window functions) =='
SELECT o.city,
       o.outlet_name,
       SUM(sl.quantity)                                              AS units,
       RANK() OVER (PARTITION BY o.city ORDER BY SUM(sl.quantity) DESC) AS rank_in_city,
       ROUND(100.0 * SUM(sl.quantity)
             / SUM(SUM(sl.quantity)) OVER (PARTITION BY o.city), 1)     AS pct_of_city
  FROM outlet o
  JOIN shipment      s  ON s.outlet_id    = o.outlet_id
  JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
 GROUP BY o.city, o.outlet_id, o.outlet_name
 ORDER BY o.city, rank_in_city;


/* =========================================================
   11. THE VIEWS
   ========================================================= */
\echo '== 11a. v_outlet_exposure =='
SELECT * FROM v_outlet_exposure ORDER BY recall_id, units_quarantined DESC;

\echo '== 11b. v_batch_stock, finished goods with stock left =='
SELECT batch_code, product_name, status, quantity_produced,
       quantity_shipped, quantity_available
  FROM v_batch_stock
 WHERE output_count = 0
 ORDER BY quantity_available DESC
 LIMIT 10;
