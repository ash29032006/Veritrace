import { NextResponse } from "next/server";
import { DatabaseError } from "pg";
import { ZodError } from "zod";
import { ConfigError } from "@/lib/env";
import type { ApiErrorBody } from "@/lib/types";

/*
 * Every Route Handler is wrapped in `handle`, which turns thrown errors into
 * JSON with an honest status code. Database refusals are the point of the
 * project, so they are passed through verbatim rather than hidden behind 500:
 *
 *   P0001 raise_exception     409  a trigger or procedure refused (business rule)
 *   42501 insufficient_priv.  403  a procedure's own role check
 *   P0002 no_data_found       404
 *   23505 unique_violation    409
 *   23503 foreign_key_viol.   409
 *   23001 restrict_violation  409  ON DELETE RESTRICT protecting provenance
 *   23514 check_violation     422  a CHECK constraint rejected the input
 *   22xxx data exceptions     400
 */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "error",
    public extra: Partial<ApiErrorBody> = {},
  ) {
    super(message);
  }
}

export const badRequest = (msg: string) => new ApiError(400, msg, "bad_request", { source: "validation" });
export const notFound = (msg: string) => new ApiError(404, msg, "not_found");

export function json<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

const CHECK_MESSAGES: Record<string, string> = {
  chk_batch_qty: "Quantity produced must be greater than zero.",
  chk_batch_date: "Manufacture date cannot be in the future.",
  chk_batch_code_format: "Batch code must be 3 to 40 characters: capital letters, digits and hyphens.",
  chk_bc_no_self_loop: "A batch cannot be an input to itself.",
  chk_bc_qty: "Quantity used must be greater than zero.",
  chk_sl_qty: "Shipment quantity must be greater than zero.",
  chk_shipment_date: "Shipment date cannot be in the future.",
  chk_outlet_email: "Contact email is not a valid address.",
  chk_recall_reason: "A recall reason needs at least 10 characters.",
  chk_complaint_text: "A complaint must be between 10 and 2000 characters.",
  chk_inv_qty: "Inventory cannot go below zero.",
};

function fromDatabase(err: DatabaseError): ApiError {
  const extra: Partial<ApiErrorBody> = {
    source: "database",
    detail: err.detail,
    hint: err.hint,
  };
  const code = err.code ?? "";
  switch (code) {
    case "P0001":
      return new ApiError(409, err.message, "rejected_by_database", extra);
    case "42501":
      return new ApiError(403, err.message, "forbidden", extra);
    case "P0002":
      return new ApiError(404, err.message, "not_found", extra);
    case "23505":
      return new ApiError(409, `Already exists: ${err.detail ?? err.message}`, "duplicate", extra);
    case "23503":
      return new ApiError(409, err.detail ?? err.message, "foreign_key", extra);
    case "23001":
      // ON DELETE RESTRICT: provenance must never be destroyed
      return new ApiError(409, `Still referenced, so it cannot be deleted: ${err.detail ?? err.message}`, "restricted", extra);
    case "23514": {
      const friendly = err.constraint ? CHECK_MESSAGES[err.constraint] : undefined;
      return new ApiError(422, friendly ?? err.message, "check_violation", {
        ...extra,
        detail: `CHECK constraint ${err.constraint} rejected the row.`,
      });
    }
    default:
      if (code.startsWith("22")) return new ApiError(400, err.message, "invalid_value", extra);
      return new ApiError(500, "Database error", "database_error", { source: "database" });
  }
}

export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (err instanceof ZodError) {
    const first = err.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return new ApiError(400, `${where}${first?.message ?? "Invalid input"}`, "invalid_input", {
      source: "validation",
    });
  }
  if (err instanceof DatabaseError) return fromDatabase(err);
  if (err instanceof ConfigError) {
    return new ApiError(503, err.message, "not_configured", { source: "server" });
  }
  if (err instanceof Error && err.name === "Neo4jError") {
    return new ApiError(503, `Neo4j is unavailable: ${err.message}`, "graph_unavailable", { source: "graph" });
  }
  if (err instanceof Error && err.name === "GraphDriftError") {
    return new ApiError(409, err.message, "graph_drift", { source: "graph" });
  }
  return new ApiError(500, "Unexpected server error", "server_error", { source: "server" });
}

type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

export function handle<C>(fn: Handler<C>): Handler<C> {
  return async (req, ctx) => {
    try {
      return await fn(req, ctx);
    } catch (err) {
      const apiErr = toApiError(err);
      if (apiErr.status >= 500) console.error("[veritrace]", req.method, req.url, err);
      const body: ApiErrorBody = { error: apiErr.message, code: apiErr.code, ...apiErr.extra };
      return NextResponse.json(body, { status: apiErr.status });
    }
  };
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("Request body must be JSON");
  }
}

export function idParam(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw badRequest(`"${raw}" is not a valid id`);
  return id;
}
