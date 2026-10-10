"use client";

import { type FormEvent, useState } from "react";
import { useSession } from "@/components/AppShell";
import { BatchLinesEditor, completeLines, type Line, useBatchOptions } from "@/components/BatchLines";
import { Icon } from "@/components/Icon";
import { useToast } from "@/components/Toast";
import { Empty, ErrorBanner, Loading, SyncNotice } from "@/components/ui";
import { api, type ApiFailure, useApi } from "@/lib/client/api";
import { fmtDate, fmtNum, today } from "@/lib/format";
import type { Outlet, Shipment, SyncStatus } from "@/lib/types";

export default function ShipmentsPage() {
  const user = useSession();
  const canWrite = user.role === "MANUFACTURER";
  const [outletFilter, setOutletFilter] = useState<number | "">("");
  const outlets = useApi<Outlet[]>("/api/outlets");
  const shipments = useApi<Shipment[]>(`/api/shipments?limit=200${outletFilter ? `&outletId=${outletFilter}` : ""}`);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Shipments</h1>
          <p>
            Finished batches leave for outlets here. The database checks every line: a recalled or on-hold batch, or more
            units than are left, is refused by the trigger <code>trg_block_unsafe_shipment</code> and the whole shipment
            rolls back.
          </p>
        </div>
      </div>

      <div className={canWrite ? "grid side" : "stack"}>
        {canWrite && <NewShipment outlets={outlets.data} onCreated={() => shipments.reload()} />}

        <div className="card">
          <div className="card-head">
            <div>
              <h2>Recent shipments</h2>
              <div className="sub">Cancelling one deletes its lines (ON DELETE CASCADE) and returns the stock.</div>
            </div>
            <select
              className="select"
              style={{ width: 240 }}
              value={outletFilter}
              onChange={(e) => setOutletFilter(e.target.value ? Number(e.target.value) : "")}
              aria-label="Filter by outlet"
            >
              <option value="">All outlets</option>
              {outlets.data?.map((o) => (
                <option key={o.outlet_id} value={o.outlet_id}>
                  {o.outlet_name}, {o.city}
                </option>
              ))}
            </select>
          </div>
          <div className="card-body flush">
            {shipments.error ? (
              <div className="card-body">
                <ErrorBanner error={shipments.error} />
              </div>
            ) : !shipments.data ? (
              <Loading />
            ) : shipments.data.length === 0 ? (
              <Empty title="No shipments yet" />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>Date</th>
                      <th>Outlet</th>
                      <th>Batches</th>
                      <th className="right">Units</th>
                      {canWrite && <th />}
                    </tr>
                  </thead>
                  <tbody>
                    {shipments.data.map((s) => (
                      <ShipmentRow key={s.shipment_id} s={s} canWrite={canWrite} onCancelled={() => shipments.reload()} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function NewShipment({ outlets, onCreated }: { outlets: Outlet[] | undefined; onCreated: () => void }) {
  const toast = useToast();
  const options = useBatchOptions(true);
  const [outletId, setOutletId] = useState<number | "">("");
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState<Line[]>([{ batchId: "", quantity: "" }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const [sync, setSync] = useState<SyncStatus>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    setSync(undefined);
    try {
      const res = await api<{ shipment: Shipment; sync: SyncStatus }>("/api/shipments", {
        method: "POST",
        json: { outletId, shipmentDate: date, lines: completeLines(lines) },
      });
      setSync(res.sync);
      toast(`Shipment #${res.shipment.shipment_id} dispatched to ${res.shipment.outlet_name}`);
      setLines([{ batchId: "", quantity: "" }]);
      void options.reload();
      onCreated();
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
          <h2>New shipment</h2>
          <div className="sub">Recalled batches stay in the list so you can watch the database refuse them.</div>
        </div>
      </div>
      <div className="card-body fields">
        <label className="field">
          <span>Outlet</span>
          <select
            className="select"
            value={outletId}
            onChange={(e) => setOutletId(e.target.value ? Number(e.target.value) : "")}
            required
          >
            <option value="">Choose an outlet</option>
            {outlets?.map((o) => (
              <option key={o.outlet_id} value={o.outlet_id}>
                {o.outlet_name}, {o.city}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Dispatch date</span>
          <input className="input" type="date" value={date} max={today()} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <div className="field">
          <span>Lines</span>
          <BatchLinesEditor lines={lines} onChange={setLines} options={options.data} quantityLabel="Units" />
        </div>
        <ErrorBanner error={error} />
        <SyncNotice sync={sync} />
        <button className="btn primary" disabled={busy || !outletId}>
          <Icon name="truck" size={16} /> {busy ? "Dispatching…" : "Dispatch shipment"}
        </button>
      </div>
    </form>
  );
}

function ShipmentRow({ s, canWrite, onCancelled }: { s: Shipment; canWrite: boolean; onCancelled: () => void }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiFailure>();
  const hasRecalled = s.lines.some((l) => l.status === "RECALLED");

  async function cancel() {
    setError(undefined);
    try {
      await api(`/api/shipments/${s.shipment_id}`, { method: "DELETE" });
      toast(`Shipment #${s.shipment_id} cancelled and stock returned`);
      onCancelled();
    } catch (err) {
      setError(err as ApiFailure);
      setConfirming(false);
    }
  }

  return (
    <>
      <tr>
        <td className="code">#{s.shipment_id}</td>
        <td className="nowrap">{fmtDate(s.shipment_date)}</td>
        <td>
          {s.outlet_name}
          <div className="muted" style={{ fontSize: 12 }}>
            {s.city}
          </div>
        </td>
        <td>
          <div className="chips">
            {s.lines.map((l) => (
              <span key={l.batch_id} className={`chip mono${l.status === "RECALLED" ? " bad" : ""}`} title={`${l.product_name} · ${l.status}`}>
                {l.batch_code} × {fmtNum(l.quantity)}
              </span>
            ))}
          </div>
        </td>
        <td className="right num">{fmtNum(s.total_units)}</td>
        {canWrite && (
          <td className="right nowrap">
            {confirming ? (
              <span className="confirm-inline">
                Cancel #{s.shipment_id}?
                <button className="btn small danger" onClick={cancel}>
                  Yes
                </button>
                <button className="btn small" onClick={() => setConfirming(false)}>
                  No
                </button>
              </span>
            ) : (
              <button
                className="btn small ghost"
                onClick={() => setConfirming(true)}
                title={hasRecalled ? "Contains a recalled batch: the database will refuse" : "Cancel shipment"}
              >
                <Icon name="trash" size={15} /> Cancel
              </button>
            )}
          </td>
        )}
      </tr>
      {error && (
        <tr>
          <td colSpan={6} style={{ background: "transparent" }}>
            <ErrorBanner error={error} />
          </td>
        </tr>
      )}
    </>
  );
}
