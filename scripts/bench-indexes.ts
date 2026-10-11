/*
 * npm run bench:indexes
 *
 * Evidence for the indexing requirement. On the 66-batch demo data every
 * table fits in a page or two and PostgreSQL rightly ignores indexes, so
 * this builds a large dataset in a SEPARATE database (BENCH_DATABASE_URL):
 *
 *   20,000 batches in 5 lineage layers, ~32,000 composition links,
 *   2,000 outlets, 50,000 shipments, ~205,000 shipment lines,
 *   ~204,000 inventory rows, 100,000 audit rows
 *
 * then runs EXPLAIN (ANALYZE, BUFFERS) on five hot-path queries BEFORE
 * 04_indexes.sql exists, creates the indexes, runs them again, and writes
 * docs/indexing-evidence.md with both plans and the timings.
 *
 * Bulk loading uses session_replication_role = replica to skip triggers and
 * FK checks (a superuser-only switch). That is acceptable for a throwaway
 * benchmark database and is never done in the real one.
 */
import "./_env";
import { writeFileSync } from "node:fs";
import pg from "pg";
import { applySqlFiles } from "./db-apply";

const url = process.env.BENCH_DATABASE_URL;
if (!url) throw new Error("Set BENCH_DATABASE_URL in .env.local (a separate, empty database)");
if (url === process.env.DATABASE_URL) throw new Error("BENCH_DATABASE_URL must not be the main database");

const RUNS = 7;

interface Probe {
  id: string;
  title: string;
  index: string;
  sql: string;
}

