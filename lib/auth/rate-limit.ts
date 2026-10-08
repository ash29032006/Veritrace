/*
 * A small in-memory limiter for sign-in attempts: at most MAX failures per
 * key in WINDOW_MS. Enough to stop a password-guessing loop against a
 * single-server demo; a multi-instance deployment would need a shared store.
 */

const WINDOW_MS = 5 * 60_000;
const MAX = 8;

const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  failures.set(key, kept);
  return kept;
}

export function isLocked(key: string): boolean {
  return recent(key, Date.now()).length >= MAX;
}

export function recordFailure(key: string): void {
  const now = Date.now();
  recent(key, now).push(now);
}

export function clearFailures(key: string): void {
  failures.delete(key);
}
