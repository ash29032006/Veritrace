import { requireUser } from "@/lib/auth/guard";
import { handle, json } from "@/lib/http";

/** GET /api/auth/me (any): who is signed in. 401 when nobody is. */
export const GET = handle(async () => json(await requireUser()));