async function main() {
  console.log("1/5 schema (no secondary indexes)");
  await applySqlFiles(url!, ["01_schema.sql", "02_functions.sql"]);

  const db = new pg.Client({ connectionString: url });
  await db.connect();
  db.on("notice", () => undefined);

  console.log("2/5 bulk data");
  const t0 = performance.now();
  await db.query(`SET session_replication_role = replica`);
  await db.query(`SELECT setseed(0.42)`);
  await db.query(`
    INSERT INTO app_user (username, password_hash, role)
    VALUES ('bench', '$2b$10$abcdefghijklmnopqrstuvabcdefghijklmnopqrstuvwxyz12345', 'MANUFACTURER')`);
  // 5 layers x 4000 batches; batch n belongs to layer (n-1)/4000
  await db.query(`
    INSERT INTO batch (batch_code, product_name, description, manufacture_date, quantity_produced)
    SELECT 'B-' || lpad(n::text, 6, '0'),
           'Product ' || ((n - 1) / 4000),
           'Bench batch in layer ' || ((n - 1) / 4000),
           DATE '2026-01-01' + ((n - 1) / 4000) * 20,
           100000
      FROM generate_series(1, 20000) AS n`);
  // each batch in layers 1..4 has two random parents in the layer above
  await db.query(`
    INSERT INTO batch_composition (parent_batch_id, child_batch_id, quantity_used)
    SELECT DISTINCT ON (p, c) p, c, 10
      FROM (SELECT c, ((c - 1) / 4000 - 1) * 4000 + 1 + floor(random() * 4000)::int AS p
              FROM generate_series(4001, 20000) AS c, generate_series(1, 2)) x`);
  await db.query(`
    INSERT INTO outlet (outlet_name, city)
    SELECT 'Outlet ' || n, 'City ' || (n % 40) FROM generate_series(1, 2000) AS n`);
  await db.query(`
    INSERT INTO shipment (outlet_id, shipment_date, dispatched_by)
    SELECT 1 + floor(random() * 2000)::int, DATE '2026-03-01' + floor(random() * 200)::int, 1
      FROM generate_series(1, 50000)`);
  await db.query(`
    INSERT INTO shipment_line (shipment_id, batch_id, quantity)
    SELECT DISTINCT ON (s, b) s, b, 5
      FROM (SELECT 1 + floor(random() * 50000)::int AS s, 1 + floor(random() * 20000)::int AS b
              FROM generate_series(1, 205000)) x`);
  await db.query(`
    INSERT INTO inventory (outlet_id, batch_id, quantity_on_hand)
    SELECT s.outlet_id, sl.batch_id, SUM(sl.quantity)
      FROM shipment_line sl JOIN shipment s USING (shipment_id)
     GROUP BY s.outlet_id, sl.batch_id`);
  await db.query(`
    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, performed_at, details)
    SELECT (ARRAY['BATCH_CREATED','SHIPMENT_CREATED','USER_LOGIN','COMPOSITION_RECORDED'])[1 + n % 4],
           'batch', n, 1, now() - (n || ' minutes')::interval, 'bench row ' || n
      FROM generate_series(1, 100000) AS n`);
  await db.query(`SET session_replication_role = origin`);
  await db.query(`VACUUM ANALYZE`);

  const sizes = (
    await db.query<{ t: string; n: number }>(`
      SELECT 'batch' t, COUNT(*)::int n FROM batch UNION ALL
      SELECT 'batch_composition', COUNT(*)::int FROM batch_composition UNION ALL
      SELECT 'outlet', COUNT(*)::int FROM outlet UNION ALL
      SELECT 'shipment', COUNT(*)::int FROM shipment UNION ALL
      SELECT 'shipment_line', COUNT(*)::int FROM shipment_line UNION ALL
      SELECT 'inventory', COUNT(*)::int FROM inventory UNION ALL
      SELECT 'audit_log', COUNT(*)::int FROM audit_log`)
  ).rows;
  console.log(`   loaded in ${Math.round((performance.now() - t0) / 1000)} s`);

  // a first-layer batch: its exposure reaches four layers down
  const source = 37;
  const leaf = 19_993;
  const someOutlet = 1_234;

  const probes: Probe[] = [
    {
      id: "exposure",
      title: "Forward exposure (recursive CTE), the query behind every recall",
      index: "idx_shipment_line_batch",
      sql: `WITH RECURSIVE downstream (batch_id) AS (
    SELECT ${source}::bigint
    UNION
    SELECT bc.child_batch_id FROM batch_composition bc
      JOIN downstream d ON d.batch_id = bc.parent_batch_id
)
SELECT DISTINCT o.outlet_id, d.batch_id, s.shipment_id, sl.quantity
  FROM downstream d
  JOIN shipment_line sl ON sl.batch_id = d.batch_id
  JOIN shipment s ON s.shipment_id = sl.shipment_id
  JOIN outlet o ON o.outlet_id = s.outlet_id`,
    },
    {
      id: "provenance",
      title: "Backward provenance (recursive CTE)",
      index: "idx_bc_child",
      sql: `WITH RECURSIVE upstream (batch_id) AS (
    SELECT parent_batch_id FROM batch_composition WHERE child_batch_id = ${leaf}
    UNION
    SELECT bc.parent_batch_id FROM batch_composition bc
      JOIN upstream u ON u.batch_id = bc.child_batch_id
)
SELECT COUNT(*) FROM upstream`,
    },
    {
      id: "quarantine",
      title: "Recall quarantine lookup: every outlet holding the affected batches",
      index: "idx_inventory_batch",
      sql: `SELECT outlet_id, batch_id, quantity_on_hand
  FROM inventory
 WHERE batch_id = ANY (ARRAY[${source}, 4100, 8200, 12300, 16400]::bigint[])
   AND quantity_on_hand > 0`,
    },
    {
      id: "outlet-history",
      title: "Latest shipments to one outlet",
      index: "idx_shipment_outlet",
      sql: `SELECT shipment_id, shipment_date
  FROM shipment
 WHERE outlet_id = ${someOutlet}
 ORDER BY shipment_date DESC
 LIMIT 20`,
    },
    {
      id: "audit-page",
      title: "Audit log, newest page filtered by action",
      index: "idx_audit_performed_at (newest first, filter applied while walking it)",
      sql: `SELECT log_id, action, performed_at
  FROM audit_log
 WHERE action = 'USER_LOGIN'
 ORDER BY performed_at DESC
 LIMIT 25`,
    },
  ];

  async function measure(sql: string) {
    const plans: string[] = [];
    const times: number[] = [];
    for (let i = 0; i < RUNS; i++) {
      const res = await db.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`);
      const text = res.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
      plans.push(text);
      times.push(Number(/Execution Time: ([\d.]+) ms/.exec(text)?.[1] ?? NaN));
    }
    const sorted = [...times].sort((a, b) => a - b);
    return { plan: plans.at(-1)!, median: sorted[Math.floor(sorted.length / 2)]! };
  }

  console.log("3/5 EXPLAIN ANALYZE before indexes");
  const before: Record<string, { plan: string; median: number }> = {};
  for (const p of probes) before[p.id] = await measure(p.sql);

  console.log("4/5 create indexes (04_indexes.sql)");
  await db.end();
  await applySqlFiles(url!, ["04_indexes.sql"]);
  const db2 = new pg.Client({ connectionString: url });
  await db2.connect();
  Object.assign(db, { query: db2.query.bind(db2) });

  console.log("5/5 EXPLAIN ANALYZE after indexes");
  const after: Record<string, { plan: string; median: number }> = {};
  for (const p of probes) after[p.id] = await measure(p.sql);
  const pgVersion = (await db2.query<{ v: string }>(`SHOW server_version`)).rows[0]!.v;
  await db2.end();

  const scanKind = (plan: string) =>
    plan.includes("Seq Scan") && !/Index (Only )?Scan|Bitmap Index Scan/.test(plan)
      ? "sequential scans only"
      : [...new Set(plan.match(/(Index Only Scan|Index Scan|Bitmap Index Scan|Seq Scan)( using \w+)?/g) ?? [])]
          .slice(0, 3)
          .join(", ");

  const lines: string[] = [];
  lines.push(
    "# Indexing evidence",
    "",
    "Generated by `npm run bench:indexes` on " + new Date().toISOString().slice(0, 10) + ", PostgreSQL " + pgVersion + ".",
    "",
    "The demo dataset (66 batches) is far too small for indexes to matter: every table fits in a page",
    "or two and the planner correctly prefers sequential scans. The benchmark therefore builds a separate",
    "database with the same schema at a realistic size, measures five hot-path queries with",
    "`EXPLAIN (ANALYZE, BUFFERS)` **before** `04_indexes.sql` exists, creates the indexes, and measures again.",
    `Each query runs ${RUNS} times; the table shows the median execution time.`,
    "",
    "## Dataset",
    "",
    "| table | rows |",
    "|---|---:|",
    ...sizes.map((s) => `| ${s.t} | ${s.n.toLocaleString("en-IN")} |`),
    "",
    "## Results",
    "",
    "| query | index that serves it | before (ms) | after (ms) | speed-up | plan after |",
    "|---|---|---:|---:|---:|---|",
    ...probes.map((p) => {
      const b = before[p.id]!.median;
      const a = after[p.id]!.median;
      return `| ${p.title} | \`${p.index}\` | ${b.toFixed(2)} | ${a.toFixed(2)} | ${(b / a).toFixed(1)}x | ${scanKind(after[p.id]!.plan)} |`;
    }),
    "",
    "Primary keys already index their leading column, so the forward step of the recursive CTE",
    "(`batch_composition.parent_batch_id`) was fast even before; the new indexes cover the lookups",
    "the primary keys cannot: by `batch_id` on `shipment_line` and `inventory`, by `child_batch_id`",
    "for provenance, by outlet for history, and by action and time for the audit log.",
    "",
  );
  for (const p of probes) {
    lines.push(
      `## ${p.title}`,
      "",
      "```sql",
      p.sql,
      "```",
      "",
      `### Before (median ${before[p.id]!.median.toFixed(2)} ms)`,
      "",
      "```",
      before[p.id]!.plan,
      "```",
      "",
      `### After (median ${after[p.id]!.median.toFixed(2)} ms)`,
      "",
      "```",
      after[p.id]!.plan,
      "```",
      "",
    );
  }
  writeFileSync("docs/indexing-evidence.md", lines.join("\n"));
  console.table(
    Object.fromEntries(
      probes.map((p) => [
        p.id,
        { before_ms: before[p.id]!.median, after_ms: after[p.id]!.median, plan_after: scanKind(after[p.id]!.plan) },
      ]),
    ),
  );
  console.log("wrote docs/indexing-evidence.md");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
