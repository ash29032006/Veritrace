"use client";

import { type ReactNode, useEffect } from "react";
import { Icon } from "@/components/Icon";
import type { ApiFailure } from "@/lib/client/api";
import type { BatchStatus, SyncStatus } from "@/lib/types";

/* Small presentational pieces used across the screens. */

const STATUS: Record<BatchStatus, [string, string]> = {
  ACTIVE: ["ok", "Active"],
  QUARANTINED: ["warn", "On hold"],
  RECALLED: ["bad", "Recalled"],
};

export function StatusPill({ status }: { status: BatchStatus }) {
  const [tone, label] = STATUS[status];
  return (
    <span className={`pill ${tone}`} title={status}>
      {label}
    </span>
  );
}

export function RecallPill({ status }: { status: "OPEN" | "CLOSED" }) {
  return status === "OPEN" ? <span className="pill bad">Open</span> : <span className="pill idle">Closed</span>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return (
    <div className="loading">
      <span className="spinner" /> {label}…
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

/**
 * Shows an API failure. A database refusal (a trigger, a procedure, a CHECK)
 * is labelled as such, with the HTTP status and the database's own detail,
 * because the point is to show the database enforcing the rule.
 */
export function ErrorBanner({ error }: { error: ApiFailure | Error | string | undefined | null }) {
  if (!error) return null;
  if (typeof error === "string" || !("status" in error)) {
    return (
      <div className="banner" role="alert">
        <Icon name="alert" />
        <div className="body">
          <span className="title">{typeof error === "string" ? error : error.message}</span>
        </div>
      </div>
    );
  }
  const b = error.body;
  const fromDb = b.source === "database";
  const title =
    b.code === "rejected_by_database"
      ? "Refused by the database"
      : b.code === "check_violation"
        ? "Rejected by a CHECK constraint"
        : fromDb
          ? "Database error"
          : b.source === "graph"
            ? "Graph database problem"
            : b.source === "auth"
              ? "Not allowed"
              : "Something went wrong";
  return (
    <div className={`banner${b.source === "auth" || b.source === "validation" ? " warn" : ""}`} role="alert">
      <Icon name={fromDb ? "ban" : "alert"} />
      <div className="body">
        <span className="title">{title}</span>
        <span>{b.error}</span>
        {(b.detail || b.hint) && <span className="meta">{[b.detail, b.hint].filter(Boolean).join(" · ")}</span>}
        <span className="meta mono">
          HTTP {error.status} · {b.code}
        </span>
      </div>
    </div>
  );
}

/** PostgreSQL committed; this says whether the Neo4j / Qdrant follow-up writes did too. */
export function SyncNotice({ sync }: { sync: SyncStatus | undefined }) {
  if (!sync || sync.errors.length === 0) return null;
  return (
    <div className="banner warn" role="status">
      <Icon name="alert" />
      <div className="body">
        <span className="title">Saved in PostgreSQL, but a projection did not update</span>
        {sync.errors.map((e) => (
          <span key={e}>{e}</span>
        ))}
        <span className="meta">PostgreSQL is the source of truth. Run the matching resync script to repair.</span>
      </div>
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={wide ? { maxWidth: 860 } : undefined}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

const SQL_WORDS =
  /\b(WITH|RECURSIVE|SELECT|DISTINCT|FROM|JOIN|LEFT|ON|WHERE|AND|OR|NOT|EXISTS|UNION|ALL|GROUP|BY|ORDER|HAVING|LIMIT|AS|IN|IS|NULL|COUNT|SUM|AVG|MAX|MIN|ROUND|OVER|PARTITION|RANK|MATCH|RETURN|DESC|ASC|CASE|WHEN|THEN|END|OFFSET|COALESCE)\b/g;

/** Read-only code with keywords picked out. Text is escaped by React, never injected as HTML. */
export function CodeBlock({ code }: { code: string }) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of code.matchAll(SQL_WORDS)) {
    if (m.index! > last) parts.push(code.slice(last, m.index));
    parts.push(
      <span className="kw" key={m.index}>
        {m[0]}
      </span>,
    );
    last = m.index! + m[0].length;
  }
  parts.push(code.slice(last));
  return <pre className="code-block">{parts}</pre>;
}

export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        {total === 0 ? "No rows" : `${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, total)} of ${total}`}
      </span>
      <span className="row">
        <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </button>
      </span>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} className={o.value === value ? "on" : ""} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
