"use client";

import { Icon } from "@/components/Icon";
import { useApi } from "@/lib/client/api";
import { fmtNum } from "@/lib/format";
import type { BatchStatus } from "@/lib/types";

export interface BatchOption {
  batch_id: number;
  batch_code: string;
  product_name: string;
  status: BatchStatus;
  quantity_available: number;
  manufacture_date: string;
}

export function useBatchOptions(shippable = false) {
  return useApi<BatchOption[]>(`/api/batches/picker${shippable ? "?shippable=1" : ""}`);
}

const STATUS_NOTE: Record<BatchStatus, string> = { ACTIVE: "", QUARANTINED: " · ON HOLD", RECALLED: " · RECALLED" };

/**
 * A batch <select>. Recalled and on-hold batches are listed on purpose: the
 * database, not this dropdown, is what refuses them.
 */
export function BatchSelect({
  options,
  value,
  onChange,
  exclude = [],
  placeholder = "Choose a batch",
  id,
}: {
  options: BatchOption[] | undefined;
  value: number | "";
  onChange: (id: number | "") => void;
  exclude?: number[];
  placeholder?: string;
  id?: string;
}) {
  return (
    <select
      id={id}
      className="select"
      value={value}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")}
    >
      <option value="">{placeholder}</option>
      {(options ?? [])
        .filter((o) => !exclude.includes(o.batch_id) || o.batch_id === value)
        .map((o) => (
          <option key={o.batch_id} value={o.batch_id}>
            {o.batch_code} · {o.product_name} · {fmtNum(o.quantity_available)} left{STATUS_NOTE[o.status]}
          </option>
        ))}
    </select>
  );
}

export interface Line {
  batchId: number | "";
  quantity: string;
}

/** Rows of (batch, quantity), used for composition inputs and shipment lines. */
export function BatchLinesEditor({
  lines,
  onChange,
  options,
  exclude = [],
  quantityLabel,
}: {
  lines: Line[];
  onChange: (lines: Line[]) => void;
  options: BatchOption[] | undefined;
  exclude?: number[];
  quantityLabel: string;
}) {
  const used = lines.map((l) => l.batchId).filter((v): v is number => v !== "");
  const set = (i: number, patch: Partial<Line>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="lines-editor">
      {lines.map((line, i) => (
        <div className="line-row" key={i}>
          <BatchSelect
            options={options}
            value={line.batchId}
            onChange={(batchId) => set(i, { batchId })}
            exclude={[...exclude, ...used]}
          />
          <input
            className="input num"
            inputMode="decimal"
            placeholder={quantityLabel}
            aria-label={quantityLabel}
            value={line.quantity}
            onChange={(e) => set(i, { quantity: e.target.value })}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label="Remove line"
            onClick={() => onChange(lines.filter((_, j) => j !== i))}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
      ))}
      <div>
        <button type="button" className="btn small" onClick={() => onChange([...lines, { batchId: "", quantity: "" }])}>
          <Icon name="plus" size={14} /> Add line
        </button>
      </div>
    </div>
  );
}

export const completeLines = (lines: Line[]) =>
  lines.filter((l) => l.batchId !== "" && l.quantity.trim() !== "").map((l) => ({ batchId: l.batchId as number, quantity: Number(l.quantity) }));
