# VERITRACE — Project Brief for Claude Code

> Batch Provenance and Recall Cascade Engine
> DBMS Experiential Learning, Level 3 Project, PES University
> Ashwin C H (PES1UG24AM900) and Aman Priyanch (PES1UG24AM030)

---

## 0. How to use this file

This is the single source of truth for the project. Read it fully before writing code.

Two companion files sit beside it in this folder:

| File | What it is |
|---|---|
| `DBMS Level 3 Project Requirements draft (1).pdf` | The department brief. The graded checklist. Kept locally, not committed. |
| `db/postgres/01_schema.sql` | The PostgreSQL DDL. Final unless this file says otherwise. |
| `docs/design-spec.md` | The design document that grows into the requirement 14 report. |

**Precedence when something conflicts:** the PDF wins over this file, this file wins over the code.

---

## 1. What this project is

A manufacturer produces goods in **batches**. A batch can be consumed as an input into another batch (raw lot blended into an intermediate, intermediate into a finished product). Finished batches are split across **shipments** to retail **outlets**.

When a batch is found to be contaminated, the operator must answer two questions:

* **Forward (exposure):** which outlets received any product that contains material from this batch, at any depth of transformation?
* **Backward (provenance):** which input batches went into this batch?

The depth of the chain is not known when the query is written. That single fact is why this project exists and why it uses a graph database.

Executing the recall is a different kind of problem. Batch status, inventory quarantine at every affected outlet, and the audit record must all succeed or all fail. That is a transaction.

A third problem: customer complaints arrive as free text with no batch number in them, so keyword search cannot match them to a batch. That is a vector similarity problem, handled by Qdrant.

**Three problems, three databases, each doing what the others do badly. That is the graded argument of the project.**

---

## 2. Hard rules

These are non negotiable. Violating any of them costs marks directly.

1. **No credentials in source code.** Everything through `.env.local`. `.env*` must be in `.gitignore` from the first commit.
2. **No plain text passwords.** bcrypt only.
3. **All database access is server side.** Next.js Route Handlers only. No database driver imported into a client component, ever.
4. **PostgreSQL is the source of truth.** Neo4j is a projection of lineage. If they disagree, Postgres is right.
5. **Do not reuse code from any other project.** Requirement 17 forbids it. Everything here is written fresh.
6. **Both members commit regularly.** Requirement 15 grades individual contribution from commit history. Small frequent commits, not three giant ones at the end.
7. **Never destroy provenance.** Lineage foreign keys are `ON DELETE RESTRICT` on purpose. Do not relax them to make a delete work.

---

## 3. Requirement mapping

Every numbered requirement from the PDF and where it is satisfied.

| # | Requirement | Where it is satisfied |
|---|---|---|
| 1 | Unique title, real problem, not plain CRUD | Recall propagation. Core operation is traversal plus transaction. |
| 2 | Two member team, both on DB and app | Section 14 of this file. |
| 3 | Minimum two paradigms | Three: PostgreSQL, Neo4j, Qdrant. |
| 4 | ER diagram and relational schema | Hand drawn diagram plus `01_schema.sql`. |
| 5 | DDL: CREATE, ALTER, DROP, keys, constraints, indexes, views | `01_schema.sql`, `02_functions.sql`, `04_indexes.sql`. One real ALTER, see 5.4. |
| 6 | DML plus JOIN, GROUP BY, HAVING, ORDER BY, aggregates, subqueries | `03_queries.sql`. See section 8. **This is the weakest requirement. Do not skip it.** |
| 7 | At least four advanced features | Eight delivered. See section 7. |
| 8 | Vector and semantic search | Qdrant collections `batch_descriptions` and `complaints`, cosine, HNSW. Section 13. |
| 9 | Next.js web interface | Section 11. |
| 10 | API layer, env vars, no hard coded config | Section 10 and rule 1. |
| 11 | Authentication, minimum two roles | MANUFACTURER and REGULATOR. Section 12. |
| 12 | Input validation at database level | 23 CHECK constraints plus guard triggers. `npm test` proves each one. |
| 13 | Security, no plain text credentials | bcrypt, `.env.local`. |
| 14 | Documentation, fourteen sections | `docs/design-spec.md`, all fourteen sections. |
| 15 | Git with individual contributions, README | Section 14. |
| 16 | Demonstration | Section 16. |
| 17 | Originality | Rule 5. |
| 18 | Beyond CRUD, justified paradigm choice | Section 4. |

