import { requireUser } from "@/lib/auth/guard";
import { driver } from "@/lib/db/neo4j";
import { query } from "@/lib/db/postgres";
import { qdrant } from "@/lib/db/qdrant";
import { handle, json } from "@/lib/http";

async function probe(fn: () => Promise<unknown>) {
  const started = performance.now();
  try {
    await fn();
    return { ok: true, ms: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, ms: Math.round(performance.now() - started), error: (err as Error).message };
  }
}

/** GET /api/health (any): can the app reach each of its three databases? */
export const GET = handle(async () => {
  await requireUser();
  const [postgres, neo4j, qdrantStatus] = await Promise.all([
    probe(() => query("SELECT 1")),
    probe(() => driver().verifyConnectivity()),
    probe(() => qdrant().getCollections()),
  ]);
  return json({ postgres, neo4j, qdrant: qdrantStatus });
});
