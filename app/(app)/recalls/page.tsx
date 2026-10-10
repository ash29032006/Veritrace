"use client";

import Link from "next/link";
import { useState } from "react";
import { useSession } from "@/components/AppShell";
import { BatchSelect, useBatchOptions } from "@/components/BatchLines";
import { Icon } from "@/components/Icon";
import { LineageGraph } from "@/components/LineageGraph";
import { useToast } from "@/components/Toast";
import { Empty, ErrorBanner, Loading, RecallPill, SyncNotice } from "@/components/ui";
import { api, type ApiFailure, useApi } from "@/lib/client/api";
import { fmtDateTime, fmtNum, plural } from "@/lib/format";
import type { ExposureReport, ExposureRow, Recall, SyncStatus } from "@/lib/types";

interface RecallResult {
  recall: Recall;
  scope: { batch_id: number; batch_code: string; product_name: string; hop_depth: number }[];
  outlets: ExposureRow[];
  sync: SyncStatus;
}

export default function RecallsPage() {
  const user = useSession();
  const recalls = useApi<Recall[]>("/api/recalls");

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Recalls</h1>
          <p>
            Neo4j finds every batch downstream of the contaminated one, at any depth. Then one PostgreSQL transaction (
            <code>sp_initiate_recall</code>) marks them recalled, quarantines their stock at every outlet and writes the
            audit trail. All of it commits, or none of it does.
          </p>
        </div>
      </div>
      <div className="stack">
        {user.role === "MANUFACTURER" && <InitiateRecall onDone={() => recalls.reload()} />}
        <RecallList recalls={recalls.data} error={recalls.error} canClose={user.role === "REGULATOR"} onChanged={() => recalls.reload()} />
      </div>
    </>
  );
}

