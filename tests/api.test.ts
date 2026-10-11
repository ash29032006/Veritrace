/*
 * The API's translation of database refusals into HTTP: the property that
 * lets the UI show "refused by the database" instead of a generic 500.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { DatabaseError } from "pg";
import { z } from "zod";
import { toApiError } from "@/lib/http";
import { batchCreateSchema, shipmentCreateSchema } from "@/lib/validation";

function dbError(code: string, extra: Partial<DatabaseError> = {}) {
  const e = new DatabaseError("Batch X is RECALLED and cannot be shipped", 0, "error");
  Object.assign(e, { code, ...extra });
  return e;
}

describe("HTTP mapping of database errors", () => {
  test("TC-36 a trigger refusal (P0001) becomes 409 and keeps the database's message", () => {
    const e = toApiError(dbError("P0001", { detail: "Rejected by trigger trg_block_unsafe_shipment on shipment_line." }));
    assert.equal(e.status, 409);
    assert.equal(e.message, "Batch X is RECALLED and cannot be shipped");
    assert.equal(e.extra.source, "database");
    assert.match(e.extra.detail ?? "", /trg_block_unsafe_shipment/);
  });

  test("TC-37 a CHECK violation becomes 422 with a readable message", () => {
    const e = toApiError(dbError("23514", { constraint: "chk_batch_date" }));
    assert.equal(e.status, 422);
    assert.equal(e.message, "Manufacture date cannot be in the future.");
  });

  test("TC-38 a procedure's role check (42501) becomes 403", () => {
    assert.equal(toApiError(dbError("42501")).status, 403);
  });

  test("TC-39 anything unexpected becomes a 500 that leaks no internals", () => {
    const e = toApiError(new Error("connection string postgres://secret@host"));
    assert.equal(e.status, 500);
    assert.doesNotMatch(e.message, /secret/);
  });

  test("TC-40 invalid input is a 400 naming the field", () => {
    const parsed = z.object({ quantity: z.number().positive() }).safeParse({ quantity: -1 });
    assert.ok(!parsed.success);
    const e = toApiError(parsed.error);
    assert.equal(e.status, 400);
    assert.match(e.message, /^quantity:/);
  });
});

describe("request validation", () => {
  test("TC-41 batch codes are upper-cased and must match the code format", () => {
    const ok = batchCreateSchema.parse({
      batchCode: "ccb-fin-009",
      productName: "Test",
      manufactureDate: "2026-01-01",
      quantityProduced: "12.345",
    });
    assert.equal(ok.batchCode, "CCB-FIN-009");
    assert.equal(ok.quantityProduced, 12.35, "rounded to NUMERIC(12,2)");
    assert.throws(() =>
      batchCreateSchema.parse({ batchCode: "a b", productName: "Test", manufactureDate: "2026-01-01", quantityProduced: 1 }),
    );
  });

  test("TC-42 a shipment may not list the same batch twice", () => {
    assert.throws(() =>
      shipmentCreateSchema.parse({ outletId: 1, lines: [{ batchId: 2, quantity: 1 }, { batchId: 2, quantity: 3 }] }),
    );
  });
});
