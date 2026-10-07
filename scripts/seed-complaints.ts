/*
 * npm run complaints:seed      (after vectors:resync)
 *
 * Customer complaints written the way customers write: no batch numbers,
 * and most share NO words with the product description they should match.
 * Each goes through the same pipeline as POST /api/complaints, and the
 * script prints what the vector search found next to what keyword search
 * found, which is the evidence for requirement 8.
 */
import "./_env";
import { matchComplaint } from "@/lib/complaint-matching";
import { insertComplaint } from "@/lib/data/complaints";
import { closePool, query, queryOne, withTransaction } from "@/lib/db/postgres";

interface Seed {
  expect: string; // product prefix the complaint is really about
  text: string;
  atOutlet: boolean; // false: the customer did not say where they bought it
}

const COMPLAINTS: Seed[] = [
  // no shared vocabulary with the description at all
  { expect: "AMN", atOutlet: true,
    text: "Bottle smelled off, bought it last Tuesday. Tasted fizzy, like it had gone bad." },
  { expect: "CMM", atOutlet: true,
    text: "The kids' little carton had turned sour and lumpy, clearly curdled." },
  { expect: "CCB", atOutlet: true,
    text: "Those chocolatey snacks from the school tiffin tasted rancid and the centre had gone grey and oily." },
  { expect: "BMP", atOutlet: true,
    text: "The makhani sauce had mould on it the day I opened it, and the lid had bulged." },
  { expect: "PNB", atOutlet: true,
    text: "Bit down on a sharp hard sliver in the nutty stuff I put on toast, nearly cracked a molar." },
  // some overlap, so keyword search gets a chance (and is often imprecise)
  { expect: "AMN", atOutlet: false,
    text: "The yellow fruit juice gave my whole family stomach cramps the same evening." },
  { expect: "CMM", atOutlet: true,
    text: "Kids flavoured milk smelled bad even before the expiry date." },
  { expect: "CCB", atOutlet: true,
    text: "Biscuit packet was soggy and the cream inside smelled like old oil." },
];

async function main() {
  const reporter = await queryOne<{ user_id: number }>(`SELECT user_id FROM app_user WHERE role = 'REGULATOR' LIMIT 1`);
  if (!reporter) throw new Error("Run npm run db:seed first");

  await query(`DELETE FROM complaint`); // complaints have no dependants; safe to clear for a reseed

  const rows: Record<string, string | number>[] = [];
  for (const [i, c] of COMPLAINTS.entries()) {
    // an outlet that actually received this product, so the outlet filter has something to find
    const outlet = c.atOutlet
      ? await queryOne<{ outlet_id: number; outlet_name: string }>(
          `SELECT o.outlet_id, o.outlet_name
             FROM outlet o
             JOIN shipment s       ON s.outlet_id = o.outlet_id
             JOIN shipment_line sl ON sl.shipment_id = s.shipment_id
             JOIN batch b          ON b.batch_id = sl.batch_id
            WHERE b.batch_code LIKE $1
            GROUP BY o.outlet_id, o.outlet_name
            ORDER BY COUNT(*) DESC, o.outlet_id
            OFFSET $2 LIMIT 1`,
          [`${c.expect}-FIN-%`, i % 3],
        )
      : undefined;

    const complaintId = await withTransaction(reporter.user_id, (client) =>
      insertComplaint(client, { outletId: outlet?.outlet_id ?? null, text: c.text }),
    );
    const result = await matchComplaint({ complaintId, text: c.text, outletId: outlet?.outlet_id ?? null });
    if (result.vectorError) throw new Error(result.vectorError);

    const top = result.vectorMatches[0];
    const kw = result.keywordMatches[0];
    rows.push({
      complaint: c.text.slice(0, 44) + "…",
      expected: c.expect,
      vector: top ? `${top.batchCode} (${top.similarity.toFixed(3)})` : "-",
      vectorOk: top?.batchCode.startsWith(c.expect) ? "yes" : "NO",
      keyword: kw ? kw.batchCode : "nothing",
      keywordOk: kw?.batchCode.startsWith(c.expect) ? "yes" : "no",
    });
  }
  console.table(rows);
  const v = rows.filter((r) => r.vectorOk === "yes").length;
  const k = rows.filter((r) => r.keywordOk === "yes").length;
  console.log(`vector search matched ${v}/${rows.length}; keyword search matched ${k}/${rows.length}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
