/*
 * Requirement 12: validation at the database level.
 * Each test inserts a row the application would also block, but sends it
 * straight to PostgreSQL, proving the table itself refuses it.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";
import { closeTestPool, inRollback, rejects } from "./helpers";

after(closeTestPool);

describe("CHECK constraints and keys", () => {
  test("TC-01 a role outside MANUFACTURER / REGULATOR is rejected", () =>
    inRollback(async (f) => {
      await rejects(
        f,
        () => f.q(`INSERT INTO app_user (username, password_hash, role) VALUES ('x1', '$2b$10$' || repeat('a', 53), 'ADMIN')`),
        { code: "23514", constraint: "chk_user_role" },
      );
    }));

  test("TC-02 a plain text password is rejected (only bcrypt hashes fit)", () =>
    inRollback(async (f) => {
      await rejects(f, () => f.q(`INSERT INTO app_user (username, password_hash, role) VALUES ('x2', 'hunter2', 'REGULATOR')`), {
        code: "23514",
        constraint: "chk_user_password_is_bcrypt",
      });
    }));

  test("TC-03 a batch with zero or negative quantity is rejected", () =>
    inRollback(async (f) => {
      await rejects(f, () => f.batch("NEG", { qty: -5 }), { code: "23514", constraint: "chk_batch_qty" });
    }));

  test("TC-04 a batch manufactured in the future is rejected", () =>
    inRollback(async (f) => {
      await rejects(f, () => f.batch("FUT", { date: "2099-01-01" }), { code: "23514", constraint: "chk_batch_date" });
    }));

  test("TC-05 a lowercase or malformed batch code is rejected", () =>
    inRollback(async (f) => {
      await rejects(
        f,
        () => f.q(`INSERT INTO batch (batch_code, product_name, manufacture_date, quantity_produced) VALUES ('bad code', 'p', '2026-01-01', 1)`),
        { code: "23514", constraint: "chk_batch_code_format" },
      );
    }));

  test("TC-06 a duplicate batch code is rejected", () =>
    inRollback(async (f) => {
      const id = await f.batch("DUP");
      const { batch_code } = await f.one<{ batch_code: string }>(`SELECT batch_code FROM batch WHERE batch_id = $1`, [id]);
      await rejects(
        f,
        () => f.q(`INSERT INTO batch (batch_code, product_name, manufacture_date, quantity_produced) VALUES ($1, 'p', '2026-01-01', 1)`, [batch_code]),
        { code: "23505" },
      );
    }));

  test("TC-07 a batch cannot be an input to itself (trigger first, CHECK as the backstop)", () =>
    inRollback(async (f) => {
      const b = await f.batch("SELF");
      // BEFORE triggers run before CHECK constraints, so the cycle guard answers first...
      await rejects(f, () => f.compose(b, b, 1), { code: "P0001", message: /lineage cycle/ });
      // ...and with the trigger out of the way the CHECK still refuses it
      await f.q(`ALTER TABLE batch_composition DISABLE TRIGGER trg_guard_composition`);
      await rejects(f, () => f.compose(b, b, 1), { code: "23514", constraint: "chk_bc_no_self_loop" });
    }));

  test("TC-08 an outlet email without @ and a domain is rejected", () =>
    inRollback(async (f) => {
      await rejects(f, () => f.q(`INSERT INTO outlet (outlet_name, city, contact_email) VALUES ('x', 'y', 'not-an-email')`), {
        code: "23514",
        constraint: "chk_outlet_email",
      });
    }));

  test("TC-09 a shipment line for a batch that does not exist is rejected (foreign key)", () =>
    inRollback(async (f) => {
      const o = await f.outlet("FK");
      await rejects(f, () => f.ship(o, [[999_999_999, 1]]), { code: "23503" });
    }));

  test("TC-10 a similarity score above 1 is rejected (constraint added by ALTER)", () =>
    inRollback(async (f) => {
      const b = await f.batch("SIM");
      await rejects(
        f,
        () => f.q(`INSERT INTO complaint (complaint_text, matched_batch_id, similarity_score) VALUES ('a long enough text', $1, 1.5)`, [b]),
        { code: "23514", constraint: "chk_complaint_score" },
      );
    }));

  test("TC-11 a score without a matched batch is rejected", () =>
    inRollback(async (f) => {
      await rejects(f, () => f.q(`INSERT INTO complaint (complaint_text, similarity_score) VALUES ('a long enough text', 0.5)`), {
        code: "23514",
        constraint: "chk_complaint_match_pair",
      });
    }));

  test("TC-12 a batch that has been shipped cannot be deleted (ON DELETE RESTRICT)", () =>
    inRollback(async (f) => {
      const b = await f.batch("RES");
      await f.ship(await f.outlet("RES"), [[b, 1]]);
      // RESTRICT (unlike NO ACTION) reports restrict_violation, 23001
      await rejects(f, () => f.q(`DELETE FROM batch WHERE batch_id = $1`, [b]), { code: "23001" });
    }));

  test("TC-13 the schema has the expected shape", () =>
    inRollback(async (f) => {
      const { n } = await f.one<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      );
      assert.equal(n, 12);
      const checks = await f.q<{ conname: string }>(`SELECT conname FROM pg_constraint WHERE contype = 'c' ORDER BY conname`);
      assert.ok(checks.length >= 20, `expected at least 20 CHECK constraints, found ${checks.length}`);
    }));
});
