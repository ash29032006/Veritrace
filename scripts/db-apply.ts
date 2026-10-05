/*
 * npm run db:schema    ->  01_schema.sql, 02_functions.sql
 * npm run db:indexes   ->  04_indexes.sql
 *
 * Applies SQL files from db/postgres in the order given. Each file runs as
 * one multi-statement query, so a failure stops at the first bad statement.
 * Set TARGET_DATABASE_URL to aim at a different database (the benchmark does).
 */
import "./_env";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export async function applySqlFiles(connectionString: string, files: string[]): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  client.on("notice", () => undefined); // DROP ... IF EXISTS notices are noise here
  try {
    for (const file of files) {
      const sql = readFileSync(join("db", "postgres", file), "utf8");
      const started = performance.now();
      await client.query(sql);
      console.log(`applied ${file} in ${Math.round(performance.now() - started)} ms`);
    }
  } finally {
    await client.end();
  }
}

const isMain = process.argv[1]?.endsWith("db-apply.ts");
if (isMain) {
  const files = process.argv.slice(2);
  const url = process.env.TARGET_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  if (files.length === 0) throw new Error("usage: tsx scripts/db-apply.ts <file.sql> [...]");
  applySqlFiles(url, files).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
