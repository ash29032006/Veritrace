"use client";

import { type FormEvent, useState } from "react";
import { useSession } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { Empty, ErrorBanner, Loading, Pager, Segmented, StatusPill } from "@/components/ui";
import { api, type ApiFailure, useApi } from "@/lib/client/api";
import { fmtDate, fmtDateTime, fmtScore } from "@/lib/format";
import type { AuditEntry, Complaint, ComplaintAnalysis, Outlet, Page, SyncStatus } from "@/lib/types";

type Tab = "complaints" | "audit";

export default function ComplaintsPage() {
  const user = useSession();
  const isRegulator = user.role === "REGULATOR";
  const [tab, setTab] = useState<Tab>("complaints");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{tab === "audit" ? "Audit log" : "Complaints"}</h1>
          <p>
            {tab === "audit"
              ? "Every change, written by the database in the same transaction as the change itself. Append only: a trigger refuses UPDATE and DELETE."
              : "Customers never quote batch numbers. A complaint is embedded and matched to batches by meaning, then narrowed to what was actually shipped to that outlet."}
          </p>
        </div>
        {isRegulator && (
          <Segmented<Tab>
            label="View"
            value={tab}
            onChange={setTab}
            options={[
              { value: "complaints", label: "Complaints" },
              { value: "audit", label: "Audit log" },
            ]}
          />
        )}
      </div>
      {tab === "complaints" ? <Complaints isRegulator={isRegulator} /> : <Audit />}
    </>
  );
}

/* ---------- complaints ---------- */

