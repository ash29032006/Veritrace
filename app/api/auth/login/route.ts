import { dummyHash, verifyPassword } from "@/lib/auth/password";
import { clearFailures, isLocked, recordFailure } from "@/lib/auth/rate-limit";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { writeAudit } from "@/lib/data/audit";
import { queryOne } from "@/lib/db/postgres";
import { ApiError, handle, json, readJson } from "@/lib/http";
import type { Role, SessionUser } from "@/lib/types";
import { loginSchema } from "@/lib/validation";

/** POST /api/auth/login (public): bcrypt compare, then a server-side session. */
export const POST = handle(async (req) => {
  const { username, password } = loginSchema.parse(await readJson(req));
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "local";
  const key = `${ip}:${username.toLowerCase()}`;

  if (isLocked(key)) {
    throw new ApiError(429, "Too many failed attempts. Wait five minutes and try again.", "rate_limited", {
      source: "auth",
    });
  }

  const user = await queryOne<{ user_id: number; username: string; role: Role; password_hash: string }>(
    `SELECT user_id, username, role, password_hash FROM app_user WHERE lower(username) = lower($1)`,
    [username],
  );
  // compare even when the user does not exist, so timing reveals nothing
  const ok = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
  if (!user || !ok) {
    recordFailure(key);
    throw new ApiError(401, "Invalid username or password", "invalid_credentials", { source: "auth" });
  }

  clearFailures(key);
  const { token, expires } = await createSession(user.user_id);
  await setSessionCookie(token, expires);
  await writeAudit({ action: "USER_LOGIN", entity: "app_user", entityId: user.user_id, userId: user.user_id });

  const body: SessionUser = { userId: user.user_id, username: user.username, role: user.role };
  return json(body);
});
