import { z } from "zod";

/*
 * Every setting comes from the environment (.env.local in development).
 * Each group is validated the first time it is used, so a missing Qdrant
 * key does not stop the batch screens from working, but the first
 * complaint submission fails with a message naming the missing variable.
 */

/** A required setting is missing. The API reports this as 503, naming the variable. */
export class ConfigError extends Error {}

function read<T extends z.ZodRawShape>(group: string, shape: T): z.infer<z.ZodObject<T>> {
  const parsed = z.object(shape).safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
    throw new ConfigError(`${group} is not configured: set ${missing} in .env.local (see .env.example)`);
  }
  return parsed.data;
}

const nonEmpty = z.string().trim().min(1);

let pg: { DATABASE_URL: string } | undefined;
export function postgresEnv() {
  return (pg ??= read("PostgreSQL", { DATABASE_URL: nonEmpty }));
}

let neo: { NEO4J_URI: string; NEO4J_USER: string; NEO4J_PASSWORD: string } | undefined;
export function neo4jEnv() {
  return (neo ??= read("Neo4j", {
    NEO4J_URI: nonEmpty,
    NEO4J_USER: nonEmpty,
    NEO4J_PASSWORD: nonEmpty,
  }));
}

let qd: { QDRANT_URL: string; QDRANT_API_KEY: string } | undefined;
export function qdrantEnv() {
  return (qd ??= read("Qdrant", { QDRANT_URL: nonEmpty, QDRANT_API_KEY: nonEmpty }));
}

let emb: { EMBEDDING_MODEL: string; EMBEDDING_DIM: number } | undefined;
export function embeddingEnv() {
  return (emb ??= read("Embedding", {
    EMBEDDING_MODEL: z.string().trim().min(1).default("Xenova/all-MiniLM-L6-v2"),
    EMBEDDING_DIM: z.coerce.number().int().positive().default(384),
  }));
}

let sess: { SESSION_SECRET: string } | undefined;
export function sessionEnv() {
  return (sess ??= read("Sessions", {
    SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  }));
}
