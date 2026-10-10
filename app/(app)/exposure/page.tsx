"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { BatchSelect, useBatchOptions } from "@/components/BatchLines";
import { Icon } from "@/components/Icon";
import { LineageGraph } from "@/components/LineageGraph";
import { CodeBlock, Empty, ErrorBanner, Loading, Segmented, StatusPill } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import { fmtNum, plural } from "@/lib/format";
import type { ComparisonReport, ExposureReport, OutletExposure, ProvenanceReport, Recall, Report } from "@/lib/types";

type Tab = "overview" | "trace" | "compare" | "reports";

export default function ExposurePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Exposure />
    </Suspense>
  );
}

function Exposure() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const tab = (params.get("tab") as Tab) || "overview";
  const batch = Number(params.get("batch")) || "";

  const go = (next: { tab?: Tab; batch?: number | "" }) => {
    const qs = new URLSearchParams(params);
    if (next.tab) qs.set("tab", next.tab);
    if (next.batch !== undefined) {
      if (next.batch) qs.set("batch", String(next.batch));
      else qs.delete("batch");
    }
    router.replace(`${pathname}?${qs}`, { scroll: false });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Exposure report</h1>
          <p>Who is affected, how deep the contamination reaches, and the evidence for using a graph database to find out.</p>
        </div>
        <Segmented<Tab>
          label="View"
          value={tab}
          onChange={(t) => go({ tab: t })}
          options={[
            { value: "overview", label: "Overview" },
            { value: "trace", label: "Trace a batch" },
            { value: "compare", label: "SQL vs Cypher" },
            { value: "reports", label: "Reports" },
          ]}
        />
      </div>
      {tab === "overview" && <Overview />}
      {tab === "trace" && <Trace batch={batch} onBatch={(b) => go({ batch: b })} />}
      {tab === "compare" && <Compare batch={batch} onBatch={(b) => go({ batch: b })} />}
      {tab === "reports" && <Reports />}
    </>
  );
}

/* ---------- overview: the v_outlet_exposure view ---------- */

