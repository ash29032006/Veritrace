import { createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { query, queryOne } from "@/lib/db/postgres";
import { sessionEnv } from "@/lib/env";
import type { Role, SessionUser } from "@/lib/types";

/*
 * Session-based auth. The browser holds a random 256-bit token in an
 * httpOnly, sameSite=lax cookie. The database stores only an HMAC of that
 * token (app_session.token_hash), so a copy of the table cannot be replayed
 * as a cookie without SESSION_SECRET.
 */

export const SESSION_COOKIE = "vt_session";
const SESSION_HOURS = 8;

function hashToken(token: string): string {
  return createHmac("sha256", sessionEnv().SESSION_SECRET).update(token).digest("hex");
}

export async function createSession(userId: number): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString("base64url");
  const row = await queryOne<{ expires_at: Date }>(
    `INSERT INTO app_session (token_hash, user_id, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))
     RETURNING expires_at`,
    [hashToken(token), userId, SESSION_HOURS],
  );
  // opportunistic sweep of expired sessions
  await query("DELETE FROM app_session WHERE expires_at < now()");
  return { token, expires: row!.expires_at };
}

export async function setSessionCookie(token: string, expires: Date): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires,
  });
}

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const row = await queryOne<{ user_id: number; username: string; role: Role }>(
    `SELECT u.user_id, u.username, u.role
       FROM app_session s
       JOIN app_user u ON u.user_id = s.user_id
      WHERE s.token_hash = $1
        AND s.expires_at > now()`,
    [hashToken(token)],
  );
  return row ? { userId: row.user_id, username: row.username, role: row.role } : null;
}

export async function destroySession(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await query("DELETE FROM app_session WHERE token_hash = $1", [hashToken(token)]);
  jar.delete(SESSION_COOKIE);
}