function InitiateRecall({ onDone }: { onDone: () => void }) {
  const toast = useToast();
  const options = useBatchOptions(false);
  const [batchId, setBatchId] = useState<number | "">("");
  const [preview, setPreview] = useState<ExposureReport>();
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const [result, setResult] = useState<RecallResult>();

  async function loadPreview(id: number | "") {
    setBatchId(id);
    setPreview(undefined);
    setConfirming(false);
    setError(undefined);
    setResult(undefined);
    if (!id) return;
    setBusy(true);
    try {
      setPreview(await api<ExposureReport>(`/api/batches/${id}/exposure`));
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setBusy(false);
    }
  }

  async function fire() {
    setBusy(true);
    setError(undefined);
    try {
      const res = await api<RecallResult>("/api/recalls", { method: "POST", json: { batchId, reason } });
      setResult(res);
      setConfirming(false);
      setReason("");
      toast(`Recall #${res.recall.recall_id} initiated`);
      void options.reload();
      onDone();
    } catch (err) {
      setError(err as ApiFailure);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const outletIds = new Set(preview?.outlets.map((o) => o.outletId));
  const units = preview?.outlets.reduce((s, o) => s + o.quantity, 0) ?? 0;
  const deepest = Math.max(0, ...(preview?.outlets.map((o) => o.hopDepth) ?? [0]));
  const selected = options.data?.find((o) => o.batch_id === batchId);

  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>Initiate a recall</h2>
          <div className="sub">Choose the contaminated batch. Its exposure is previewed before anything changes.</div>
        </div>
      </div>
      <div className="card-body stack">
        <div className="fields two">
          <label className="field">
            <span>Contaminated batch</span>
            <BatchSelect options={options.data} value={batchId} onChange={loadPreview} placeholder="Choose the batch to recall" />
          </label>
        </div>

        {busy && !preview && <Loading label="Tracing downstream in Neo4j" />}
        {preview && (
          <>
            <div className="stats">
              <div className="card stat">
                <div className="label">Batches in scope</div>
                <div className="value">{preview.downstream.length + 1}</div>
                <div className="sub">the source and {plural(preview.downstream.length, "downstream batch", "downstream batches")}</div>
              </div>
              <div className="card stat">
                <div className="label">Outlets exposed</div>
                <div className="value">{outletIds.size}</div>
                <div className="sub">received an affected batch</div>
              </div>
              <div className="card stat">
                <div className="label">Units shipped</div>
                <div className="value">{fmtNum(units)}</div>
                <div className="sub">across {plural(preview.outlets.length, "shipment line")}</div>
              </div>
              <div className="card stat">
                <div className="label">Deepest outlet</div>
                <div className="value">{deepest}</div>
                <div className="sub">processing steps from the source</div>
              </div>
            </div>
            <LineageGraph source={preview.source} nodes={preview.downstream} edges={preview.edges} outlets={preview.outlets} direction="forward" />
            <p className="faint" style={{ fontSize: 12 }}>
              Traversed in Neo4j in {preview.elapsedMs} ms with <code>-[:WENT_INTO*0..]-&gt;</code>.
            </p>

            <label className="field">
              <span>Reason</span>
              <textarea
                className="textarea"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="What was found, where, and how it was confirmed (at least 10 characters)."
                maxLength={1000}
              />
            </label>
          </>
        )}

        <ErrorBanner error={error} />

        {preview && (
          <div className="row between">
            <span className="muted">
              {selected?.status === "RECALLED"
                ? "This batch is already recalled; the procedure will refuse it."
                : `This will quarantine stock of ${plural(preview.downstream.length + 1, "batch", "batches")} at ${plural(outletIds.size, "outlet")}.`}
            </span>
            {confirming ? (
              <span className="confirm-inline">
                Recall {preview.source.batchCode} now?
                <button className="btn danger" disabled={busy} onClick={fire}>
                  {busy ? "Running cascade…" : "Yes, recall"}
                </button>
                <button className="btn" onClick={() => setConfirming(false)}>
                  No
                </button>
              </span>
            ) : (
              <button className="btn danger" disabled={reason.trim().length < 10} onClick={() => setConfirming(true)}>
                <Icon name="alert" size={16} /> Initiate recall
              </button>
            )}
          </div>
        )}

        {result && (
          <div className="stack">
            <div className="banner ok">
              <Icon name="check" />
              <div className="body">
                <span className="title">
                  Recall #{result.recall.recall_id} committed in one transaction
                </span>
                <span>
                  {plural(result.recall.batches_in_scope, "batch", "batches")} marked RECALLED, {fmtNum(result.recall.units_quarantined)} units
                  quarantined across {plural(result.recall.outlets_exposed, "outlet")}. The audit log has a row for every step.
                </span>
                <span className="meta">
                  Next: try shipping {result.recall.batch_code} on the <Link href="/shipments">Shipments</Link> screen; the
                  trigger will refuse it.
                </span>
              </div>
            </div>
            <SyncNotice sync={result.sync} />
          </div>
        )}
      </div>
    </div>
  );
}

function RecallList({
  recalls,
  error,
  canClose,
  onChanged,
}: {
  recalls: Recall[] | undefined;
  error: ApiFailure | undefined;
  canClose: boolean;
  onChanged: () => void;
}) {
  return (
    <div className="card">
      <div className="card-head">
        <div>
          <h2>All recalls</h2>
          <div className="sub">
            {canClose
              ? "As regulator you close a recall once no affected stock is left on sale. sp_close_recall checks that."
              : "Regulators close recalls once no affected stock remains on sale."}
          </div>
        </div>
      </div>
      <div className="card-body flush">
        {error ? (
          <div className="card-body">
            <ErrorBanner error={error} />
          </div>
        ) : !recalls ? (
          <Loading />
        ) : recalls.length === 0 ? (
          <Empty title="No recalls yet" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Source batch</th>
                  <th>Reason</th>
                  <th className="right">Scope</th>
                  <th className="right">Outlets</th>
                  <th className="right">Units held</th>
                  <th>Initiated</th>
                  <th>Status</th>
                  {canClose && <th />}
                </tr>
              </thead>
              <tbody>
                {recalls.map((r) => (
                  <RecallRow key={r.recall_id} r={r} canClose={canClose} onChanged={onChanged} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function RecallRow({ r, canClose, onChanged }: { r: Recall; canClose: boolean; onChanged: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiFailure>();

  async function close() {
    setError(undefined);
    try {
      await api(`/api/recalls/${r.recall_id}`, { method: "PATCH", json: { status: "CLOSED" } });
      toast(`Recall #${r.recall_id} closed`);
      onChanged();
    } catch (err) {
      setError(err as ApiFailure);
    } finally {
      setConfirming(false);
    }
  }

  return (
    <>
      <tr>
        <td className="code">#{r.recall_id}</td>
        <td>
          <span className="mono" style={{ fontWeight: 650 }}>
            {r.batch_code}
          </span>
          <div className="muted" style={{ fontSize: 12 }}>
            {r.product_name}
          </div>
        </td>
        <td style={{ maxWidth: 360 }}>{r.reason}</td>
        <td className="right num">{r.batches_in_scope}</td>
        <td className="right num">{r.outlets_exposed}</td>
        <td className="right num">{fmtNum(r.units_quarantined)}</td>
        <td className="nowrap">
          {fmtDateTime(r.initiated_at)}
          <div className="muted" style={{ fontSize: 12 }}>
            by {r.initiated_by}
            {r.closed_by ? `, closed by ${r.closed_by}` : ""}
          </div>
        </td>
        <td>
          <RecallPill status={r.recall_status} />
        </td>
        {canClose && (
          <td className="right nowrap">
            {r.recall_status === "OPEN" &&
              (confirming ? (
                <span className="confirm-inline" style={{ color: "var(--ink-2)" }}>
                  Close #{r.recall_id}?
                  <button className="btn small primary" onClick={close}>
                    Yes
                  </button>
                  <button className="btn small" onClick={() => setConfirming(false)}>
                    No
                  </button>
                </span>
              ) : (
                <button className="btn small" onClick={() => setConfirming(true)}>
                  <Icon name="check" size={15} /> Close
                </button>
              ))}
          </td>
        )}
      </tr>
      {error && (
        <tr>
          <td colSpan={9}>
            <ErrorBanner error={error} />
          </td>
        </tr>
      )}
    </>
  );
}
