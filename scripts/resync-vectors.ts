/*
 * npm run vectors:resync
 *
 * Rebuilds both Qdrant collections from PostgreSQL: recreates them, embeds
 * every batch description and every complaint, and upserts the points with
 * ids equal to their primary keys. Safe to run any time.
 */
import "./_env";
import { BATCH_COLLECTION, COMPLAINT_COLLECTION, ensureCollections, qdrant } from "@/lib/db/qdrant";
import { closePool, query } from "@/lib/db/postgres";
import { embed } from "@/lib/embedding";
import { type BatchForVector, upsertBatches, upsertComplaint } from "@/lib/vector";

async function main() {
  const started = performance.now();
  const client = qdrant();

  for (const name of [BATCH_COLLECTION, COMPLAINT_COLLECTION]) {
    if ((await client.collectionExists(name)).exists) await client.deleteCollection(name);
  }
  await ensureCollections();

  const batches = await query<BatchForVector>(
    `SELECT batch_id, batch_code, product_name, description, status FROM batch ORDER BY batch_id`,
  );
  for (let i = 0; i < batches.length; i += 64) await upsertBatches(batches.slice(i, i + 64));

  const complaints = await query<{
    complaint_id: number;
    complaint_text: string;
    outlet_id: number | null;
    matched_batch_id: number | null;
  }>(`SELECT complaint_id, complaint_text, outlet_id, matched_batch_id FROM complaint ORDER BY complaint_id`);
  const vectors = await embed(complaints.map((c) => c.complaint_text));
  for (const [i, c] of complaints.entries()) {
    await upsertComplaint(c.complaint_id, vectors[i]!, { outlet_id: c.outlet_id, matched_batch_id: c.matched_batch_id });
  }

  const [b, c] = await Promise.all([client.count(BATCH_COLLECTION, { exact: true }), client.count(COMPLAINT_COLLECTION, { exact: true })]);
  console.table({
    [BATCH_COLLECTION]: { postgres: batches.length, qdrant: b.count },
    [COMPLAINT_COLLECTION]: { postgres: complaints.length, qdrant: c.count },
  });
  console.log(`vectors rebuilt in ${Math.round(performance.now() - started)} ms`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
