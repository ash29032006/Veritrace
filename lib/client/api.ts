"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiErrorBody } from "@/lib/types";

/*
 * The browser's only way to reach data: fetch the Route Handlers.
 * No database driver is ever imported on this side.
 */

export class ApiFailure extends Error {
  constructor(
    public status: number,
    public body: ApiErrorBody,
  ) {
    super(body.error || `Request failed (${status})`);
  }
}

export async function api<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(path, {
    ...rest,
    cache: "no-store",
    headers: { ...(json !== undefined ? { "Content-Type": "application/json" } : {}), ...rest.headers },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname)}`);
  }
  if (!res.ok) {
    throw new ApiFailure(res.status, {
      error: (data as ApiErrorBody).error ?? `Request failed (${res.status})`,
      code: (data as ApiErrorBody).code ?? "error",
      ...(data as Partial<ApiErrorBody>),
    });
  }
  return data as T;
}

export function useApi<T>(path: string | null) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<ApiFailure | undefined>(undefined);
  const [loading, setLoading] = useState(path !== null);
  const latest = useRef(0);

  const reload = useCallback(async () => {
    if (path === null) {
      setLoading(false);
      return;
    }
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const value = await api<T>(path);
      if (ticket === latest.current) {
        setData(value);
        setError(undefined);
      }
    } catch (err) {
      if (ticket === latest.current) setError(err as ApiFailure);
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, error, loading, reload, setData };
}
