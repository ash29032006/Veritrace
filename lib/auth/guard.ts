import { getSessionUser } from "@/lib/auth/session";
import { ApiError } from "@/lib/http";
import type { Role, SessionUser } from "@/lib/types";

/**
 * First line of every Route Handler: who is calling, and may they?
 * With no roles listed, any signed-in user passes.
 */
export async function requireUser(...roles: Role[]): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) throw new ApiError(401, "Sign in to continue", "unauthenticated", { source: "auth" });
  if (roles.length > 0 && !roles.includes(user.role)) {
    throw new ApiError(403, `This action needs the ${roles.join(" or ")} role`, "forbidden", {
      source: "auth",
    });
  }
  return user;
}