---

## 4. Database choice justification

This is the graded core. Memorise it, because it is the first thing asked at evaluation.

| Data | Engine | Why this one and not the others |
|---|---|---|
| Batches, outlets, shipments, inventory, recalls, users, audit log | PostgreSQL | Needs ACID transactions and foreign key integrity. A recall that quarantines stock at many outlets must be atomic. PostgreSQL over MySQL because the design uses what MySQL lacks: array parameters (the affected set passed to `sp_initiate_recall`), triggers that fire on cascaded deletes, transactional DDL, `CYCLE` in recursive CTEs, and PL/pgSQL. |
| Batch lineage and outlet distribution | Neo4j | Needs traversal to an unknown depth with filtering on the properties of each link. The recursive CTE for the same exposure query is about 25 lines. The Cypher is three. |
| Customer complaint text | Qdrant | Complaints carry no batch identifier and are written in ordinary language, so keyword search fails on paraphrase. Text is embedded and matched by cosine similarity. A dedicated vector database (not an extension) keeps the three paradigms genuinely separate, and Qdrant filters candidates (only batches shipped to this outlet) inside the HNSW search. |

**At the demo, show the recursive CTE and the Cypher side by side.** That turns the justification from an assertion into a demonstration. Both versions must exist in the repo before the final week.

---

## 5. PostgreSQL

### 5.1 Tables

Twelve tables, defined in `01_schema.sql`. Read that file rather than trusting a summary.

```
app_user           user_id, username, password_hash, role, created_at
app_session        token_hash, user_id, created_at, expires_at
batch              batch_id, batch_code, product_name, description,
                   manufacture_date, quantity_produced, status
batch_composition  parent_batch_id, child_batch_id, quantity_used
outlet             outlet_id, outlet_name, city, contact_email
shipment           shipment_id, outlet_id, shipment_date, dispatched_by
shipment_line      shipment_id, batch_id, quantity
inventory          outlet_id, batch_id, quantity_on_hand, stock_status
recall             recall_id, batch_id, reason, initiated_by,
                   initiated_at, recall_status, closed_by, closed_at
recall_batch       recall_id, batch_id, hop_depth   (persisted recall scope)
audit_log          log_id, action, entity_name, entity_id,
                   performed_by, performed_at, details
complaint          complaint_id, outlet_id, complaint_text, received_at,
                   matched_batch_id, similarity_score (added by ALTER)
```

Vectors are not stored in PostgreSQL; they live in Qdrant keyed by `batch_id` and `complaint_id`.

### 5.2 The direction rule

In `batch_composition`, **`parent_batch_id` is the input and `child_batch_id` is the batch that consumed it.**

Parent went INTO child. This direction must match the Neo4j `WENT_INTO` relationship exactly. Get it backwards and traversal silently returns nothing, which is the worst kind of bug because it looks like empty data rather than an error.

### 5.3 Referential actions and why

* Lineage and inventory foreign keys: `RESTRICT`. A batch that has been shipped or consumed can never be deleted. Provenance is permanent.
* `shipment_line` from `shipment`: `CASCADE`. A line has no meaning without its header.
* `audit_log.performed_by`: `SET NULL`. Deleting a user account must not erase history.

### 5.4 The ALTER requirement

Requirement 5 names `ALTER` explicitly and there is no ALTER in the schema file. Do not fake one.

Do this instead: create `complaint` **without** the `similarity_score` column in `01_schema.sql`, then add it in `02_functions.sql` as a real schema evolution step:

