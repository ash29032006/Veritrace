import { pool } from "@/lib/db/postgres";
import type { Report } from "@/lib/types";

/*
 * The requirement 6 query set, runnable from the Reports tab. These mirror
 * db/postgres/03_queries.sql (which uses psql variables instead of $n), so
 * an examiner can read a query in the file and watch the same SQL run here.
 */

interface ReportDef {
  id: string;
  title: string;
  summary: string;
  features: string[];
  sql: string;
  params?: (input: Record<string, string>) => unknown[];
}

export const REPORTS: ReportDef[] = [
  {
    id: "exposure-by-outlet",
    title: "1 · Exposure by outlet",
    summary: "Units of every batch in each open recall's scope that each outlet received.",
    features: ["JOIN", "GROUP BY", "SUM", "COUNT DISTINCT", "ORDER BY"],
    sql: `SELECT r.recall_id,
       src.batch_code              AS recalled_batch,
       o.outlet_name,
       o.city,
       COUNT(DISTINCT sl.batch_id) AS affected_batches,
       SUM(sl.quantity)            AS units_received
  FROM recall        r
  JOIN batch         src ON src.batch_id  = r.batch_id
  JOIN recall_batch  rb  ON rb.recall_id  = r.recall_id
  JOIN shipment_line sl  ON sl.batch_id   = rb.batch_id
  JOIN shipment      s   ON s.shipment_id = sl.shipment_id
  JOIN outlet        o   ON o.outlet_id   = s.outlet_id
 WHERE r.recall_status = 'OPEN'
 GROUP BY r.recall_id, src.batch_code, o.outlet_name, o.city
 ORDER BY units_received DESC, o.outlet_name`,
  },
  {
    id: "heavily-affected",
    title: "2 · Heavily affected outlets",
    summary: "Outlets still holding more than a threshold of quarantined units. Visit these first.",
    features: ["JOIN", "GROUP BY", "HAVING", "SUM", "ORDER BY"],
    sql: `SELECT o.outlet_name,
       o.city,
       COUNT(*)                AS quarantined_lines,
       SUM(i.quantity_on_hand) AS units_held
  FROM inventory i
  JOIN outlet    o ON o.outlet_id = i.outlet_id
 WHERE i.stock_status = 'QUARANTINED'
 GROUP BY o.outlet_id, o.outlet_name, o.city
HAVING SUM(i.quantity_on_hand) > $1
 ORDER BY units_held DESC`,
    params: (input) => [Number(input.threshold ?? 100) || 0],
  },
  {
    id: "never-shipped",
    title: "3 · Stock never shipped",
    summary: "Batches neither consumed by another batch nor shipped anywhere: sitting in the warehouse.",
    features: ["NOT EXISTS", "subquery", "date arithmetic"],
    sql: `SELECT b.batch_code,
       b.product_name,
       b.manufacture_date,
       b.quantity_produced,
       CURRENT_DATE - b.manufacture_date AS days_in_warehouse
  FROM batch b
 WHERE NOT EXISTS (SELECT 1 FROM shipment_line sl
                    WHERE sl.batch_id = b.batch_id)
   AND NOT EXISTS (SELECT 1 FROM batch_composition bc
                    WHERE bc.parent_batch_id = b.batch_id)
 ORDER BY days_in_warehouse DESC`,
  },
  {
    id: "avg-shipment-city",
    title: "4 · Average shipment size per city",
    summary: "A shipment's size is the sum of its lines, so this averages an aggregate via a derived table.",
    features: ["derived table", "JOIN", "GROUP BY", "AVG", "MAX", "COUNT"],
    sql: `SELECT o.city,
       COUNT(*)                AS shipments,
       ROUND(AVG(sz.units), 1) AS avg_units_per_shipment,
       MAX(sz.units)           AS largest_shipment
  FROM (SELECT sl.shipment_id, SUM(sl.quantity) AS units
          FROM shipment_line sl
         GROUP BY sl.shipment_id) sz
  JOIN shipment s ON s.shipment_id = sz.shipment_id
  JOIN outlet   o ON o.outlet_id   = s.outlet_id
 GROUP BY o.city
 ORDER BY avg_units_per_shipment DESC`,
  },
  {
    id: "latest-recall-per-batch",
    title: "5 · Most recent recall per batch",
    summary: "For every recalled batch, the newest recall whose scope includes it.",
    features: ["correlated subquery", "MAX", "JOIN"],
    sql: `SELECT b.batch_code,
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
 ORDER BY r.initiated_at DESC, rb.hop_depth, b.batch_code`,
  },
  {
    id: "deepest-lineage",
    title: "6 · Deepest lineage",
    summary: "How many transformation steps separate each batch from its furthest raw material.",
    features: ["WITH RECURSIVE", "MAX", "COUNT DISTINCT", "RANK() OVER"],
    sql: `WITH RECURSIVE chain (batch_id, ancestor_id, depth) AS (
    SELECT bc.child_batch_id, bc.parent_batch_id, 1
      FROM batch_composition bc
    UNION ALL
    SELECT c.batch_id, bc.parent_batch_id, c.depth + 1
      FROM chain c
      JOIN batch_composition bc ON bc.child_batch_id = c.ancestor_id
)
SELECT b.batch_code,
       b.product_name,
       MAX(c.depth)                             AS lineage_depth,
       COUNT(DISTINCT c.ancestor_id)            AS total_inputs,
       RANK() OVER (ORDER BY MAX(c.depth) DESC) AS depth_rank
  FROM chain c
  JOIN batch b ON b.batch_id = c.batch_id
 GROUP BY b.batch_id, b.batch_code, b.product_name
 ORDER BY lineage_depth DESC, total_inputs DESC, b.batch_code
 LIMIT 10`,
  },
  {
    id: "complaints-per-outlet",
    title: "7 · Complaints per outlet",
    summary: "LEFT JOIN keeps every outlet; COUNT on a nullable column separates matched from unmatched.",
    features: ["LEFT JOIN", "COUNT", "IS NULL logic", "HAVING", "AVG"],
    sql: `SELECT o.outlet_name,
       o.city,
       COUNT(c.complaint_id)                             AS complaints,
       COUNT(c.matched_batch_id)                         AS matched,
       COUNT(c.complaint_id) - COUNT(c.matched_batch_id) AS unmatched,
       ROUND(AVG(c.similarity_score), 3)                 AS avg_similarity
  FROM outlet o
  LEFT JOIN complaint c ON c.outlet_id = o.outlet_id
 GROUP BY o.outlet_id, o.outlet_name, o.city
HAVING COUNT(c.complaint_id) > 0
 ORDER BY complaints DESC, o.outlet_name`,
  },
  {
    id: "never-exposed",
    title: "8 · Outlets never exposed",
    summary: "Outlets that never received any batch inside any recall's scope. No contact needed.",
    features: ["NOT EXISTS", "multi-table subquery"],
    sql: `SELECT o.outlet_name, o.city
  FROM outlet o
 WHERE NOT EXISTS (
        SELECT 1
          FROM shipment      s
          JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
          JOIN recall_batch  rb ON rb.batch_id    = sl.batch_id
         WHERE s.outlet_id = o.outlet_id)
 ORDER BY o.city, o.outlet_name`,
  },
  {
    id: "city-share",
    title: "9 · Outlet share of city volume",
    summary: "Each outlet's rank and percentage of all units shipped into its city.",
    features: ["window functions", "RANK() OVER PARTITION BY", "SUM() OVER"],
    sql: `SELECT o.city,
       o.outlet_name,
       SUM(sl.quantity) AS units,
       RANK() OVER (PARTITION BY o.city ORDER BY SUM(sl.quantity) DESC) AS rank_in_city,
       ROUND(100.0 * SUM(sl.quantity)
             / SUM(SUM(sl.quantity)) OVER (PARTITION BY o.city), 1)     AS pct_of_city
  FROM outlet o
  JOIN shipment      s  ON s.outlet_id    = o.outlet_id
  JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
 GROUP BY o.city, o.outlet_id, o.outlet_name
 ORDER BY o.city, rank_in_city`,
  },
];

export async function runReport(id: string, input: Record<string, string>): Promise<Report | undefined> {
  const def = REPORTS.find((r) => r.id === id);
  if (!def) return undefined;
  const started = performance.now();
  const result = await pool().query({ text: def.sql, values: def.params?.(input) ?? [] });
  return {
    id: def.id,
    title: def.title,
    summary: def.summary,
    features: def.features,
    sql: def.sql,
    columns: result.fields.map((f) => f.name),
    rows: result.rows,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
}
