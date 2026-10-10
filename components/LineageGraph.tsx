"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fmtNum } from "@/lib/format";
import type { ExposureRow, LineageEdge, LineageNode } from "@/lib/types";

/*
 * Lineage drawn as columns: each column is one WENT_INTO hop, so depth is
 * read from position (and the "hop n" header), never from colour. Status
 * uses the border colour AND a text suffix; the source batch is the violet
 * one. Hover a node to light up its links.
 */

const COL_W = 182;
const NODE_W = 150;
const NODE_H = 38;
const GAP = 12;
// outlets can number in the dozens: shorter rows keep the column readable
const OUT_H = 32;
const OUT_GAP = 5;
const PAD_X = 18;
const PAD_TOP = 34;

interface Placed {
  key: string;
  h: number;
  kind: "batch" | "outlet";
  label: string;
  sub: string;
  col: number;
  x: number;
  y: number;
  status?: LineageNode["status"];
  source?: boolean;
}

const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function LineageGraph({
  source,
  nodes,
  edges,
  outlets = [],
  direction,
}: {
  source: LineageNode;
  nodes: LineageNode[];
  edges: LineageEdge[];
  outlets?: ExposureRow[];
  direction: "forward" | "backward";
}) {
  const [hover, setHover] = useState<string | null>(null);
  const wrap = useRef<HTMLDivElement>(null);

  const layout = useMemo(() => {
    const all = [{ ...source, hopDepth: 0 }, ...nodes.filter((n) => n.batchId !== source.batchId)];
    const maxDepth = Math.max(0, ...all.map((n) => n.hopDepth));
    const colOf = (n: LineageNode) => (direction === "forward" ? n.hopDepth : maxDepth - n.hopDepth);

    // group by column, then order each column by the average row of its
    // predecessors (one barycentre pass keeps most edges from crossing)
    const cols = new Map<number, LineageNode[]>();
    for (const n of all) cols.set(colOf(n), [...(cols.get(colOf(n)) ?? []), n]);
    const row = new Map<number, number>();
    const preds = new Map<number, number[]>();
    for (const e of edges) preds.set(e.to, [...(preds.get(e.to) ?? []), e.from]);
    const colCount = maxDepth + 1;
    for (let c = 0; c < colCount; c++) {
      const list = cols.get(c) ?? [];
      const score = (n: LineageNode) => {
        const ps = (preds.get(n.batchId) ?? []).map((p) => row.get(p)).filter((v): v is number => v !== undefined);
        return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : Number.MAX_SAFE_INTEGER;
      };
      list.sort((a, b) => score(a) - score(b) || a.batchCode.localeCompare(b.batchCode));
      list.forEach((n, i) => row.set(n.batchId, i));
      cols.set(c, list);
    }

    // outlets: one node each, in the column after the last batch column
    const outletMap = new Map<number, { name: string; city: string; units: number; batches: Set<number>; minHop: number }>();
    for (const o of outlets) {
      const cur = outletMap.get(o.outletId) ?? { name: o.outletName, city: o.city, units: 0, batches: new Set(), minHop: o.hopDepth };
      cur.units += o.quantity;
      cur.batches.add(o.affectedBatchId);
      cur.minHop = Math.min(cur.minHop, o.hopDepth);
      outletMap.set(o.outletId, cur);
    }
    const outletList = [...outletMap.entries()].sort(
      ([, a], [, b]) => a.minHop - b.minHop || a.name.localeCompare(b.name),
    );

    const batchSpan = Math.max(...[...cols.values()].map((l) => l.length), 1) * (NODE_H + GAP);
    const outletSpan = outletList.length * (OUT_H + OUT_GAP);
    const span = Math.max(batchSpan, outletSpan);
    const height = PAD_TOP + span + 10;
    // every column is centred on the same middle line
    const yFor = (i: number, count: number, rowH = NODE_H + GAP) => PAD_TOP + (span - count * rowH) / 2 + i * rowH;

    const placed: Placed[] = [];
    for (const [c, list] of cols) {
      list.forEach((n, i) =>
        placed.push({
          key: `b${n.batchId}`,
          h: NODE_H,
          kind: "batch",
          label: n.batchCode,
          sub: n.productName,
          col: c,
          x: PAD_X + c * COL_W,
          y: yFor(i, list.length),
          status: n.status,
          source: n.batchId === source.batchId,
        }),
      );
    }
    const outletCol = colCount;
    outletList.forEach(([id, o], i) =>
      placed.push({
        key: `o${id}`,
        h: OUT_H,
        kind: "outlet",
        label: o.name,
        sub: `${o.city} · ${fmtNum(o.units)} units`,
        col: outletCol,
        x: PAD_X + outletCol * COL_W,
        y: yFor(i, outletList.length, OUT_H + OUT_GAP),
      }),
    );

    const byKey = new Map(placed.map((p) => [p.key, p]));
    const links: { from: string; to: string; title: string }[] = edges
      .filter((e) => byKey.has(`b${e.from}`) && byKey.has(`b${e.to}`))
      .map((e) => ({ from: `b${e.from}`, to: `b${e.to}`, title: `${fmtNum(e.quantityUsed)} units used` }));
    const seen = new Set<string>();
    for (const o of outlets) {
      const k = `b${o.affectedBatchId}->o${o.outletId}`;
      if (seen.has(k) || !byKey.has(`b${o.affectedBatchId}`)) continue;
      seen.add(k);
      links.push({ from: `b${o.affectedBatchId}`, to: `o${o.outletId}`, title: "shipped" });
    }

    const columns = outletList.length ? colCount + 1 : colCount;
    const headers = Array.from({ length: columns }, (_, c) => {
      if (c === outletCol && outletList.length) return "outlets";
      const depth = direction === "forward" ? c : maxDepth - c;
      return depth === 0 ? "source" : direction === "forward" ? `hop ${depth}` : `${depth} up`;
    });

    return {
      placed,
      byKey,
      links,
      headers,
      width: PAD_X * 2 + (columns - 1) * COL_W + NODE_W,
      height,
    };
  }, [source, nodes, edges, outlets, direction]);

  // open with the source batch in view, not the top of a long outlet column
  useEffect(() => {
    const el = wrap.current;
    const src = layout.placed.find((p) => p.source);
    if (el && src) el.scrollTop = Math.max(0, src.y + src.h / 2 - el.clientHeight / 2);
  }, [layout]);

  const linked = (key: string) =>
    hover === null || hover === key || layout.links.some((l) => (l.from === hover && l.to === key) || (l.to === hover && l.from === key));

  return (
    <>
      <div className="graph-wrap" ref={wrap}>
        <svg width={layout.width} height={layout.height} role="img" aria-label={`Lineage of ${source.batchCode}`}>
          {layout.headers.map((h, c) => (
            <text key={h + c} x={PAD_X + c * COL_W + NODE_W / 2} y={20} textAnchor="middle" fontSize={10.5} fontWeight={700} fill="#948fb8" letterSpacing="0.08em">
              {h.toUpperCase()}
            </text>
          ))}
          {layout.links.map((l) => {
            const a = layout.byKey.get(l.from)!;
            const b = layout.byKey.get(l.to)!;
            const x1 = a.x + NODE_W;
            const y1 = a.y + a.h / 2;
            const x2 = b.x;
            const y2 = b.y + b.h / 2;
            const mid = (x1 + x2) / 2;
            const on = hover !== null && (l.from === hover || l.to === hover);
            return (
              <path
                key={`${l.from}-${l.to}`}
                d={`M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`}
                fill="none"
                stroke={on ? "#7c3aed" : "#b9b0dc"}
                strokeWidth={on ? 2 : 1.3}
                opacity={hover === null || on ? 1 : 0.25}
              >
                <title>{l.title}</title>
              </path>
            );
          })}
          {layout.placed.map((p) => {
            const stroke = p.source
              ? "#7c3aed"
              : p.kind === "outlet"
                ? "#c9bff0"
                : p.status === "RECALLED"
                  ? "#e0466a"
                  : p.status === "QUARANTINED"
                    ? "#f59e0b"
                    : "#d9d1f3";
            const fill = p.source ? "#efe7fe" : p.kind === "outlet" ? "#f6f3ff" : "#ffffff";
            const statusText = p.status === "RECALLED" ? " · recalled" : p.status === "QUARANTINED" ? " · on hold" : "";
            return (
              <g
                key={p.key}
                transform={`translate(${p.x},${p.y})`}
                opacity={linked(p.key) ? 1 : 0.35}
                onMouseEnter={() => setHover(p.key)}
                onMouseLeave={() => setHover(null)}
                style={{ cursor: "default" }}
              >
                <title>{`${p.label} · ${p.sub}${statusText}`}</title>
                <rect width={NODE_W} height={p.h} rx={9} fill={fill} stroke={stroke} strokeWidth={p.source || p.status === "RECALLED" ? 1.8 : 1.2} strokeDasharray={p.kind === "outlet" ? "4 3" : undefined} />
                <text x={10} y={p.kind === "batch" ? 16 : 13.5} fontSize={p.kind === "batch" ? 11.5 : 10.5} fontWeight={700} fill="#211d3d" fontFamily={p.kind === "batch" ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined}>
                  {short(p.label, p.kind === "batch" ? 19 : 24)}
                </text>
                <text x={10} y={p.kind === "batch" ? 30 : 26} fontSize={p.kind === "batch" ? 10 : 9.5} fill={p.status === "RECALLED" ? "#c2334f" : "#6e6a88"}>
                  {short(p.sub + statusText, 27)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="graph-legend">
        <span>
          <i style={{ borderColor: "#7c3aed", background: "#efe7fe" }} /> source batch
        </span>
        <span>
          <i style={{ borderColor: "#e0466a" }} /> recalled
        </span>
        <span>
          <i style={{ borderColor: "#f59e0b" }} /> on hold
        </span>
        {outlets.length > 0 && (
          <span>
            <i style={{ borderColor: "#c9bff0", borderStyle: "dashed", background: "#f6f3ff" }} /> outlet
          </span>
        )}
        <span>columns = WENT_INTO hops · hover a node to trace it</span>
      </div>
    </>
  );
}