```sql
ALTER TABLE complaint
    ADD COLUMN similarity_score NUMERIC(6,5);

ALTER TABLE complaint
    ADD CONSTRAINT chk_complaint_score
    CHECK (similarity_score IS NULL
           OR (similarity_score >= 0 AND similarity_score <= 1));
```

Commit the two states separately so the git history shows a genuine schema change.

### 5.5 The DELETE requirement

Most foreign keys are RESTRICT, so plan one place where a real DELETE happens: **cancelling a shipment**. Deleting a `shipment` row cascades to its `shipment_line` rows. Build that as a feature so there is a DELETE to demonstrate.

---

## 6. Neo4j graph model

### 6.1 Nodes and relationships

```cypher
(:Batch  { batch_id, batch_code, product_name, status })
(:Outlet { outlet_id, outlet_name, city })

(:Batch)-[:WENT_INTO  { quantity_used }]->(:Batch)
(:Batch)-[:SHIPPED_TO { shipment_id, quantity, shipment_date }]->(:Outlet)
```

`WENT_INTO` points **from the input batch to the batch that consumed it**, matching `batch_composition`.

`SHIPPED_TO` is one relationship per shipment line, merged on `shipment_id`. Merging on the (batch, outlet) pair alone would collapse two shipments of the same batch to the same outlet into one edge, and the Cypher and SQL results would stop agreeing.

### 6.2 Constraints

```cypher
CREATE CONSTRAINT batch_id_unique
  FOR (b:Batch) REQUIRE b.batch_id IS UNIQUE;

CREATE CONSTRAINT outlet_id_unique
  FOR (o:Outlet) REQUIRE o.outlet_id IS UNIQUE;
```

These also create the backing indexes, which is what makes the traversal fast.

### 6.3 The two queries that matter

Forward exposure. Every outlet that received anything containing this batch, at any depth:

```cypher
MATCH (b:Batch { batch_id: $batchId })-[:WENT_INTO*0..]->(d:Batch)
      -[s:SHIPPED_TO]->(o:Outlet)
RETURN DISTINCT o.outlet_id   AS outletId,
                o.outlet_name AS outletName,
                d.batch_id    AS affectedBatchId,
                d.batch_code  AS affectedBatchCode,
                s.quantity    AS quantity;
```

`*0..` means any number of hops **including zero**, so the batch's own direct shipments are included. Using `*1..` here is a common and silent bug: it would miss every outlet that received the contaminated batch directly.

Backward provenance. Every input batch that contributed to this batch:

```cypher
MATCH (src:Batch)-[:WENT_INTO*1..]->(b:Batch { batch_id: $batchId })
RETURN DISTINCT src.batch_id AS batchId, src.batch_code AS batchCode;
```

Here `*1..` is correct, because a batch is not its own input.

### 6.4 The SQL equivalent, for the comparison

Write this and keep it in `03_queries.sql`. It is evidence, not production code.

```sql
WITH RECURSIVE downstream AS (
    SELECT b.batch_id
      FROM batch b
     WHERE b.batch_id = $1

    UNION

    SELECT bc.child_batch_id
      FROM batch_composition bc
      JOIN downstream d ON d.batch_id = bc.parent_batch_id
)
SELECT DISTINCT o.outlet_id, o.outlet_name, b.batch_code, sl.quantity
  FROM downstream   d
  JOIN shipment_line sl ON sl.batch_id = d.batch_id
  JOIN shipment      s  ON s.shipment_id = sl.shipment_id
  JOIN outlet        o  ON o.outlet_id = s.outlet_id
  JOIN batch         b  ON b.batch_id = d.batch_id
 ORDER BY o.outlet_name;
```

### 6.5 Sync strategy

Neo4j is written **in the same request** as Postgres, never by a background job.

* On batch create: `MERGE` the `:Batch` node.
* On composition insert: `MERGE` the `WENT_INTO` relationship.
* On shipment line insert: `MERGE` the `SHIPPED_TO` relationship, keyed by `shipment_id`.
* On shipment cancel: `DELETE` that shipment's `SHIPPED_TO` relationships.
* On batch status change: `SET` the node's `status` property.
* A sync write that matches no node is a drift error and is raised, not ignored.

