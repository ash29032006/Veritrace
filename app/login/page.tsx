"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { ErrorBanner } from "@/components/ui";
import { api, type ApiFailure } from "@/lib/client/api";

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiFailure>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await api("/api/auth/login", { method: "POST", json: { username, password } });
      const next = new URLSearchParams(window.location.search).get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/batches");
    } catch (err) {
      setError(err as ApiFailure);
      setBusy(false);
    }
  }

  return (
    <div className="login-page">
      <form className="card login-card" onSubmit={submit}>
        <span className="brand">
          <span className="brand-mark" aria-hidden="true" />
          Veritrace
        </span>
        <h1>Sign in</h1>
        <p className="lede">Batch provenance and recall cascade engine.</p>
        <div className="fields">
          <label className="field">
            <span>Username</span>
            <input
              className="input"
              autoComplete="username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoFocus
              required
            />
          </label>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <ErrorBanner error={error} />
          <button className="btn primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </div>
        <div className="roles">
          <div className="role-tile">
            <b>Manufacturer</b>
            Registers batches, ships, initiates recalls
          </div>
          <div className="role-tile">
            <b>Regulator</b>
            Traces exposure, reviews complaints, closes recalls
          </div>
        </div>
      </form>
    </div>
  );
}
