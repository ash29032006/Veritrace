"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { useSession } from "@/components/AppShell";
import { BatchLinesEditor, completeLines, type Line, useBatchOptions } from "@/components/BatchLines";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { Empty, ErrorBanner, Loading, Modal, Pager, Segmented, StatusPill, SyncNotice } from "@/components/ui";
import { api, type ApiFailure, useApi } from "@/lib/client/api";
import { fmtDate, fmtNum, today } from "@/lib/format";
import type { Batch, BatchStatus, CompositionInput, Page, SyncStatus } from "@/lib/types";

type StatusFilter = "" | BatchStatus;
type StageFilter = "" | "raw" | "intermediate" | "finished";

function stageOf(b: Batch): string {
  if (b.input_count === 0) return "Raw";
  return b.output_count === 0 ? "Finished" : "Intermediate";
}

export default function BatchesPage() {
  const user = useSession();
  const canWrite = user.role === "MANUFACTURER";
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [stage, setStage] = useState<StageFilter>("");
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      setDebounced(q.trim());
      setPage(1);
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  const qs = new URLSearchParams({ page: String(page), pageSize: "25" });
  if (debounced) qs.set("q", debounced);
  if (status) qs.set("status", status);
  if (stage) qs.set("stage", stage);
  const list = useApi<Page<Batch>>(`/api/batches?${qs}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Batches</h1>
          <p>
            Every lot, from raw material to finished product. A batch made from other batches records its inputs, and
            those links are the lineage the recall cascade follows.
          </p>
        </div>
        {canWrite && (
          <button className="btn primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={16} /> New batch
          </button>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <div className="search">
            <Icon name="search" size={16} />
            <input
              className="input"
              placeholder="Search batch code or product"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search batches"
            />
          </div>
          <div className="row">
            <Segmented<StageFilter>
              label="Stage"
              value={stage}
              onChange={(v) => {
                setStage(v);
                setPage(1);
              }}
              options={[
                { value: "", label: "All stages" },
                { value: "raw", label: "Raw" },
                { value: "intermediate", label: "Intermediate" },
                { value: "finished", label: "Finished" },
              ]}
            />
            <Segmented<StatusFilter>
              label="Status"
              value={status}
              onChange={(v) => {
                setStatus(v);
                setPage(1);
              }}
              options={[
                { value: "", label: "Any status" },
                { value: "ACTIVE", label: "Active" },
                { value: "QUARANTINED", label: "On hold" },
                { value: "RECALLED", label: "Recalled" },
              ]}
            />
          </div>
        </div>
        <div className="card-body flush">
          {list.error ? (
            <div className="card-body">
              <ErrorBanner error={list.error} />
            </div>
          ) : !list.data ? (
            <Loading />
          ) : list.data.rows.length === 0 ? (
            <Empty title="No batches match">Try a different search or clear the filters.</Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Batch</th>
                      <th>Product</th>
                      <th>Stage</th>
                      <th>Made</th>
                      <th className="right">Produced</th>
                      <th>Remaining</th>
                      <th className="right">Inputs</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.data.rows.map((b) => {
                      const pct = b.quantity_produced ? (b.quantity_available / b.quantity_produced) * 100 : 0;
                      return (
                        <tr key={b.batch_id} className="click" onClick={() => setOpenId(b.batch_id)}>
                          <td className="code">{b.batch_code}</td>
                          <td>{b.product_name}</td>
                          <td className="muted">{stageOf(b)}</td>
                          <td className="nowrap">{fmtDate(b.manufacture_date)}</td>
                          <td className="right num">{fmtNum(b.quantity_produced)}</td>
                          <td>
                            <div className="row" style={{ flexWrap: "nowrap" }} title={`${fmtNum(b.quantity_available)} of ${fmtNum(b.quantity_produced)} left`}>
                              <div className="meter" style={{ width: 70 }}>
                                <div style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
                              </div>
                              <span className="num muted">{fmtNum(b.quantity_available)}</span>
                            </div>
                          </td>
                          <td className="right num">{b.input_count}</td>
                          <td>
                            <StatusPill status={b.status} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <Pager page={page} pageSize={25} total={list.data.total} onPage={setPage} />
            </>
          )}
        </div>
      </div>

      {creating && (
        <CreateBatchModal
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            void list.reload();
            setOpenId(id);
          }}
        />
      )}
      {openId !== null && (
        <BatchDetailModal batchId={openId} canWrite={canWrite} onClose={() => setOpenId(null)} onChanged={() => list.reload()} />
      )}
    </>
  );
}

/* ---------- create ---------- */

function CreateBatchModal({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const toast = useToast();
  const options = useBatchOptions(true);
  const [form, setForm] = useState({
    batchCode: "",
    productName: "",
    description: "",
    manufactureDate: today(),
    quantityProduced: "",
  });
  const [inputs, setInputs] = useState<Line[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ batch: Batch; sync: SyncStatus }>("/api/batches", {
        method: "POST",
        json: {
          ...form,
          quantityProduced: Number(form.quantityProduced),
          inputs: completeLines(inputs).map((l) => ({ batchId: l.batchId, quantityUsed: l.quantity })),
        },
      });
      toast(
        res.sync.errors.length
          ? `${res.batch.batch_code} saved; a projection failed to update`
          : `${res.batch.batch_code} registered`,
        res.sync.errors.length ? "bad" : "ok",
      );
      onCreated(res.batch.batch_id);
    } catch (err) {
      setError(err as ApiFailure);
      setBusy(false);
    }
  }

  return (
    <Modal title="Register a batch" onClose={onClose} wide>
      <form className="fields" onSubmit={submit}>
        <div className="fields two">
          <label className="field">
            <span>Batch code</span>
            <input className="input mono" value={form.batchCode} onChange={set("batchCode")} placeholder="CCB-FIN-004" required />
          </label>
          <label className="field">
            <span>Product</span>
            <input className="input" value={form.productName} onChange={set("productName")} placeholder="Choco Cream Biscuits 150g" required />
          </label>
          <label className="field">
            <span>Manufactured on</span>
            <input className="input" type="date" value={form.manufactureDate} onChange={set("manufactureDate")} required />
          </label>
          <label className="field">
            <span>Quantity produced</span>
            <input className="input num" inputMode="decimal" value={form.quantityProduced} onChange={set("quantityProduced")} required />
          </label>
        </div>
        <label className="field">
          <span>Description</span>
          <textarea
            className="textarea"
            value={form.description}
            onChange={set("description")}
            placeholder="What the product is and how it is packed. This text is embedded for complaint matching."
            maxLength={400}
          />
        </label>
        <div className="field">
          <span>Made from (optional)</span>
          <span className="hint">
            Each input is checked by the database: it must be active, have enough left, be older than this batch, and not
            create a cycle.
          </span>
          <BatchLinesEditor lines={inputs} onChange={setInputs} options={options.data} quantityLabel="Qty used" />
        </div>
        <ErrorBanner error={error} />
        <div className="modal-foot">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Register batch"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ---------- detail, composition editor, hold ---------- */

interface Detail {
  batch: Batch;
  inputs: CompositionInput[];
  outputs: CompositionInput[];
}

function BatchDetailModal({
  batchId,
  canWrite,
  onClose,
  onChanged,
}: {
  batchId: number;
  canWrite: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const detail = useApi<Detail>(`/api/batches/${batchId}`);
  const options = useBatchOptions(true);
  const [adding, setAdding] = useState<Line[] | null>(null);
  const [error, setError] = useState<ApiFailure>();
  const [sync, setSync] = useState<SyncStatus>();
  const [busy, setBusy] = useState(false);

  async function addInputs() {
    if (!adding) return;
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ sync: SyncStatus }>(`/api/batches/${batchId}/composition`, {
        method: "POST",
        json: { inputs: completeLines(adding).map((l) => ({ batchId: l.batchId, quantityUsed: l.quantity })) },
      });
      setSync(res.sync);
      setAdding(null);
      toast("Inputs recorded");
      await detail.reload();
      onChanged();
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setBusy(false);
    }
  }

  async function setHold(status: "ACTIVE" | "QUARANTINED") {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<{ sync: SyncStatus }>(`/api/batches/${batchId}`, { method: "PATCH", json: { status } });
      setSync(res.sync);
      toast(status === "QUARANTINED" ? "Batch put on hold" : "Batch released");
      await detail.reload();
      onChanged();
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setBusy(false);
    }
  }

  const d = detail.data;
  return (
    <Modal title={d ? d.batch.batch_code : "Batch"} onClose={onClose} wide>
      {!d ? (
        detail.error ? <ErrorBanner error={detail.error} /> : <Loading />
      ) : (
        <>
          <div className="row between">
            <div>
              <div style={{ fontSize: 16, fontWeight: 750 }}>{d.batch.product_name}</div>
              <div className="muted">{d.batch.description ?? "No description"}</div>
            </div>
            <StatusPill status={d.batch.status} />
          </div>
          <dl className="kv well">
            <dt>Manufactured</dt>
            <dd>{fmtDate(d.batch.manufacture_date)}</dd>
            <dt>Produced</dt>
            <dd className="num">{fmtNum(d.batch.quantity_produced)}</dd>
            <dt>Used in other batches</dt>
            <dd className="num">{fmtNum(d.batch.quantity_consumed)}</dd>
            <dt>Shipped to outlets</dt>
            <dd className="num">{fmtNum(d.batch.quantity_shipped)}</dd>
            <dt>Remaining</dt>
            <dd className="num">
              <b>{fmtNum(d.batch.quantity_available)}</b>
            </dd>
          </dl>

          <div className="grid two">
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Made from ({d.inputs.length})
              </div>
              {d.inputs.length === 0 ? (
                <div className="muted">A raw material lot: nothing went into it.</div>
              ) : (
                <div className="chips">
                  {d.inputs.map((i) => (
                    <span key={i.batch_id} className={`chip mono${i.status === "RECALLED" ? " bad" : ""}`} title={`${i.product_name}, ${i.quantity_used} used`}>
                      {i.batch_code} · {fmtNum(i.quantity_used)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Went into ({d.outputs.length})
              </div>
              {d.outputs.length === 0 ? (
                <div className="muted">Not used in any other batch.</div>
              ) : (
                <div className="chips">
                  {d.outputs.map((o) => (
                    <span key={o.batch_id} className={`chip mono${o.status === "RECALLED" ? " bad" : ""}`} title={o.product_name}>
                      {o.batch_code}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {adding && (
            <div className="well">
              <div className="label" style={{ marginBottom: 8 }}>
                Record more inputs
              </div>
              <BatchLinesEditor
                lines={adding}
                onChange={setAdding}
                options={options.data}
                exclude={[batchId, ...d.inputs.map((i) => i.batch_id)]}
                quantityLabel="Qty used"
              />
              <div className="modal-foot">
                <button className="btn" onClick={() => setAdding(null)}>
                  Cancel
                </button>
                <button className="btn primary" disabled={busy} onClick={addInputs}>
                  Save inputs
                </button>
              </div>
            </div>
          )}

          <ErrorBanner error={error} />
          <SyncNotice sync={sync} />

          <div className="modal-foot" style={{ justifyContent: "space-between" }}>
            <div className="row">
              <Link className="btn" href={`/exposure?tab=trace&batch=${batchId}`}>
                <Icon name="graph" size={16} /> Trace exposure
              </Link>
              <Link className="btn" href={`/exposure?tab=compare&batch=${batchId}`}>
                <Icon name="database" size={16} /> SQL vs Cypher
              </Link>
            </div>
            {canWrite && d.batch.status !== "RECALLED" && (
              <div className="row">
                {!adding && (
                  <button className="btn" onClick={() => setAdding([{ batchId: "", quantity: "" }])}>
                    <Icon name="layers" size={16} /> Add inputs
                  </button>
                )}
                {d.batch.status === "ACTIVE" ? (
                  <button className="btn soft-danger" disabled={busy} onClick={() => setHold("QUARANTINED")}>
                    Put on hold
                  </button>
                ) : (
                  <button className="btn" disabled={busy} onClick={() => setHold("ACTIVE")}>
                    Release hold
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}
    </Modal>
  );
}
