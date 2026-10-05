/*
 * npm run db:seed
 *
 * Fills PostgreSQL with a small but deep supply chain:
 *   11 raw materials -> 7 first-stage intermediates -> 5 blends
 *   -> 4 mixes -> 5 finished products, about 64 batches in all,
 *   with lineage up to four WENT_INTO hops deep;
 *   25 outlets in five cities; about 125 shipments.
 *
 * Every row goes through the real triggers (availability, cycles, inventory
 * booking, audit), so the seed doubles as a smoke test of the schema.
 * Deterministic: the same seed always produces the same data.
 *
 * Run order: db:schema -> db:seed -> db:indexes -> graph:resync -> vectors:resync
 */
import "./_env";
import type { PoolClient } from "pg";
import { hashPassword } from "@/lib/auth/password";
import { closePool, pool, withTransaction } from "@/lib/db/postgres";

/* ---------- deterministic randomness ---------- */

let state = 20261011;
function rand(): number {
  // mulberry32
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const maxDate = (dates: string[]) => dates.reduce((a, b) => (a > b ? a : b));
const LAST_SHIP_DATE = "2026-10-08";

/* ---------- catalogue ---------- */

interface Product {
  prefix: string;
  stage: "RAW" | "INT" | "FIN";
  name: string;
  description: string;
  lots: number;
  quantity: number;
  /** input prefix -> quantity of that input used per lot */
  recipe?: Record<string, number>;
}

const PRODUCTS: Product[] = [
  // raw materials (no inputs)
  { prefix: "SUG", stage: "RAW", name: "Cane Sugar", lots: 3, quantity: 6000,
    description: "Refined white cane sugar crystals delivered in 50 kg sacks from a Mandya mill." },
  { prefix: "COC", stage: "RAW", name: "Cocoa Beans", lots: 2, quantity: 3000,
    description: "Fermented and sun dried Forastero cocoa beans from Idukki estates." },
  { prefix: "MLK", stage: "RAW", name: "Raw Cow Milk", lots: 3, quantity: 12000,
    description: "Chilled raw cow milk collected from village dairy cooperatives." },
  { prefix: "WHT", stage: "RAW", name: "Wheat Grain", lots: 2, quantity: 8000,
    description: "Sharbati wheat grain, cleaned and tempered for milling." },
  { prefix: "PLM", stage: "RAW", name: "Palm Oil", lots: 2, quantity: 4000,
    description: "Refined palm olein vegetable fat supplied in bulk drums." },
  { prefix: "MNG", stage: "RAW", name: "Alphonso Mango Pulp", lots: 2, quantity: 5000,
    description: "Ratnagiri Alphonso mango pulp, aseptically packed in drums." },
  { prefix: "TOM", stage: "RAW", name: "Tomatoes", lots: 1, quantity: 6000,
    description: "Fresh hybrid tomatoes graded for processing." },
  { prefix: "SPC", stage: "RAW", name: "Garam Masala Blend", lots: 1, quantity: 800,
    description: "Ground whole spice blend of cumin, coriander, cardamom, clove and cinnamon." },
  { prefix: "PNT", stage: "RAW", name: "Groundnut Kernels", lots: 2, quantity: 5000,
    description: "Bold Java groundnut kernels, shelled and sorted." },
  { prefix: "SLT", stage: "RAW", name: "Iodised Salt", lots: 1, quantity: 2000,
    description: "Food grade iodised sea salt." },
  { prefix: "MLT", stage: "RAW", name: "Barley Malt Extract", lots: 1, quantity: 1500,
    description: "Liquid barley malt extract for beverages." },

  // first-stage intermediates
  { prefix: "SYR", stage: "INT", name: "Invert Sugar Syrup", lots: 3, quantity: 900, recipe: { SUG: 800 },
    description: "Invert sugar syrup made by acid hydrolysis of cane sugar." },
  { prefix: "CCL", stage: "INT", name: "Cocoa Liquor", lots: 2, quantity: 600, recipe: { COC: 700 },
    description: "Ground roasted cocoa nibs (cocoa mass)." },
  { prefix: "PMK", stage: "INT", name: "Pasteurised Milk", lots: 3, quantity: 2900, recipe: { MLK: 3000 },
    description: "HTST pasteurised and standardised cow milk." },
  { prefix: "FLR", stage: "INT", name: "Refined Wheat Flour", lots: 2, quantity: 2200, recipe: { WHT: 2500 },
    description: "Roller milled refined wheat flour (maida)." },
  { prefix: "MNP", stage: "INT", name: "Mango Puree Concentrate", lots: 2, quantity: 1200, recipe: { MNG: 1500 },
    description: "Evaporated Alphonso mango puree concentrate." },
  { prefix: "TPP", stage: "INT", name: "Tomato Puree", lots: 1, quantity: 1500, recipe: { TOM: 2000 },
    description: "Blanched and sieved tomato puree." },
  { prefix: "RPN", stage: "INT", name: "Roasted Peanuts", lots: 2, quantity: 1400, recipe: { PNT: 1500 },
    description: "Dry roasted and blanched groundnut kernels." },

  // blends
  { prefix: "CCM", stage: "INT", name: "Cocoa Cream Compound", lots: 2, quantity: 480,
    recipe: { CCL: 200, SYR: 150, PLM: 150 },
    description: "Cocoa, sugar syrup and vegetable fat compound for fillings." },
  { prefix: "FMB", stage: "INT", name: "Flavoured Milk Base", lots: 2, quantity: 950,
    recipe: { PMK: 800, SYR: 120, MLT: 60 },
    description: "Sweetened malted milk base." },
  { prefix: "DGH", stage: "INT", name: "Biscuit Dough", lots: 2, quantity: 740,
    recipe: { FLR: 500, SYR: 100, PLM: 150, SLT: 10 },
    description: "Short dough for sandwich biscuits." },
  { prefix: "MNB", stage: "INT", name: "Mango Nectar Base", lots: 2, quantity: 1800,
    recipe: { MNP: 400, SYR: 150 },
    description: "Diluted and sweetened mango puree base for nectar." },
  { prefix: "BTR", stage: "INT", name: "Table Butter", lots: 1, quantity: 40, recipe: { PMK: 600 },
    description: "Churned salted table butter." },

  // mixes
  { prefix: "CHM", stage: "INT", name: "Chocolate Milk Mix", lots: 2, quantity: 440,
    recipe: { FMB: 400, CCL: 40 },
    description: "Malted milk base blended with cocoa liquor." },
  { prefix: "CRF", stage: "INT", name: "Cream Filling", lots: 2, quantity: 190,
    recipe: { CCM: 150, PMK: 50 },
    description: "Cocoa cream filling for sandwich biscuits." },
  { prefix: "BBK", stage: "INT", name: "Baked Biscuit Shells", lots: 2, quantity: 280, recipe: { DGH: 300 },
    description: "Baked biscuit shells awaiting filling." },
  { prefix: "GRV", stage: "INT", name: "Masala Gravy Base", lots: 1, quantity: 520,
    recipe: { TPP: 500, BTR: 15, SPC: 20 },
    description: "Cooked tomato, butter and spice gravy base." },

  // finished goods: these descriptions are what complaints are matched against
  { prefix: "CMM", stage: "FIN", name: "Choco Malt Milk 200ml", lots: 3, quantity: 1000, recipe: { CHM: 200 },
    description: "Ready to drink chocolate flavoured dairy beverage in 200 ml tetra packs, made with pasteurised cow milk, cocoa and barley malt. Keep refrigerated." },
  { prefix: "CCB", stage: "FIN", name: "Choco Cream Biscuits 150g", lots: 3, quantity: 1100, recipe: { BBK: 120, CRF: 60 },
    description: "Crisp baked wheat sandwich cookies with a cocoa cream filling, sold in 150 gram wrappers." },
  { prefix: "AMN", stage: "FIN", name: "Alphonso Mango Nectar 1L", lots: 3, quantity: 500, recipe: { MNB: 500 },
    description: "Alphonso mango nectar beverage packed in one litre PET containers. Shelf stable sweetened fruit drink, best served chilled." },
  { prefix: "BMP", stage: "FIN", name: "Butter Masala Paste 250g", lots: 2, quantity: 600, recipe: { GRV: 150 },
    description: "Thick spiced tomato and butter curry gravy for Indian cooking, sold in a 250 gram glass jar." },
  { prefix: "PNB", stage: "FIN", name: "Crunchy Peanut Spread 340g", lots: 2, quantity: 800,
    recipe: { RPN: 300, SLT: 5, SYR: 20 },
    description: "Roasted ground groundnut spread with a pinch of salt, crunchy texture, sold in plastic tubs." },
];

const OUTLETS: [string, string][] = [
  ["Greenleaf Grocers MG Road", "Bengaluru"],
  ["Corner Pantry Koramangala", "Bengaluru"],
  ["Sri Lakshmi Stores Malleswaram", "Bengaluru"],
  ["Urban Larder HSR Layout", "Bengaluru"],
  ["Lakeview Provisions Indiranagar", "Bengaluru"],
  ["Hillside Mart Jayanagar", "Bengaluru"],
  ["Orchard Basket Whitefield", "Bengaluru"],
  ["Chamundi Provisions", "Mysuru"],
  ["Palace Road Supermarket", "Mysuru"],
  ["Kuvempunagar Mart", "Mysuru"],
  ["Gokulam Fresh Hub", "Mysuru"],
  ["Marina Grocers Mylapore", "Chennai"],
  ["T Nagar Daily Needs", "Chennai"],
  ["Adyar Pantry", "Chennai"],
  ["Velachery Value Mart", "Chennai"],
  ["Anna Nagar Fresh", "Chennai"],
  ["Banjara Hills Basket", "Hyderabad"],
  ["Kukatpally Kirana", "Hyderabad"],
  ["Gachibowli Greens", "Hyderabad"],
  ["Secunderabad Stores", "Hyderabad"],
  ["Madhapur Mart", "Hyderabad"],
  ["Marine Drive Market", "Kochi"],
  ["Kakkanad Kart", "Kochi"],
  ["Edappally Essentials", "Kochi"],
  ["Fort Kochi Pantry", "Kochi"],
];

/* ---------- state while seeding ---------- */

interface Lot {
  id: number;
  code: string;
  prefix: string;
  date: string;
  available: number;
}
const lots = new Map<string, Lot[]>();

async function insertLot(client: PoolClient, p: Product, n: number, date: string, inputs: [Lot, number][]) {
  const code = `${p.prefix}-${p.stage}-${String(n).padStart(3, "0")}`;
  const { rows } = await client.query<{ batch_id: number }>(
    `INSERT INTO batch (batch_code, product_name, description, manufacture_date, quantity_produced)
     VALUES ($1, $2, $3, $4, $5) RETURNING batch_id`,
    [code, p.name, p.description, date, p.quantity],
  );
  const lot: Lot = { id: rows[0]!.batch_id, code, prefix: p.prefix, date, available: p.quantity };
  for (const [parent, used] of inputs) {
    await client.query(
      `INSERT INTO batch_composition (parent_batch_id, child_batch_id, quantity_used) VALUES ($1, $2, $3)`,
      [parent.id, lot.id, used],
    );
    parent.available -= used;
  }
  lots.set(p.prefix, [...(lots.get(p.prefix) ?? []), lot]);
  return lot;
}

/** The lot of `prefix` with enough left, preferring the one used least so far. */
function chooseParent(prefix: string, need: number, lotIndex: number): Lot {
  const pool = (lots.get(prefix) ?? []).filter((l) => l.available >= need);
  if (pool.length === 0) throw new Error(`seed: no ${prefix} lot has ${need} left`);
  return pool[lotIndex % pool.length]!;
}

async function main() {
  const makerPassword = process.env.SEED_MANUFACTURER_PASSWORD;
  const inspectorPassword = process.env.SEED_REGULATOR_PASSWORD;
  if (!makerPassword || !inspectorPassword) {
    throw new Error("Set SEED_MANUFACTURER_PASSWORD and SEED_REGULATOR_PASSWORD in .env.local first");
  }

  // Wipe in one statement. TRUNCATE bypasses the row-level append-only and
  // immutability triggers, which is exactly why only this dev script uses it.
  await pool().query(`TRUNCATE complaint, audit_log, recall_batch, recall, inventory, shipment_line,
                      shipment, batch_composition, outlet, batch, app_session, app_user
                      RESTART IDENTITY CASCADE`);

  const { rows: users } = await pool().query<{ user_id: number; role: string }>(
    `INSERT INTO app_user (username, password_hash, role) VALUES
       ('maker', $1, 'MANUFACTURER'),
       ('inspector', $2, 'REGULATOR')
     RETURNING user_id, role`,
    [await hashPassword(makerPassword), await hashPassword(inspectorPassword)],
  );
  const makerId = users.find((u) => u.role === "MANUFACTURER")!.user_id;
  const inspectorId = users.find((u) => u.role === "REGULATOR")!.user_id;

  const counts = await withTransaction(makerId, async (client) => {
    /* outlets */
    const outletIds: number[] = [];
    for (const [name, city] of OUTLETS) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
      const { rows } = await client.query<{ outlet_id: number }>(
        `INSERT INTO outlet (outlet_name, city, contact_email) VALUES ($1, $2, $3) RETURNING outlet_id`,
        [name, city, `${slug}@example.com`],
      );
      outletIds.push(rows[0]!.outlet_id);
    }

    /* batches, stage by stage so every input exists before it is used */
    for (const p of PRODUCTS) {
      for (let n = 1; n <= p.lots; n++) {
        if (!p.recipe) {
          await insertLot(client, p, n, `2026-06-${String(between(1, 26)).padStart(2, "0")}`, []);
          continue;
        }
        const inputs: [Lot, number][] = Object.entries(p.recipe).map(([prefix, used]) => [
          // offset by catalogue position so every lot of an input gets used somewhere
          chooseParent(prefix, used, n - 1 + PRODUCTS.indexOf(p)),
          used,
        ]);
        const date = addDays(maxDate(inputs.map(([l]) => l.date)), between(2, 6));
        await insertLot(client, p, n, date, inputs);
      }
    }

    /* shipments: finished goods to outlets, oldest first */
    const finished = PRODUCTS.filter((p) => p.stage === "FIN").flatMap((p) => lots.get(p.prefix)!);
    const plans: { date: string; outlet: number; lines: [Lot, number][] }[] = [];
    for (let i = 0; i < 120; i++) {
      const lineCount = between(1, 3);
      const chosen = new Set<Lot>();
      while (chosen.size < lineCount) chosen.add(pick(finished));
      const lines = [...chosen].map((l) => [l, between(10, 45)] as [Lot, number]);
      const earliest = addDays(maxDate(lines.map(([l]) => l.date)), 1);
      const span = Math.max(0, (Date.parse(LAST_SHIP_DATE) - Date.parse(earliest)) / 86_400_000);
      plans.push({ date: addDays(earliest, between(0, span)), outlet: pick(outletIds), lines });
    }
    // Cane sugar lot 3 is also sold as retail 1 kg packs: a recall on it
    // reaches outlets directly (depth 0) and through four processing steps.
    const retailSugar = lots.get("SUG")![2]!;
    for (let i = 0; i < 6; i++) {
      plans.push({
        date: addDays(retailSugar.date, between(5, 40)),
        outlet: outletIds[(i * 4 + 1) % outletIds.length]!,
        lines: [[retailSugar, between(40, 90)]],
      });
    }
    plans.sort((a, b) => a.date.localeCompare(b.date));

    let shipments = 0;
    let lineCount = 0;
    for (const plan of plans) {
      const lines = plan.lines.filter(([lot, qty]) => lot.available >= qty);
      if (lines.length === 0) continue;
      const { rows } = await client.query<{ shipment_id: number }>(
        `INSERT INTO shipment (outlet_id, shipment_date, dispatched_by) VALUES ($1, $2, $3) RETURNING shipment_id`,
        [plan.outlet, plan.date, makerId],
      );
      for (const [lot, qty] of lines) {
        await client.query(`INSERT INTO shipment_line (shipment_id, batch_id, quantity) VALUES ($1, $2, $3)`, [
          rows[0]!.shipment_id,
          lot.id,
          qty,
        ]);
        lot.available -= qty;
        lineCount++;
      }
      shipments++;
    }

    /* outlets have sold part of what they received */
    await client.query(`
      UPDATE inventory
         SET quantity_on_hand = ROUND(quantity_on_hand * (0.25 + 0.75 * ((outlet_id * 7 + batch_id * 13) % 10) / 10.0))
       WHERE (outlet_id + batch_id) % 3 <> 0`);

    /* stock that has not moved yet: fresh deliveries nobody has used */
    await client.query(`
      INSERT INTO batch (batch_code, product_name, description, manufacture_date, quantity_produced) VALUES
        ('VAN-RAW-001', 'Vanilla Beans', 'Cured Madagascar vanilla pods for flavouring.', '2026-09-02', 40),
        ('SUG-RAW-004', 'Cane Sugar', 'Refined white cane sugar crystals delivered in 50 kg sacks from a Mandya mill.', '2026-10-03', 6000)`);

    /* one lot on hold pending a lab result */
    await client.query(`UPDATE batch SET status = 'QUARANTINED' WHERE batch_code = 'CMM-FIN-003'`);

    return { outlets: outletIds.length, shipments, lines: lineCount };
  });

  /* history: one closed recall and one open one, through the real procedure.
     The scope comes from fn_downstream_batches here; the app gets it from Neo4j. */
  async function recall(code: string, reason: string): Promise<number> {
    return withTransaction(makerId, async (client) => {
      const { rows: src } = await client.query<{ batch_id: number }>(
        `SELECT batch_id FROM batch WHERE batch_code = $1`,
        [code],
      );
      const id = src[0]!.batch_id;
      const { rows: scope } = await client.query<{ batch_id: number; hop_depth: number }>(
        `SELECT batch_id, hop_depth FROM fn_downstream_batches($1) WHERE batch_id <> $1`,
        [id],
      );
      const { rows } = await client.query<{ p_recall_id: number }>(
        `CALL sp_initiate_recall($1, $2, $3, $4::bigint[], $5::int[], NULL)`,
        [id, reason, makerId, scope.map((s) => s.batch_id), scope.map((s) => s.hop_depth)],
      );
      return rows[0]!.p_recall_id;
    });
  }

  const closed = await recall(
    "PNT-RAW-001",
    "Aflatoxin B1 above 10 ppb in retained sample of groundnut lot; supplier certificate withdrawn.",
  );
  await withTransaction(inspectorId, (client) => client.query(`CALL sp_close_recall($1, $2)`, [closed, inspectorId]));
  await recall(
    "MNG-RAW-002",
    "Elevated yeast counts and gas formation found in mango pulp drums during routine QC; possible fermentation.",
  );

  const { rows: summary } = await pool().query(`
    SELECT (SELECT COUNT(*) FROM batch)::int             AS batches,
           (SELECT COUNT(*) FROM batch_composition)::int AS compositions,
           (SELECT MAX(hop_depth) FROM batch b, LATERAL fn_downstream_batches(b.batch_id))::int AS max_depth,
           (SELECT COUNT(*) FROM inventory)::int         AS inventory_rows,
           (SELECT COUNT(*) FROM recall)::int            AS recalls,
           (SELECT COUNT(*) FROM audit_log)::int         AS audit_rows`);
  console.log("seeded", { ...counts, ...summary[0], users: ["maker (MANUFACTURER)", "inspector (REGULATOR)"] });
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
