import neo4j, { type Driver, type QueryResult, type RecordShape } from "neo4j-driver";
import { neo4jEnv } from "@/lib/env";

/*
 * Neo4j holds a projection of lineage (WENT_INTO) and distribution
 * (SHIPPED_TO). PostgreSQL stays the source of truth; see lib/graph/sync.ts.
 */

const globalForNeo = globalThis as unknown as { veritraceDriver?: Driver };

export function driver(): Driver {
  if (!globalForNeo.veritraceDriver) {
    const env = neo4jEnv();
    globalForNeo.veritraceDriver = neo4j.driver(
      env.NEO4J_URI,
      neo4j.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD),
      {
        // ids and counts here are small; return plain JS numbers
        disableLosslessIntegers: true,
        connectionTimeout: 5_000,
        maxConnectionPoolSize: 20,
      },
    );
  }
  return globalForNeo.veritraceDriver;
}

export async function cypherRead<T extends RecordShape = RecordShape>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result: QueryResult<T> = await driver().executeQuery<QueryResult<T>>(cypher, params, {
    routing: neo4j.routing.READ,
  });
  return result.records.map((r) => r.toObject());
}

export async function cypherWrite<T extends RecordShape = RecordShape>(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<T[]> {
  const result: QueryResult<T> = await driver().executeQuery<QueryResult<T>>(cypher, params, {
    routing: neo4j.routing.WRITE,
  });
  return result.records.map((r) => r.toObject());
}

/** Bolt sends whole numbers as ints only when told to; ids must match the integer-typed nodes. */
export const int = (n: number) => neo4j.int(n);

export async function closeDriver(): Promise<void> {
  await globalForNeo.veritraceDriver?.close();
  globalForNeo.veritraceDriver = undefined;
}