Always `MERGE`, never `CREATE`, so a retry does not produce duplicate nodes.

Postgres commits first. If the Neo4j write then fails, log it loudly, record `GRAPH_SYNC_FAILED` in `audit_log`, and return the failure in the response's `sync` field. Do not silently swallow it. `scripts/resync-graph.ts` rebuilds the whole graph from Postgres, both as a recovery tool and as a thing to show at the demo. `scripts/verify-graph.ts` checks CTE and Cypher agree for every batch.

---

## 7. Advanced features

Requirement 7 asks for four. Eight are delivered. All live in `02_functions.sql` unless noted.

**1. Transaction — the recall cascade.** See section 9.

**2. Trigger — reject shipment lines for unsafe batches.**

```sql
CREATE OR REPLACE FUNCTION fn_block_unsafe_shipment()
RETURNS TRIGGER AS $$
DECLARE
    v_status VARCHAR(20);
BEGIN
    SELECT status INTO v_status FROM batch WHERE batch_id = NEW.batch_id;

    IF v_status IN ('RECALLED', 'QUARANTINED') THEN
        RAISE EXCEPTION
            'Batch % is % and cannot be shipped', NEW.batch_id, v_status;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_block_unsafe_shipment
    BEFORE INSERT ON shipment_line
    FOR EACH ROW EXECUTE FUNCTION fn_block_unsafe_shipment();
```

This is the best live demo in the project. Recall a batch, then try to ship it, and watch the database itself refuse.

**3. Stored procedure — `sp_initiate_recall`.** See section 9.

Further triggers: `trg_guard_composition` (no recalled inputs, no overuse, no cycles, no inputs newer than the batch), `trg_inventory_receive` and `trg_shipment_cancel` (inventory follows shipments), `trg_batch_status_guard` (RECALLED is terminal and only reachable through the procedure), `trg_audit_*` (the database writes the audit trail), `trg_audit_append_only`, and immutability on lineage and recall scope.

**4. View — `v_outlet_exposure`.** Affected units per outlet per open recall. Plus `v_batch_stock`.

**5. Indexing.** Nine indexes in `04_indexes.sql`, kept out of `01_schema.sql` so the "before" plan can be measured. `npm run bench:indexes` builds a 200k-row database, runs `EXPLAIN ANALYZE` before and after, and writes `docs/indexing-evidence.md`.

**6. Graph traversal.** Section 6.3.

**7. Vector similarity search.** Section 13.

**8. Full-text search.** A GIN index over batch descriptions powers the keyword baseline that the vector search is compared against.

---

## 8. The requirement 6 query set

Requirement 6 wants JOIN, GROUP BY, HAVING, ORDER BY, aggregates and subqueries. Nothing else in this project produces them naturally, so write them deliberately in `03_queries.sql`. Each must be a query a real operator would actually run.

1. **Exposure by outlet.** Total units of a recalled batch at each outlet. JOIN, GROUP BY, SUM, ORDER BY.
2. **Heavily affected outlets.** Same, filtered to outlets holding more than a threshold. Adds HAVING.
3. **Never shipped batches.** Batches with no shipment lines. `NOT EXISTS` subquery.
4. **Average shipment size per city.** JOIN, GROUP BY, AVG.
5. **Most recent recall per batch.** Correlated subquery.
6. **Batches with the deepest lineage.** Recursive CTE plus aggregate.
7. **Complaints per batch with no matched batch yet.** LEFT JOIN plus COUNT plus IS NULL.
8. **Outlets that have never received a recalled batch.** `NOT IN` or `NOT EXISTS` against the exposure set.

Keep them commented and numbered in the file. At evaluation, open the file rather than improvising.

---

## 9. The recall cascade

This is the hardest part of the design and the thing most likely to be asked about.

### The problem

