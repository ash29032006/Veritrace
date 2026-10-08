import { destroySession, getSessionUser } from "@/lib/auth/session";
import { writeAudit } from "@/lib/data/audit";
import { handle, json } from "@/lib/http";

/** POST /api/auth/logout (any): delete the server-side session and the cookie. */
export const POST = handle(async () => {
  const user = await getSessionUser();
  await destroySession();
  if (user) {
    await writeAudit({ action: "USER_LOGOUT", entity: "app_user", entityId: user.userId, userId: user.userId });
  }
  return json({ ok: true });
});