function Overview() {
  const summary = useApi<OutletExposure[]>("/api/exposure-summary");
  const open = useApi<Recall[]>("/api/recalls?status=OPEN");
  const [tip, setTip] = useState<number | null>(null);

  if (summary.error) return <ErrorBanner error={summary.error} />;
  if (!summary.data || !open.data) return <Loading />;

  const rows = summary.data;
  const byOutlet = new Map<number, { name: string; city: string; held: number; shipped: number; minHop: number; maxHop: number; recalls: Set<number> }>();
  for (const r of rows) {
    const cur = byOutlet.get(r.outlet_id) ?? {
      name: r.outlet_name,
      city: r.city,
      held: 0,
      shipped: 0,
      minHop: r.min_hop_depth,
      maxHop: r.max_hop_depth,
      recalls: new Set<number>(),
    };
    cur.held += r.units_quarantined;
    cur.shipped += r.units_shipped;
    cur.minHop = Math.min(cur.minHop, r.min_hop_depth);
    cur.maxHop = Math.max(cur.maxHop, r.max_hop_depth);
    cur.recalls.add(r.recall_id);
    byOutlet.set(r.outlet_id, cur);
  }
  const outlets = [...byOutlet.entries()].sort(([, a], [, b]) => b.held - a.held);
  const maxHeld = Math.max(1, ...outlets.map(([, o]) => o.held));
  const held = outlets.reduce((s, [, o]) => s + o.held, 0);
  const deepest = Math.max(0, ...rows.map((r) => r.max_hop_depth));

  return (
    <div className="stack">
      <div className="stats">
        <div className="card stat">
          <div className="label">Open recalls</div>
          <div className="value">{open.data.length}</div>
          <div className="sub">{plural(open.data.reduce((s, r) => s + r.batches_in_scope, 0), "batch", "batches")} in scope</div>
        </div>
        <div className="card stat">
          <div className="label">Outlets exposed</div>
          <div className="value">{outlets.length}</div>
          <div className="sub">received an affected batch</div>
        </div>
        <div className="card stat">
          <div className="label">Units quarantined</div>
          <div className="value">{fmtNum(held)}</div>
          <div className="sub">held back from sale right now</div>
        </div>
        <div className="card stat">
          <div className="label">Deepest exposure</div>
          <div className="value">{deepest}</div>
          <div className="sub">processing steps from a recalled lot</div>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="card">
          <Empty title="No open recalls">Nothing is quarantined. Initiate a recall to see exposure here.</Empty>
        </div>
      ) : (
        <div className="grid two">
          <div className="card">
            <div className="card-head">
              <div>
                <h2>Units quarantined per outlet</h2>
                <div className="sub">Open recalls only. Hover a bar for detail.</div>
              </div>
            </div>
            <div className="card-body">
              <div className="bars" onMouseLeave={() => setTip(null)}>
                {outlets.slice(0, 14).map(([id, o]) => (
                  <div className="bar-row" key={id} onMouseEnter={() => setTip(id)}>
                    <div className="ellipsis">
                      {o.name}
                      <span className="faint"> · {o.city}</span>
                    </div>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${(o.held / maxHeld) * 100}%` }} />
                    </div>
                    <div className="num right">{fmtNum(o.held)}</div>
                    {tip === id && (
                      <div className="bar-tip">
                        <b>{o.name}</b>
                        <br />
                        {fmtNum(o.held)} quarantined of {fmtNum(o.shipped)} received
                        <br />
                        {o.minHop === o.maxHop ? `${o.minHop} hops` : `${o.minHop}–${o.maxHop} hops`} from the recalled lot ·{" "}
                        {plural(o.recalls.size, "recall")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <div>
                <h2>v_outlet_exposure</h2>
                <div className="sub">The view, row for row: per open recall, per outlet.</div>
              </div>
            </div>
            <div className="card-body flush table-wrap" style={{ maxHeight: 460, overflowY: "auto" }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Recall</th>
                    <th>Outlet</th>
                    <th className="right">Batches</th>
                    <th>Hops</th>
                    <th className="right">Shipped</th>
                    <th className="right">Held</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.recall_id}-${r.outlet_id}`}>
                      <td className="code">
                        #{r.recall_id} {r.source_batch_code}
                      </td>
                      <td>
                        {r.outlet_name}
                        <div className="muted" style={{ fontSize: 12 }}>
                          {r.city}
                        </div>
                      </td>
                      <td className="right num">{r.affected_batches}</td>
                      <td className="nowrap">
                        <span className="hop">{r.min_hop_depth}</span>
                        {r.max_hop_depth !== r.min_hop_depth && (
                          <>
                            {" "}
                            – <span className="hop">{r.max_hop_depth}</span>
                          </>
                        )}
                      </td>
                      <td className="right num">{fmtNum(r.units_shipped)}</td>
                      <td className="right num">{fmtNum(r.units_quarantined)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- trace: forward exposure / backward provenance ---------- */

function Trace({ batch, onBatch }: { batch: number | ""; onBatch: (b: number | "") => void }) {
  const options = useBatchOptions(false);
  const [direction, setDirection] = useState<"forward" | "backward">("forward");
  const exposure = useApi<ExposureReport>(batch && direction === "forward" ? `/api/batches/${batch}/exposure` : null);
  const provenance = useApi<ProvenanceReport>(batch && direction === "backward" ? `/api/batches/${batch}/provenance` : null);
  const active = direction === "forward" ? exposure : provenance;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div className="row" style={{ flex: 1 }}>
            <div style={{ minWidth: 280, flex: 1, maxWidth: 520 }}>
              <BatchSelect options={options.data} value={batch} onChange={onBatch} placeholder="Choose a batch to trace" />
            </div>
            <Segmented
              label="Direction"
              value={direction}
              onChange={setDirection}
              options={[
                { value: "forward", label: "Forward: who got it" },
                { value: "backward", label: "Backward: what went in" },
              ]}
            />
          </div>
        </div>
        <div className="card-body">
          {!batch ? (
            <Empty title="Pick a batch">Forward shows every outlet reached at any depth; backward shows every input.</Empty>
          ) : active.error ? (
            <ErrorBanner error={active.error} />
          ) : active.loading || !active.data ? (
            <Loading label="Traversing in Neo4j" />
          ) : direction === "forward" && exposure.data ? (
            <div className="stack">
              <p className="muted">
                {plural(exposure.data.downstream.length, "downstream batch", "downstream batches")} and{" "}
                {plural(new Set(exposure.data.outlets.map((o) => o.outletId)).size, "outlet")} reached in {exposure.data.elapsedMs} ms.
              </p>
              <LineageGraph
                source={exposure.data.source}
                nodes={exposure.data.downstream}
                edges={exposure.data.edges}
                outlets={exposure.data.outlets}
                direction="forward"
              />
            </div>
          ) : provenance.data ? (
            <div className="stack">
              <p className="muted">
                {plural(provenance.data.upstream.length, "input batch", "input batches")} went into {provenance.data.source.batchCode}, found in{" "}
                {provenance.data.elapsedMs} ms.
              </p>
              {provenance.data.upstream.length === 0 ? (
                <Empty title="A raw material lot">Nothing went into this batch.</Empty>
              ) : (
                <LineageGraph source={provenance.data.source} nodes={provenance.data.upstream} edges={provenance.data.edges} direction="backward" />
              )}
            </div>
          ) : null}
        </div>
      </div>

      {direction === "forward" && exposure.data && exposure.data.outlets.length > 0 && (
        <div className="card">
          <div className="card-head">
            <h2>Shipments that carried an affected batch</h2>
          </div>
          <div className="card-body flush table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Outlet</th>
                  <th>Affected batch</th>
                  <th>Hops from source</th>
                  <th>Shipment</th>
                  <th className="right">Units</th>
                </tr>
              </thead>
              <tbody>
                {exposure.data.outlets.map((o) => (
                  <tr key={`${o.outletId}-${o.shipmentId}-${o.affectedBatchId}`}>
                    <td>
                      {o.outletName}
                      <span className="muted"> · {o.city}</span>
                    </td>
                    <td className="code">{o.affectedBatchCode}</td>
                    <td>
                      <span className="hop">{o.hopDepth}</span> {o.hopDepth === 0 && <span className="muted">shipped directly</span>}
                    </td>
                    <td className="code">#{o.shipmentId}</td>
                    <td className="right num">{fmtNum(o.quantity)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------- compare: the requirement 18 evidence ---------- */

function Compare({ batch, onBatch }: { batch: number | ""; onBatch: (b: number | "") => void }) {
  const options = useBatchOptions(false);
  const report = useApi<ComparisonReport>(batch ? `/api/batches/${batch}/compare` : null);
  const r = report.data;

  return (
    <div className="stack">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>The same question in two languages</h2>
            <div className="sub">
              Which outlets received anything containing this batch, at any depth? PostgreSQL needs a recursive CTE; Neo4j
              needs one variable-length pattern. Both run live, and the results must match exactly.
            </div>
          </div>
          <div style={{ minWidth: 300, flex: "0 1 460px" }}>
            <BatchSelect options={options.data} value={batch} onChange={onBatch} placeholder="Choose a batch" />
          </div>
        </div>
        <div className="card-body">
          {!batch ? (
            <Empty title="Pick a batch">A raw material lot such as SUG-RAW-001 reaches outlets four steps away.</Empty>
          ) : report.error ? (
            <ErrorBanner error={report.error} />
          ) : !r || report.loading ? (
            <Loading label="Running both queries" />
          ) : (
            <div className="stack">
              {r.agree ? (
                <div className="banner ok">
                  <Icon name="check" />
                  <div className="body">
                    <span className="title">Identical results: {plural(r.sql.rows, "row")} from each engine</span>
                    <span>Every (outlet, batch, shipment) found by the recursive CTE was found by Cypher, and nothing else.</span>
                  </div>
                </div>
              ) : (
                <div className="banner">
                  <Icon name="alert" />
                  <div className="body">
                    <span className="title">The engines disagree</span>
                    <span>
                      {r.onlyInSql.length} only in SQL, {r.onlyInCypher.length} only in Cypher. The graph projection has drifted:
                      run <code>npm run graph:resync</code>.
                    </span>
                  </div>
                </div>
              )}
              <div className="versus">
                {[r.sql, r.cypher].map((run) => (
                  <div key={run.engine}>
                    <div className="engine-head">
                      <strong>{run.engine === "postgres" ? "PostgreSQL · recursive CTE" : "Neo4j · Cypher"}</strong>
                      <span className="pill accent">{run.query.split("\n").length} lines</span>
                    </div>
                    <CodeBlock code={run.query} />
                    <div className="metric">
                      <span>
                        rows <b>{run.rows}</b>
                      </span>
                      <span>
                        time <b>{run.elapsedMs} ms</b>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <p className="faint" style={{ fontSize: 12 }}>
                Timings at this size are dominated by round trips and say little; the argument is in the shape of the query.
                The recursion, the anchor/step split and the duplicate handling that the CTE spells out are what
                <code> -[:WENT_INTO*0..]-&gt;</code> expresses directly. See docs/indexing-evidence.md for measured
                performance at scale.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------- reports: the requirement 6 query set, live ---------- */

function Reports() {
  const list = useApi<Pick<Report, "id" | "title" | "summary" | "features">[]>("/api/reports");
  const [id, setId] = useState("exposure-by-outlet");
  const [threshold, setThreshold] = useState("100");
  const report = useApi<Report>(`/api/reports/${id}${id === "heavily-affected" ? `?threshold=${encodeURIComponent(threshold)}` : ""}`);

  return (
    <div className="grid side">
      <div className="card">
        <div className="card-head">
          <div>
            <h2>Queries</h2>
            <div className="sub">The same SQL as db/postgres/03_queries.sql.</div>
          </div>
        </div>
        <div className="card-body flush">
          {list.data?.map((r) => (
            <button
              key={r.id}
              onClick={() => setId(r.id)}
              className="nav-link"
              style={{
                width: "calc(100% - 16px)",
                margin: "2px 8px",
                height: "auto",
                padding: "9px 10px",
                border: 0,
                textAlign: "left",
                background: r.id === id ? "var(--accent-soft)" : "transparent",
                color: r.id === id ? "var(--accent-ink)" : undefined,
                cursor: "pointer",
                display: "block",
              }}
            >
              <div style={{ fontWeight: 700 }}>{r.title}</div>
              <div className="muted" style={{ fontSize: 12, fontWeight: 500 }}>
                {r.features.join(" · ")}
              </div>
            </button>
          )) ?? <Loading />}
        </div>
      </div>

      <div className="card">
        {report.error ? (
          <div className="card-body" style={{ paddingTop: 18 }}>
            <ErrorBanner error={report.error} />
          </div>
        ) : !report.data ? (
          <Loading />
        ) : (
          <>
            <div className="card-head">
              <div>
                <h2>{report.data.title}</h2>
                <div className="sub">{report.data.summary}</div>
              </div>
              {id === "heavily-affected" && (
                <label className="row">
                  <span className="muted">More than</span>
                  <input className="input num" style={{ width: 90 }} value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                  <span className="muted">units</span>
                </label>
              )}
            </div>
            <div className="card-body stack">
              <div className="chips">
                {report.data.features.map((f) => (
                  <span className="chip" key={f}>
                    {f}
                  </span>
                ))}
              </div>
              <CodeBlock code={report.data.sql} />
              <div className="row between">
                <span className="label">
                  Result · {plural(report.data.rows.length, "row")} · {report.data.elapsedMs} ms
                </span>
              </div>
            </div>
            <div className="card-body flush table-wrap" style={{ maxHeight: 420, overflowY: "auto" }}>
              {report.data.rows.length === 0 ? (
                <Empty title="No rows">The query ran; nothing in the data meets its conditions right now.</Empty>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      {report.data.columns.map((c) => (
                        <th key={c}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {report.data.rows.map((row, i) => (
                      <tr key={i}>
                        {report.data!.columns.map((c) => (
                          <td key={c} className={typeof row[c] === "number" ? "right num" : c.includes("code") || c.includes("batch") ? "code" : undefined}>
                            {c === "status" && typeof row[c] === "string" && ["ACTIVE", "QUARANTINED", "RECALLED"].includes(row[c] as string) ? (
                              <StatusPill status={row[c] as "ACTIVE"} />
                            ) : typeof row[c] === "number" ? (
                              fmtNum(row[c] as number)
                            ) : (
                              String(row[c] ?? "–")
                            )}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