The list of affected batches comes from **Neo4j**. The quarantine must happen in **Postgres**, atomically. A Postgres stored procedure cannot query Neo4j.

### The honest solution

The API resolves the affected set from the graph, then hands that list to the procedure. The procedure does all Postgres work in one transaction.

```
POST /api/recalls
  1. Verify the user is a MANUFACTURER.
  2. Query Neo4j for the exposure set from batchId.
     -> affectedBatchIds[], affectedOutletIds[]
  3. Call sp_initiate_recall(batchId, reason, userId, affectedBatchIds)
     inside a single Postgres transaction:
       a. INSERT INTO recall
       b. UPDATE batch SET status = 'RECALLED' for every affected batch
       c. UPDATE inventory SET stock_status = 'QUARANTINED'
          for every (outlet, batch) in the affected set
       d. INSERT INTO audit_log, one row per action
     COMMIT or ROLLBACK as a unit.
  4. Update the status property on the affected Neo4j nodes.
  5. Return the exposure report.
```

```sql
CREATE OR REPLACE PROCEDURE sp_initiate_recall(
    p_batch_id        BIGINT,
    p_reason          TEXT,
    p_user_id         BIGINT,
    p_affected_batch_ids BIGINT[]
)
LANGUAGE plpgsql AS $$
DECLARE
    v_recall_id BIGINT;
    v_rows      INT;
BEGIN
    INSERT INTO recall (batch_id, reason, initiated_by)
    VALUES (p_batch_id, p_reason, p_user_id)
    RETURNING recall_id INTO v_recall_id;

    UPDATE batch
       SET status = 'RECALLED'
     WHERE batch_id = ANY(p_affected_batch_ids);

    UPDATE inventory
       SET stock_status = 'QUARANTINED'
     WHERE batch_id = ANY(p_affected_batch_ids)
       AND quantity_on_hand > 0;
    GET DIAGNOSTICS v_rows = ROW_COUNT;

    INSERT INTO audit_log (action, entity_name, entity_id, performed_by, details)
    VALUES ('RECALL_INITIATED', 'recall', v_recall_id, p_user_id,
            format('Batch %s recalled. %s batches affected, %s inventory rows quarantined. Reason: %s',
                   p_batch_id, array_length(p_affected_batch_ids, 1), v_rows, p_reason));
END;
$$;
```

**Say this at the demo:** the cross database boundary is the API, not the procedure. That is the honest architecture, and claiming otherwise invites a question you cannot answer.

---

## 10. API routes

All under `app/api`. Every one is a Route Handler. Every one checks the session role before touching a database.

| Method and path | Role | What it does |
|---|---|---|
| `POST /api/auth/login` | public | bcrypt compare, create session |
| `POST /api/auth/logout` | any | destroy session |
| `POST /api/batches` | MANUFACTURER | create batch, MERGE Neo4j node |
| `GET /api/batches` | any | list with filters |
| `POST /api/batches/:id/composition` | MANUFACTURER | record inputs, MERGE WENT_INTO |
| `GET /api/batches/:id/provenance` | any | backward Cypher traversal |
| `GET /api/batches/:id/exposure` | any | forward Cypher traversal |
| `POST /api/shipments` | MANUFACTURER | create shipment plus lines, MERGE SHIPPED_TO. Trigger may reject. |
| `DELETE /api/shipments/:id` | MANUFACTURER | cancel, cascades to lines |
| `POST /api/recalls` | MANUFACTURER | the cascade, section 9 |
| `GET /api/recalls` | any | list |
| `PATCH /api/recalls/:id` | REGULATOR | close a recall |
| `GET /api/exposure-summary` | any | reads `v_outlet_exposure` |
| `POST /api/complaints` | any | store text, embed, match |
| `GET /api/complaints` | REGULATOR | list with matches |
| `GET /api/audit` | REGULATOR | paginated audit log |
| `GET /api/auth/me` | any | current user |
| `GET /api/batches/:id` | any | batch, inputs, outputs |
| `PATCH /api/batches/:id` | MANUFACTURER | hold (QUARANTINED) or release |
| `GET /api/batches/:id/compare` | any | recursive CTE vs Cypher, live, with agreement check |
| `GET /api/batches/picker` | any | compact list for dropdowns |
| `GET /api/outlets` | any | outlets |
| `GET /api/shipments` | any | list |
| `GET /api/recalls/:id` | any | recall and persisted scope |
| `GET /api/reports`, `/api/reports/:id` | any | the requirement 6 queries, run live |
| `GET /api/health` | any | reachability of the three databases |

