# Veritrace

**Batch provenance and recall cascade engine.**
DBMS Experiential Learning, Level 3 project, PES University.
Ashwin C H (PES1UG24AM900) and Aman Priyanch (PES1UG24AM030).

When a batch of food is found contaminated, Veritrace answers three questions, each with the database built for it:

| Question | Engine | Why this one |
|---|---|---|
| Which outlets received anything made from this batch, at **any** depth of processing? | **Neo4j** | Traversal to an unknown depth: one variable-length pattern instead of a recursive CTE. |
| Recall it: mark every affected batch, quarantine stock at every outlet, record why. All or nothing. | **PostgreSQL** | ACID transaction, foreign keys, CHECK constraints, triggers, a stored procedure. |
| A customer writes "the bottle smelled off". Which batch is that? | **Qdrant** | No batch number in the text and no shared keywords: matched by meaning (cosine similarity of sentence embeddings). |

PostgreSQL is the source of truth. Neo4j and Qdrant are projections of it, written in the same request and rebuildable at any time.

![ER diagram](docs/er/er-diagram.png)

---

## Requirements

| Tool | Version | Notes |
|---|---|---|
| Node.js | 20.9 or later (tested on 22) | |
| PostgreSQL | 16 or later (tested on 18.4) | no extensions needed |
| Neo4j | 5.x | Neo4j Desktop, Docker, or Aura |
| Qdrant | 1.x | Qdrant Cloud free tier, or `docker run -p 6333:6333 qdrant/qdrant` |
| Graphviz | any | only to regenerate the diagrams |

The embedding model (all-MiniLM-L6-v2, about 23 MB) downloads automatically on first use into `.cache/models`.

## Setup

```bash
git clone https://github.com/ash29032006/Veritrace.git
cd Veritrace
npm install
cp .env.example .env.local        # then fill in every value, see below
```

`.env.local`:

| Key | What |
|---|---|
| `DATABASE_URL` | `postgresql://user:password@localhost:5432/veritrace` (create the empty database first: `createdb veritrace`) |
| `BENCH_DATABASE_URL` | a **second, empty** database used only by the index benchmark, e.g. `.../veritrace_bench` |
| `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | your Neo4j instance (`bolt://localhost:7687`) |
| `QDRANT_URL`, `QDRANT_API_KEY` | your Qdrant cluster URL and key |
| `SESSION_SECRET` | any random string of 32+ characters: `openssl rand -hex 32` |
| `EMBEDDING_MODEL`, `EMBEDDING_DIM` | leave as `Xenova/all-MiniLM-L6-v2` and `384` |
| `SEED_MANUFACTURER_PASSWORD`, `SEED_REGULATOR_PASSWORD` | passwords for the two demo accounts the seed creates |

No credential appears anywhere in the source. `.env*` is git-ignored except `.env.example`.

Then build everything:

```bash
npm run setup
```

which runs, in order:

| Step | Script | Does |
|---|---|---|
| 1 | `db:schema` | `01_schema.sql` (tables, keys, CHECKs) and `02_functions.sql` (ALTER, functions, triggers, procedures, views) |
| 2 | `db:seed` | 66 batches four levels deep, 25 outlets, 126 shipments, two recalls, all through the real triggers |
| 3 | `db:indexes` | `04_indexes.sql`, created after the data on purpose (see indexing evidence) |
| 4 | `graph:setup` | Neo4j constraints and indexes |
| 5 | `graph:resync` | rebuilds the whole graph from PostgreSQL and checks the counts match |
| 6 | `vectors:resync` | creates both Qdrant collections and embeds every batch description |
| 7 | `complaints:seed` | eight paraphrased customer complaints, matched by vector search |

## Run

```bash
npm run dev            # http://localhost:3000
```

Sign in as **maker** (manufacturer) or **inspector** (regulator) with the passwords from `.env.local`.

## Verify

```bash
npm test               # 42 database and API test cases (each runs in a rolled-back transaction)
npm run graph:verify   # recursive CTE vs Cypher, for every batch: results must be identical
npm run db:queries     # the requirement 6 query set, printed from psql
npm run bench:indexes  # EXPLAIN ANALYZE before/after indexes on 200k rows -> docs/indexing-evidence.md
npm run typecheck
```

## What to look at

| Screen | Shows |
|---|---|
| **Batches** | search, stage and status filters, register a batch with its inputs, record composition, put a batch on hold |
| **Shipments** | dispatch with batch lines; ship a recalled batch and watch `trg_block_unsafe_shipment` refuse it (HTTP 409); cancel a shipment (the DELETE) |
| **Recalls** | preview the exposure from Neo4j as a lineage graph, then fire the cascade (`sp_initiate_recall`, one transaction); regulators close recalls |
| **Exposure** | dashboard over `v_outlet_exposure`; trace any batch forward or backward; **SQL vs Cypher** side by side, run live; the nine requirement-6 reports with their SQL |
| **Complaints & audit** | vector match next to the keyword baseline, similar earlier complaints; the append-only audit log with filters |

The live demo script is in [docs/demo.md](docs/demo.md).

## Repository layout

```
db/postgres/      01_schema.sql · 02_functions.sql · 03_queries.sql · 04_indexes.sql
db/neo4j/         constraints.cypher · queries.cypher
app/api/          Route Handlers: the only code that touches a database
app/(app)/        the five workspace screens; app/login
components/       UI pieces, including the SVG lineage graph
lib/db/           postgres.ts · neo4j.ts · qdrant.ts (server only)
lib/graph/        Cypher statements and the Neo4j sync layer
lib/vector/       Qdrant access;  lib/embedding.ts: local sentence embeddings
lib/data/         SQL for each resource
scripts/          seed, resync, verify, benchmark, diagram generators
tests/            node:test suites
docs/             design spec (the report), ER and schema diagrams, evidence
```

## Design decisions worth knowing

* **Vectors live in Qdrant, not pgvector.** A dedicated vector database makes the three-paradigm split real, and Qdrant applies the "only batches shipped to this outlet" filter inside the HNSW search rather than after it. The complaint text and the match result stay in PostgreSQL; Qdrant holds only vectors and ids.
* **Batch embeddings are a Qdrant collection** (`batch_descriptions`, point id = `batch_id`), not a PostgreSQL table. The embedded text is `product_name + description`. The batch code is left out: it carries no meaning and only adds noise to the vector.
* **The recall scope is persisted** in `recall_batch`, so the exposure view and audit never depend on the graph after the fact.
* **The procedure double-checks the graph.** `sp_initiate_recall` recomputes the downstream set with a recursive CTE and refuses if Neo4j missed a batch: under-recalling is the dangerous failure.
* **The database enforces the rules, not just the UI**: 23 CHECK constraints, 15 triggers (unsafe shipments, overuse, cycles, inventory booking, append-only audit, immutable lineage), role checks inside the procedures.
* **Sessions are server-side**: a random token in an httpOnly cookie; only its HMAC is stored.

## Team

| | Ashwin | Aman |
|---|---|---|
| Database | PostgreSQL DDL, constraints, triggers, procedures, views, indexes, requirement-6 queries | Neo4j model, Cypher, sync and resync; Qdrant and the embedding pipeline |
| Application | auth, batches, shipments, recalls (API and screens) | exposure, provenance, comparison, complaints, audit (API and screens) |
| Documentation | sections 1–5, 7, 10 | sections 6, 8, 9, 11, architecture |
