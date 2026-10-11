import "../scripts/_env";
import assert from "node:assert/strict";
import pg from "pg";

/*
 * Every database test runs inside a transaction that is rolled back, so the
 * suite can run against the real development database without changing it.
 * (Sequences still advance; that is harmless.)
 */

pg.types.setTypeParser(pg.types.builtins.NUMERIC, Number);
pg.types.setTypeParser(pg.types.builtins.INT8, Number);

let pool: pg.Pool | undefined;
export function testPool(): pg.Pool {
  return (pool ??= new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 }));
}
export async function closeTestPool() {
  await pool?.end();
}

export interface Fixture {
  db: pg.PoolClient;
  maker: number;
  regulator: number;
  q: <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
  one: <T extends pg.QueryResultRow = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T>;
  batch: (code: string, opts?: { date?: string; qty?: number }) => Promise<number>;
  compose: (parent: number, child: number, qty: number) => Promise<void>;
  outlet: (name: string) => Promise<number>;
  ship: (outlet: number, lines: [number, number][]) => Promise<number>;
}

const HASH = "$2b$10$abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz1";

export async function inRollback(test: (f: Fixture) => Promise<void>): Promise<void> {
  const db = await testPool().connect();
  try {
    await db.query("BEGIN");
    const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
    const one = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => {
      const rows = await q<T>(sql, params);
      assert.ok(rows[0], `expected a row from: ${sql}`);
      return rows[0];
    };
    const suffix = Math.random().toString(36).slice(2, 8);
    const maker = (await one<{ user_id: number }>(
      `INSERT INTO app_user (username, password_hash, role) VALUES ($1, $2, 'MANUFACTURER') RETURNING user_id`,
      [`t_maker_${suffix}`, HASH],
    )).user_id;
    const regulator = (await one<{ user_id: number }>(
      `INSERT INTO app_user (username, password_hash, role) VALUES ($1, $2, 'REGULATOR') RETURNING user_id`,
      [`t_reg_${suffix}`, HASH],
    )).user_id;
    await q(`SELECT set_config('veritrace.user_id', $1, true)`, [String(maker)]);

    const f: Fixture = {
      db,
      maker,
      regulator,
      q,
      one,
      batch: async (code, opts = {}) =>
        (await one<{ batch_id: number }>(
          `INSERT INTO batch (batch_code, product_name, manufacture_date, quantity_produced)
           VALUES ($1, 'Test product', $2, $3) RETURNING batch_id`,
          [`T${suffix.toUpperCase()}-${code}`, opts.date ?? "2026-01-01", opts.qty ?? 100],
        )).batch_id,
      compose: async (parent, child, qty) => {
        await q(`INSERT INTO batch_composition VALUES ($1, $2, $3)`, [parent, child, qty]);
      },
      outlet: async (name) =>
        (await one<{ outlet_id: number }>(`INSERT INTO outlet (outlet_name, city) VALUES ($1, 'Testville') RETURNING outlet_id`, [
          `${name} ${suffix}`,
        ])).outlet_id,
      ship: async (outlet, lines) => {
        const { shipment_id } = await one<{ shipment_id: number }>(
          `INSERT INTO shipment (outlet_id, dispatched_by) VALUES ($1, $2) RETURNING shipment_id`,
          [outlet, maker],
        );
        for (const [batch, qty] of lines) await q(`INSERT INTO shipment_line VALUES ($1, $2, $3)`, [shipment_id, batch, qty]);
        return shipment_id;
      },
    };
    await test(f);
  } finally {
    await db.query("ROLLBACK").catch(() => undefined);
    db.release();
  }
}

/** Expect `fn` to fail inside a SAVEPOINT (so the outer test transaction survives). */
export async function rejects(
  f: Fixture,
  fn: () => Promise<unknown>,
  expected: { code?: string; constraint?: string; message?: RegExp },
): Promise<void> {
  await f.db.query("SAVEPOINT expect_error");
  try {
    await fn();
    assert.fail("expected the database to reject this");
  } catch (err) {
    if (err instanceof assert.AssertionError) throw err;
    const e = err as pg.DatabaseError;
    if (expected.code) assert.equal(e.code, expected.code, e.message);
    if (expected.constraint) assert.equal(e.constraint, expected.constraint, e.message);
    if (expected.message) assert.match(e.message, expected.message);
  } finally {
    await f.db.query("ROLLBACK TO SAVEPOINT expect_error");
  }
}
