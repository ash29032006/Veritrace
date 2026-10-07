import { QdrantClient } from "@qdrant/js-client-rest";
import { embeddingEnv, qdrantEnv } from "@/lib/env";

/*
 * Qdrant holds the vectors. Two collections, both cosine distance:
 *
 *   batch_descriptions  one point per batch, id = batch_id
 *                       payload: batch_id, batch_code, product_name, status
 *   complaints          one point per complaint, id = complaint_id
 *                       payload: complaint_id, outlet_id, matched_batch_id
 *
 * The text itself stays in PostgreSQL; Qdrant only knows ids and the
 * metadata needed to filter a search.
 */

export const BATCH_COLLECTION = "batch_descriptions";
export const COMPLAINT_COLLECTION = "complaints";

const globalForQdrant = globalThis as unknown as { veritraceQdrant?: QdrantClient };

export function qdrant(): QdrantClient {
  if (!globalForQdrant.veritraceQdrant) {
    const env = qdrantEnv();
    const url = new URL(env.QDRANT_URL);
    globalForQdrant.veritraceQdrant = new QdrantClient({
      url: env.QDRANT_URL,
      // Qdrant Cloud serves REST on 6333; a bare https URL would default to 443
      port: url.port ? Number(url.port) : 6333,
      apiKey: env.QDRANT_API_KEY,
      checkCompatibility: false,
    });
  }
  return globalForQdrant.veritraceQdrant;
}

/** Create both collections and their payload indexes if they are missing. Idempotent. */
export async function ensureCollections(): Promise<void> {
  const client = qdrant();
  const size = embeddingEnv().EMBEDDING_DIM;
  const existing = new Set((await client.getCollections()).collections.map((c) => c.name));

  if (!existing.has(BATCH_COLLECTION)) {
    await client.createCollection(BATCH_COLLECTION, {
      vectors: { size, distance: "Cosine" },
      hnsw_config: { m: 16, ef_construct: 100 },
    });
  }
  if (!existing.has(COMPLAINT_COLLECTION)) {
    await client.createCollection(COMPLAINT_COLLECTION, {
      vectors: { size, distance: "Cosine" },
      hnsw_config: { m: 16, ef_construct: 100 },
    });
  }

  // Payload indexes make filtered search (e.g. "only batches shipped to
  // this outlet") fast; Qdrant applies the filter inside the HNSW walk.
  await client.createPayloadIndex(BATCH_COLLECTION, { field_name: "batch_id", field_schema: "integer", wait: true });
  await client.createPayloadIndex(BATCH_COLLECTION, { field_name: "status", field_schema: "keyword", wait: true });
  await client.createPayloadIndex(COMPLAINT_COLLECTION, { field_name: "outlet_id", field_schema: "integer", wait: true });
}