**Trigger errors must surface properly.** When the trigger raises, catch the Postgres error and return HTTP 409 with the message. Do not return 500. The whole point is showing the database refusing.

---

## 11. Screens

Keep it to six. More screens is not more marks.

1. **Login.** Two roles.
2. **Batches.** Table plus create form plus a composition editor for recording what went into what.
3. **Shipments.** Create form, outlet picker, batch lines. Must visibly show the trigger rejection.
4. **Recall.** Pick a batch, show a preview of the exposure, confirm, fire the cascade.
5. **Exposure report.** Affected outlets, depth, quantities. Also shows provenance for a chosen batch.
6. **Complaints and audit.** Complaint entry with matched batch and similarity score, plus the audit log.

Requirement 9 asks for forms, tables, search, filtering and dashboards. The exposure report is the dashboard. Add search on batch code and filtering by status on the batches table.

---

## 12. Authentication

Session based, not JWT. Simpler and sufficient.

* bcrypt with cost 10.
* Session id in an `httpOnly`, `sameSite=lax` cookie.
* Server side session store. A Postgres table is fine, or in memory for the demo.
* Every Route Handler reads the session and checks the role before any query.
* Role is constrained in the database by `chk_user_role`, so an invalid role cannot be inserted even if the application has a bug. Mention this at evaluation, since requirement 12 asks for validation at the database level.

---

## 13. The vector pipeline (Qdrant)

### Embedding

An embedding is a fixed length list of numbers representing the meaning of a piece of text. Two texts with similar meaning produce lists that point in a similar direction.

* Model: `all-MiniLM-L6-v2` (Xenova ONNX build), 384 dimensions, mean pooled, L2 normalised.
* Runs inside the Node server through transformers.js (`lib/embedding.ts`). No text leaves the machine.
* If you change the model, change `EMBEDDING_DIM` and run `npm run vectors:resync`, which recreates the Qdrant collections at the new size.

### Storage (Qdrant)

* `batch_descriptions`: point id = `batch_id`, vector of `product_name + description`, payload `batch_id, batch_code, product_name, status`, payload indexes on `batch_id` and `status`.
* `complaints`: point id = `complaint_id`, payload `outlet_id, matched_batch_id`, used to find earlier complaints that read alike.
* Distance `Cosine`, HNSW `m=16, ef_construct=100`.

### What gets embedded

* Every `complaint.complaint_text` at insert time.
* Per batch: `product_name` plus `description`. The batch code is deliberately left out; it carries no meaning and only adds noise.

### Matching

Qdrant returns cosine **similarity** as the score (higher is closer). The pipeline (`lib/complaint-matching.ts`):

1. Candidates are the batches shipped to the complaint's outlet, or every batch that reached any outlet when the outlet is unknown.
2. Qdrant searches `batch_descriptions` filtered to those candidates, top 5.
3. Lots of one product tie (same description); within 0.01 of the best score the lot most recently shipped to that outlet wins.
4. `matched_batch_id` and `similarity_score` are written back to PostgreSQL.
5. A PostgreSQL full-text search runs on the same text as the keyword baseline, shown side by side.

The SQL below is the pgvector form this replaced, kept for reference.

```sql
SELECT b.batch_id,
       b.batch_code,
       1 - (c.embedding <=> b.embedding) AS similarity
  FROM complaint c
  CROSS JOIN LATERAL (
      SELECT batch_id, batch_code, embedding
        FROM batch_embedding
       ORDER BY embedding <=> c.embedding
       LIMIT 5
  ) b
 WHERE c.complaint_id = $1;
```

