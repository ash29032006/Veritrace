import pg from "pg";
import { postgresEnv } from "@/lib/env";

/*
 * PostgreSQL is the source of truth. One pool per process; in development
 * the pool is parked on globalThis so hot reloads do not leak connections.
 */

// NUMERIC arrives as a string by default (it can exceed a JS number). Every
// NUMERIC in this schema is NUMERIC(12,2) or (6,5), well inside double range.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));
// BIGINT ids stay far below 2^53 here, so parse them as plain numbers too.
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
// DATE columns stay as 'YYYY-MM-DD' strings instead of shifting through a timezone.
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

const globalForPg = globalThis as unknown as { veritracePool?: pg.Pool };

export function pool(): pg.Pool {
  if (!globalForPg.veritracePool) {
    globalForPg.veritracePool = new pg.Pool({
      connectionString: postgresEnv().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      application_name: "veritrace",
    });
  }
  return globalForPg.veritracePool;
}

export type Queryable = Pick<pg.PoolClient, "query">;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T[]> {
  const result = await client.query<T>(text, params);
  return result.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool(),
): Promise<T | undefined> {
  const rows = await query<T>(text, params, client);
  return rows[0];
}

/**
 * Run `work` in one transaction. `veritrace.user_id` is set transaction-locally
 * so the database's audit triggers can attribute every row they write.
 * Any thrown error rolls the whole unit back.
 */
export async function withTransaction<T>(
  userId: number | null,
  work: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query("BEGIN");
    if (userId !== null) {
      await client.query("SELECT set_config('veritrace.user_id', $1, true)", [String(userId)]);
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function closePool(): Promise<void> {
  await globalForPg.veritracePool?.end();
  globalForPg.veritracePool = undefined;
}
