/*
 * npm run graph:setup
 * Applies db/neo4j/constraints.cypher (constraints and indexes). Idempotent.
 */
import "./_env";
import { readFileSync } from "node:fs";
import { closeDriver, cypherWrite } from "@/lib/db/neo4j";

async function main() {
  const statements = readFileSync("db/neo4j/constraints.cypher", "utf8")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await cypherWrite(statement);
    console.log("ok ", statement.split("\n")[0]);
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(closeDriver);