Decision: neither. Batch vectors are a Qdrant collection; see the README.

### For the demo

Seed complaints that deliberately avoid the product's own words. "Bottle smelled off, bought it last Tuesday" should match a batch whose description says "foul odour reported" without sharing a single keyword. That contrast is the proof that keyword search would have failed.

---

## 14. Division of work

Requirement 2 wants both members on both database and application. Requirement 15 grades individual commits.

| Area | Ashwin | Aman |
|---|---|---|
| Database | PostgreSQL: DDL, constraints, trigger, procedure, view, indexes, the requirement 6 query set | Neo4j: graph model, Cypher layer, sync on write, resync script. Qdrant: embedding pipeline, matching query |
| API | auth, batches, shipments, recalls | provenance, exposure, complaints, audit |
| Frontend | login, batches, shipments, recall | exposure report, complaints, audit |
| Docs | sections 1 to 5, 7, 10 | sections 6, 8, 9, 11, architecture diagram |

Commit conventions:

```
feat(db): add recall cascade stored procedure
feat(graph): add forward exposure traversal
fix(api): return 409 when trigger rejects shipment line
docs: add relational schema section
```

Commit at the end of every working session, however small. A repo with three large commits the week before submission fails requirement 15 regardless of code quality.

---

## 15. Build order

Do not jump ahead. Each phase depends on the one before.

**Phase 1 — foundation**
1. `.gitignore` with `.env*` and `node_modules`. First commit.
2. Run `01_schema.sql` against a local PostgreSQL 16 or later (18 in development).
3. Verify every constraint by trying to violate it. Insert a negative quantity. Insert a self loop in composition. Both must fail.

**Phase 2 — seed data**
4. `scripts/seed.ts`. Target roughly 60 batches, 25 outlets, 120 shipments, and lineage at least four levels deep. Depth matters more than volume. A shallow graph makes the traversal demo pointless.
5. Save `EXPLAIN ANALYZE` output for the exposure query **before** indexes exist.

**Phase 3 — Postgres logic**
6. `02_functions.sql`: the ALTER, the trigger, the procedure, the view.
7. `03_queries.sql`: the eight queries from section 8.
8. Re run `EXPLAIN ANALYZE` after indexes. Save both outputs to `/docs/indexing-evidence.md`.

**Phase 4 — graph**
9. Neo4j constraints and the sync layer.
10. `scripts/resync-graph.ts`, then run it to populate from the seeded Postgres.
11. Verify forward and backward traversal return what the SQL recursive CTE returns. They must agree exactly.

**Phase 5 — application**
12. Next.js scaffold, env config, database clients.
13. Auth and session.
14. Routes in the order of section 10.
15. Screens in the order of section 11.

**Phase 6 — vector**
16. Embedding service, batch embeddings, complaint matching.
17. Seed the deliberately paraphrased complaints.

**Phase 7 — documentation and demo**
18. Remaining documentation sections, screenshots, test cases.
19. README with full setup and execution instructions.
20. Rehearse the demo script in section 16.

---

## 16. Demo script

Ten minutes. In this order.

1. **The problem in one sentence.** Contaminated batch, which outlets are affected, depth unknown.
2. **ER diagram and schema.** Point at the recursive relationship on `batch` and say it is why a graph database is here.
3. **The side by side.** Recursive CTE on the left, Cypher on the right, same result. This is the moment that wins the justification argument.
4. **Create a batch, compose it, ship it.** Shows DDL and DML working.
5. **Fire the recall.** Show the exposure report lighting up outlets several hops away.
6. **Try to ship the recalled batch.** The trigger refuses. Database level enforcement, not application code.
7. **Show the audit log.** Written in the same transaction as the quarantine.
8. **Enter a complaint with no shared keywords.** It matches the right batch. Explain why keyword search would have failed.
9. **EXPLAIN ANALYZE before and after indexes.**
10. **Individual contributions.** Open the git log.

