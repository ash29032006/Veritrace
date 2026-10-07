import { batchesByIds, getComplaintsByIds, keywordSearch, recordMatch } from "@/lib/data/complaints";
import { batchesShippedAnywhere, batchesShippedToOutlet } from "@/lib/data/shipments";
import { embedOne } from "@/lib/embedding";
import type { KeywordMatch, SimilarComplaint, VectorMatch } from "@/lib/types";
import * as vector from "@/lib/vector";

/*
 * The complaint matching pipeline, shared by POST /api/complaints and the
 * complaint seed script.
 *
 *   1. embed the text locally (all-MiniLM-L6-v2, 384 dims, normalised)
 *   2. candidates = batches shipped to the complaint's outlet, or, when the
 *      outlet is unknown, every batch that reached any outlet (a customer
 *      cannot have bought an intermediate that never left the plant)
 *   3. Qdrant cosine search over batch descriptions, filtered to candidates
 *   4. pick the best; write batch and score back to the complaint row
 *   5. store the complaint's own vector; find earlier complaints like it
 *   6. the keyword (full-text) baseline, for comparison
 */

// Lots of one product share a description, so their vectors tie. Within
// this margin of the best score, prefer the lot most recently shipped to
// the outlet: semantics finds the product, distribution narrows the lot.
const TIE_MARGIN = 0.01;

export interface MatchResult {
  vectorMatches: VectorMatch[];
  keywordMatches: KeywordMatch[];
  keywordQuery: string;
  similarComplaints: SimilarComplaint[];
  candidateScope: "outlet" | "shipped";
  elapsedMs: { embed: number; search: number };
  vectorError?: string;
}

export async function matchComplaint(c: {
  complaintId: number;
  text: string;
  outletId: number | null;
}): Promise<MatchResult> {
  const keyword = await keywordSearch(c.text);
  const result: MatchResult = {
    vectorMatches: [],
    keywordMatches: keyword.matches,
    keywordQuery: keyword.query,
    similarComplaints: [],
    candidateScope: "shipped",
    elapsedMs: { embed: 0, search: 0 },
  };

  try {
    let t = performance.now();
    const vec = await embedOne(c.text);
    result.elapsedMs.embed = Math.round(performance.now() - t);

    const atOutlet = c.outletId ? await batchesShippedToOutlet(c.outletId) : [];
    result.candidateScope = atOutlet.length > 0 ? "outlet" : "shipped";
    const shipped = atOutlet.length > 0 ? atOutlet : await batchesShippedAnywhere();
    const lastShipped = new Map(shipped.map((s) => [s.batch_id, s.last_shipped]));

    t = performance.now();
    const hits = await vector.searchBatches(vec, {
      candidateIds: shipped.map((s) => s.batch_id),
      limit: 5,
    });
    const info = new Map((await batchesByIds(hits.map((h) => h.batchId))).map((b) => [b.batch_id, b]));
    let matches: VectorMatch[] = hits
      .filter((h) => info.has(h.batchId))
      .map((h) => {
        const b = info.get(h.batchId)!;
        return {
          batchId: h.batchId,
          batchCode: b.batch_code,
          productName: b.product_name,
          status: b.status,
          similarity: Math.round(h.score * 100000) / 100000,
          lastShippedToOutlet: lastShipped.get(h.batchId) ?? null,
        };
      });

    const top = matches[0];
    if (top) {
      const best = matches
        .filter((m) => m.similarity >= top.similarity - TIE_MARGIN && m.productName === top.productName)
        .sort((a, b) => (b.lastShippedToOutlet ?? "").localeCompare(a.lastShippedToOutlet ?? ""))[0]!;
      matches = [best, ...matches.filter((m) => m !== best)];
      await recordMatch(c.complaintId, best.batchId, best.similarity);
    }
    result.vectorMatches = matches;

    await vector.upsertComplaint(c.complaintId, vec, {
      outlet_id: c.outletId,
      matched_batch_id: matches[0]?.batchId ?? null,
    });
    const near = await vector.searchComplaints(vec, { excludeId: c.complaintId, limit: 3 });
    const texts = new Map((await getComplaintsByIds(near.map((n) => n.batchId))).map((x) => [x.complaint_id, x]));
    result.similarComplaints = near
      .filter((n) => texts.has(n.batchId))
      .map((n) => ({
        complaintId: n.batchId,
        text: texts.get(n.batchId)!.complaint_text,
        similarity: Math.round(n.score * 1000) / 1000,
        matchedBatchCode: texts.get(n.batchId)!.matched_batch_code,
      }));
    result.elapsedMs.search = Math.round(performance.now() - t);
  } catch (err) {
    // the complaint is already saved; it simply stays unmatched
    result.vectorError = (err as Error).message;
    console.error("[veritrace] complaint matching failed", err);
  }
  return result;
}
