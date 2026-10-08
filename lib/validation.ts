import { z } from "zod";

/*
 * Request shapes. The API validates for friendly messages; the database's
 * CHECK constraints and triggers remain the final word (requirement 12), so
 * anything that slips past here is still refused at the table.
 */

const id = z.coerce.number().int().positive();
// NUMERIC(12,2) in the schema: round to cents here rather than reject 0.1 + 0.2
const qty = z.coerce
  .number()
  .positive()
  .max(9_999_999_999)
  .transform((n) => Math.round(n * 100) / 100);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

export const loginSchema = z.object({
  username: z.string().trim().min(1, "Username is required").max(50),
  password: z.string().min(1, "Password is required").max(200),
});

const inputLine = z.object({ batchId: id, quantityUsed: qty });

function uniqueBy<T>(key: (t: T) => unknown, message: string) {
  return (items: T[], ctx: z.RefinementCtx) => {
    const seen = new Set();
    for (const item of items) {
      const k = key(item);
      if (seen.has(k)) ctx.addIssue({ code: "custom", message });
      seen.add(k);
    }
  };
}

export const batchCreateSchema = z.object({
  batchCode: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, "3 to 40 characters: letters, digits and hyphens"),
  productName: z.string().trim().min(2).max(120),
  description: z
    .string()
    .trim()
    .max(400)
    .optional()
    .transform((v) => (v ? v : null)),
  manufactureDate: isoDate,
  quantityProduced: qty,
  inputs: z
    .array(inputLine)
    .max(20)
    .default([])
    .superRefine(uniqueBy((l) => l.batchId, "Each input batch can be listed once")),
});

export const compositionSchema = z.object({
  inputs: z
    .array(inputLine)
    .min(1, "Add at least one input batch")
    .max(20)
    .superRefine(uniqueBy((l) => l.batchId, "Each input batch can be listed once")),
});

export const batchStatusSchema = z.object({
  status: z.enum(["ACTIVE", "QUARANTINED"], {
    message: "Status can be set to ACTIVE or QUARANTINED; RECALLED only comes from a recall",
  }),
});

export const batchListSchema = z.object({
  q: z.string().trim().max(60).optional(),
  status: z.enum(["ACTIVE", "QUARANTINED", "RECALLED"]).optional(),
  stage: z.enum(["raw", "intermediate", "finished"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
});

export const shipmentCreateSchema = z.object({
  outletId: id,
  shipmentDate: isoDate.optional(),
  lines: z
    .array(z.object({ batchId: id, quantity: qty }))
    .min(1, "Add at least one batch line")
    .max(20)
    .superRefine(uniqueBy((l) => l.batchId, "Each batch can appear once per shipment")),
});

export const recallCreateSchema = z.object({
  batchId: id,
  reason: z.string().trim().min(10, "Give a reason of at least 10 characters").max(1000),
});

export const recallPatchSchema = z.object({
  status: z.literal("CLOSED", { message: "A recall can only be moved to CLOSED" }),
});

export const complaintCreateSchema = z.object({
  outletId: id.nullable().optional(),
  text: z.string().trim().min(10, "Describe the problem in at least 10 characters").max(2000),
});

export const auditListSchema = z.object({
  action: z
    .string()
    .trim()
    .regex(/^[A-Z_]*$/)
    .optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function searchParams(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  new URL(req.url).searchParams.forEach((v, k) => {
    if (v !== "") out[k] = v;
  });
  return out;
}