---

## 17. Environment

`.env.local`, never committed. Provide `.env.example` with the same keys and empty values.

```
DATABASE_URL=postgresql://user:password@localhost:5432/veritrace
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_PASSWORD=
QDRANT_URL=
QDRANT_API_KEY=
SESSION_SECRET=
EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
EMBEDDING_DIM=384
BENCH_DATABASE_URL=postgresql://user:password@localhost:5432/veritrace_bench
SEED_MANUFACTURER_PASSWORD=
SEED_REGULATOR_PASSWORD=
```

Only `.env.local` is used. A stray `.env` with empty keys is shadowed by `.env.local`, which caused confusion once.

---

## 18. Repository structure

```
veritrace/
  CLAUDE.md
  README.md
  .env.example
  .gitignore
  db/
    postgres/
      01_schema.sql
      02_functions.sql
      03_queries.sql
      04_indexes.sql
    neo4j/
      constraints.cypher
      queries.cypher
  scripts/
    seed.ts  seed-complaints.ts  db-apply.ts
    resync-graph.ts  verify-graph.ts  graph-setup.ts
    resync-vectors.ts  bench-indexes.ts
    schema-diagram.ts  run-queries.ts
  app/
    api/
    (app)/  batches shipments recalls exposure complaints
    login/
  components/
  lib/
    db/  postgres.ts neo4j.ts qdrant.ts
    graph/  vector/  data/  auth/
    embedding.ts  complaint-matching.ts  http.ts  validation.ts
  tests/
  docs/
    design-spec.md  synopsis.md  demo.md  testing.md
    er/  er-diagram.(dot|svg|png)  relational-schema.(dot|svg|png)  build_er.py
    indexing-evidence.md
    screenshots/
```

---

## 19. Gotchas

* **`*0..` versus `*1..` in Cypher.** Exposure needs `*0..`. Getting this wrong silently drops the directly shipped outlets.
* **Composition direction.** Parent went into child. Both databases must agree.
* **Embedding dimension.** Changing the model without changing `EMBEDDING_DIM` and resyncing breaks every upsert.
* **Cosine distance is not similarity.** Qdrant's score is already similarity; pgvector's `<=>` would be distance.
* **Neo4j integers.** Send ids as `neo4j.int()`. A plain JS number arrives as a float and `batch_id` 7 becomes 7.0.
* **`next dev` edits this file.** Next 16 appends agent rules to CLAUDE.md unless `agentRules: false` is set in `next.config.ts`. It is set; keep it.
* **RESTRICT is 23001, not 23503.** Deleting a referenced batch raises `restrict_violation`.
* **Trigger errors are not server errors.** Return 409, not 500.
* **`EXPLAIN ANALYZE` before indexes.** Once created, the "before" measurement is gone.
* **Seed lineage depth.** Four levels minimum, otherwise the whole premise is unproven.
* **Postgres first, then Neo4j.** If Neo4j fails, surface the error loudly rather than swallowing it.
* **`.gitignore` before the first commit.** A committed `.env` stays in git history even after deletion, and requirement 13 is about exactly that.

---

## 20. Decisions log

* **2026-10-11** Vector store moved from pgvector to **Qdrant Cloud**. `complaint` keeps no vector column; `similarity_score` is still added by the ALTER in `02_functions.sql`.
* **2026-10-11** Added `app_session` (server-side sessions, HMAC of the token stored) and `recall_batch` (persisted recall scope with hop depth). `batch.description` added for embedding.
* **2026-10-11** Indexes moved to `04_indexes.sql`; the benchmark runs on a separate 200k-row database because the demo data is too small for indexes to matter.
* **2026-10-11** UI follows the Lilac (light only) look of the Sajao app, rebuilt from scratch; no code reused (requirement 17).
* **2026-10-11** Commits are made by the team members themselves; the planned sequence lives in `commits.md` (git-ignored).