function Complaints({ isRegulator }: { isRegulator: boolean }) {
  const outlets = useApi<Outlet[]>("/api/outlets");
  const list = useApi<Complaint[]>(isRegulator ? "/api/complaints" : null);
  const [analysis, setAnalysis] = useState<ComplaintAnalysis & { sync: SyncStatus }>();

  return (
    <div className="stack">
      <div className="grid side">
        <ComplaintForm outlets={outlets.data} onAnalysed={(a) => { setAnalysis(a); void list.reload(); }} />
        {analysis ? (
          <Analysis a={analysis} />
        ) : (
          <div className="card">
            <Empty title="Enter a complaint to see it matched">
              Try: “The makhani sauce had mould on it the day I opened it, and the lid had bulged.” It shares no word with the
              product description, so keyword search finds nothing.
            </Empty>
          </div>
        )}
      </div>

      {isRegulator && (
        <div className="card">
          <div className="card-head">
            <div>
              <h2>All complaints</h2>
              <div className="sub">matched_batch_id and similarity_score are written back to PostgreSQL after the Qdrant search.</div>
            </div>
          </div>
          <div className="card-body flush">
            {list.error ? (
              <div className="card-body">
                <ErrorBanner error={list.error} />
              </div>
            ) : !list.data ? (
              <Loading />
            ) : list.data.length === 0 ? (
              <Empty title="No complaints yet" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Complaint</th>
                      <th>Outlet</th>
                      <th>Matched batch</th>
                      <th className="right">Similarity</th>
                      <th>Received</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.map((c) => (
                      <tr key={c.complaint_id}>
                        <td className="code">#{c.complaint_id}</td>
                        <td style={{ maxWidth: 420 }}>{c.complaint_text}</td>
                        <td>{c.outlet_name ?? <span className="faint">not given</span>}</td>
                        <td>
                          {c.matched_batch_code ? (
                            <>
                              <span className="mono" style={{ fontWeight: 650 }}>
                                {c.matched_batch_code}
                              </span>
                              <div className="muted" style={{ fontSize: 12 }}>
                                {c.matched_product}
                              </div>
                            </>
                          ) : (
                            <span className="pill warn">Unmatched</span>
                          )}
                        </td>
                        <td className="right num">{fmtScore(c.similarity_score)}</td>
                        <td className="nowrap">{fmtDateTime(c.received_at)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function ComplaintForm({
  outlets,
  onAnalysed,
}: {
  outlets: Outlet[] | undefined;
  onAnalysed: (a: ComplaintAnalysis & { sync: SyncStatus }) => void;
}) {
  const toast = useToast();
  const [outletId, setOutletId] = useState<number | "">("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<ComplaintAnalysis & { sync: SyncStatus }>("/api/complaints", {
        method: "POST",
        json: { outletId: outletId || null, text },
      });
      onAnalysed(res);
      toast(`Complaint #${res.complaint.complaint_id} recorded`);
      setText("");
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <div className="card-head">
        <div>
          <h2>New complaint</h2>
          <div className="sub">Write it the way a customer would.</div>
        </div>
      </div>
      <div className="card-body fields">
        <label className="field">
          <span>Where it was bought</span>
          <select className="select" value={outletId} onChange={(e) => setOutletId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">Not known</option>
            {outlets?.map((o) => (
              <option key={o.outlet_id} value={o.outlet_id}>
                {o.outlet_name}, {o.city}
              </option>
            ))}
          </select>
          <span className="hint">Narrows the search to batches shipped there.</span>
        </label>
        <label className="field">
          <span>What happened</span>
          <textarea
            className="textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Bottle smelled off, bought it last Tuesday…"
            maxLength={2000}
            required
          />
        </label>
        <ErrorBanner error={error} />
        <button className="btn primary" disabled={busy || text.trim().length < 10}>
          {busy ? "Embedding and matching…" : "Submit and match"}
        </button>
      </div>
    </form>
  );
}

function Analysis({ a }: { a: ComplaintAnalysis & { sync: SyncStatus } }) {
  const best = a.vectorMatches[0];
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Complaint #{a.complaint.complaint_id}</h2>
          <div className="sub">“{a.complaint.complaint_text}”</div>
        </div>
      </div>
      <div className="card-body stack">
        {a.sync.errors.length > 0 && <ErrorBanner error={a.sync.errors.join(" · ")} />}

        {best && (
          <div className="match-card">
            <Icon name="check" size={22} />
            <div>
              <div className="label">Most likely batch</div>
              <div style={{ fontSize: 16, fontWeight: 800 }} className="mono">
                {best.batchCode}
              </div>
              <div className="muted">
                {best.productName}
                {best.lastShippedToOutlet
                  ? ` · last shipped${a.candidateScope === "outlet" ? " to this outlet" : ""} ${fmtDate(best.lastShippedToOutlet)}`
                  : ""}
              </div>
            </div>
            <div className="score">
              <span className="label">cosine similarity</span>
              <b>{fmtScore(best.similarity)}</b>
            </div>
          </div>
        )}

        <div className="versus">
          <div>
            <div className="engine-head">
              <strong>Vector search · Qdrant</strong>
              <span className="pill accent">{a.candidateScope === "outlet" ? "this outlet's batches" : "all shipped batches"}</span>
            </div>
            {a.vectorMatches.length === 0 ? (
              <div className="muted">No candidates.</div>
            ) : (
              <div className="bars">
                {a.vectorMatches.map((m) => (
                  <div className="bar-row" key={m.batchId} style={{ gridTemplateColumns: "minmax(120px, 44%) minmax(0, 1fr) 52px" }} title={`${m.productName} · ${m.status}`}>
                    <div className="ellipsis">
                      <span className="mono" style={{ fontWeight: 650 }}>
                        {m.batchCode}
                      </span>{" "}
                      {m.status !== "ACTIVE" && <StatusPill status={m.status} />}
                    </div>
                    <div className="bar-track">
                      <div className={`bar-fill${m === best ? "" : " soft"}`} style={{ width: `${Math.max(2, m.similarity * 100)}%` }} />
                    </div>
                    <div className="num right">{fmtScore(m.similarity)}</div>
                  </div>
                ))}
              </div>
            )}
            <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              all-MiniLM-L6-v2, 384 dimensions, cosine. Embedded in {a.elapsedMs.embed} ms, searched in {a.elapsedMs.search} ms.
            </p>
          </div>
          <div>
            <div className="engine-head">
              <strong>Keyword search · PostgreSQL full text</strong>
              <span className="pill idle">baseline</span>
            </div>
            {a.keywordMatches.length === 0 ? (
              <div className="banner info">
                <Icon name="ban" />
                <div className="body">
                  <span className="title">No batch found</span>
                  <span>Not one stemmed word of the complaint appears in any product description.</span>
                </div>
              </div>
            ) : (
              <div className="chips">
                {a.keywordMatches.map((k) => (
                  <span className="chip mono" key={k.batchId} title={k.productName}>
                    {k.batchCode} · {k.productName}
                  </span>
                ))}
              </div>
            )}
            <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>
              Searched for any of: <span className="mono">{a.keywordQuery || "(no words)"}</span>
            </p>
          </div>
        </div>

        {a.similarComplaints.length > 0 && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Earlier complaints that read alike
            </div>
            <div className="stack" style={{ gap: 6 }}>
              {a.similarComplaints.map((s) => (
                <div className="well row between" key={s.complaintId} style={{ flexWrap: "nowrap" }}>
                  <span>
                    <span className="faint">#{s.complaintId}</span> {s.text}
                  </span>
                  <span className="num muted nowrap">
                    {s.matchedBatchCode ?? "unmatched"} · {fmtScore(s.similarity)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------- audit ---------- */

function Audit() {
  const [action, setAction] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (action) qs.set("action", action);
  if (from) qs.set("from", from);
  if (to) qs.set("to", to);
  const audit = useApi<Page<AuditEntry> & { actions: string[] }>(`/api/audit?${qs}`);

  return (
    <div className="card">
      <div className="card-head">
        <div className="row">
          <select className="select" style={{ width: 230 }} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Action">
            <option value="">All actions</option>
            {audit.data?.actions.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <label className="row">
            <span className="muted">From</span>
            <input className="input" type="date" style={{ width: 160 }} value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} />
          </label>
          <label className="row">
            <span className="muted">To</span>
            <input className="input" type="date" style={{ width: 160 }} value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} />
          </label>
        </div>
      </div>
      <div className="card-body flush">
        {audit.error ? (
          <div className="card-body">
            <ErrorBanner error={audit.error} />
          </div>
        ) : !audit.data ? (
          <Loading />
        ) : audit.data.rows.length === 0 ? (
          <Empty title="No audit entries match" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                    <th>Entity</th>
                    <th>By</th>
                    <th>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {audit.data.rows.map((r) => (
                    <tr key={r.log_id}>
                      <td className="nowrap">{fmtDateTime(r.performed_at)}</td>
                      <td>
                        <span className={`pill ${r.action.includes("RECALL") || r.action.includes("FAILED") ? "bad" : r.action.includes("QUARANTINED") ? "warn" : "idle"}`}>
                          {r.action.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td className="mono nowrap">
                        {r.entity_name}
                        {r.entity_id ? ` #${r.entity_id}` : ""}
                      </td>
                      <td>{r.performed_by ?? <span className="faint">system</span>}</td>
                      <td style={{ maxWidth: 520 }}>{r.details}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager page={page} pageSize={25} total={audit.data.total} onPage={setPage} />
          </>
        )}
      </div>
    </div>
  );
}
