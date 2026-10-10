"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { Icon, type IconName } from "@/components/Icon";
import { ToastProvider } from "@/components/Toast";
import { Loading } from "@/components/ui";
import { api } from "@/lib/client/api";
import type { SessionUser } from "@/lib/types";

const SessionContext = createContext<SessionUser | null>(null);

/** The signed-in user. Only rendered inside AppShell, after /api/auth/me succeeded. */
export function useSession(): SessionUser {
  const user = useContext(SessionContext);
  if (!user) throw new Error("useSession outside AppShell");
  return user;
}

const NAV: { href: string; label: string; icon: IconName; title: string }[] = [
  { href: "/batches", label: "Batches", icon: "box", title: "Batches" },
  { href: "/shipments", label: "Shipments", icon: "truck", title: "Shipments" },
  { href: "/recalls", label: "Recalls", icon: "alert", title: "Recalls" },
  { href: "/exposure", label: "Exposure", icon: "graph", title: "Exposure report" },
  { href: "/complaints", label: "Complaints & audit", icon: "chat", title: "Complaints and audit" },
];

interface Health {
  postgres: { ok: boolean; ms: number };
  neo4j: { ok: boolean; ms: number; error?: string };
  qdrant: { ok: boolean; ms: number; error?: string };
}

function HealthPanel() {
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Health>("/api/health")
        .then((h) => alive && setHealth(h))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const rows: [string, string, keyof Health][] = [
    ["PostgreSQL", "source of truth", "postgres"],
    ["Neo4j", "lineage graph", "neo4j"],
    ["Qdrant", "vectors", "qdrant"],
  ];
  return (
    <div className="health" aria-label="Database status">
      <span className="label" style={{ padding: 0 }}>
        Databases
      </span>
      {rows.map(([name, role, key]) => {
        const h = health?.[key];
        const err = h && "error" in h ? h.error : undefined;
        return (
          <div className="health-row" key={key} title={err ?? role}>
            <span className={`dot ${!h ? "" : h.ok ? "ok" : "bad"}`} />
            <span>{name}</span>
            <span className="num">{!h ? "…" : h.ok ? `${h.ms} ms` : "down"}</span>
          </div>
        );
      })}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    api<SessionUser>("/api/auth/me")
      .then(setUser)
      .catch(() => router.replace(`/login?next=${encodeURIComponent(pathname)}`));
    // only on first load; the session does not change while navigating
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function signOut() {
    await api("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    router.replace("/login");
  }

  const current = NAV.find((n) => pathname.startsWith(n.href));

  return (
    <ToastProvider>
      <div className="shell">
        <header className="topbar">
          <Link href="/batches" className="brand">
            <span className="brand-mark" aria-hidden="true" />
            Veritrace
          </Link>
          {current && <span className="crumb">{current.title}</span>}
          <div className="spacer" />
          {user && (
            <div className="who">
              <span className={`pill ${user.role === "MANUFACTURER" ? "accent" : "ok"}`}>
                {user.role === "MANUFACTURER" ? "Manufacturer" : "Regulator"}
              </span>
              <span className="username">{user.username}</span>
              <button className="btn small ghost" onClick={signOut} title="Sign out">
                <Icon name="logout" size={16} />
                Sign out
              </button>
            </div>
          )}
        </header>
        <div className="frame">
          <nav className="sidebar" aria-label="Main">
            <span className="label">Workspace</span>
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className={`nav-link${pathname.startsWith(n.href) ? " on" : ""}`}>
                <Icon name={n.icon} />
                {n.label}
              </Link>
            ))}
            {user && <HealthPanel />}
          </nav>
          <main className="main">
            {user ? <SessionContext.Provider value={user}>{children}</SessionContext.Provider> : <Loading label="Checking your session" />}
          </main>
        </div>
      </div>
    </ToastProvider>
  );
}
