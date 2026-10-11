# Testing

Four kinds of evidence, each reproducible with one command.

| What | Command | Result |
|---|---|---|
| 42 database and API test cases | `npm test` | 42 / 42 pass |
| SQL and Cypher agree for every batch | `npm run graph:verify` | 66 / 66 batches identical |
| Paraphrased complaints matched by meaning | `npm run complaints:seed` | 8 / 8 by vector search, 3 / 8 by keyword search |
| Index speed-up at scale | `npm run bench:indexes` | 84× to 440× faster; `docs/indexing-evidence.md` |

## 1. Test cases (`npm test`)

Written with Node's built-in test runner (`node:test`). Every database test runs inside a transaction that is rolled back at the end, so the suite runs safely against the development database; tests that expect a refusal wrap the statement in a SAVEPOINT so the rest of the test continues. Expected errors are matched on SQLSTATE and, where it matters, on the constraint name or message.

### 1.1 Validation at the database level (requirement 12)

| ID | Case | Expected | Result |
|---|---|---|---|
| TC-01 | role outside MANUFACTURER / REGULATOR | 23514 `chk_user_role` | pass |
| TC-02 | plain-text password | 23514 `chk_user_password_is_bcrypt` | pass |
| TC-03 | zero or negative quantity | 23514 `chk_batch_qty` | pass |
| TC-04 | manufacture date in the future | 23514 `chk_batch_date` | pass |
| TC-05 | malformed batch code | 23514 `chk_batch_code_format` | pass |
| TC-06 | duplicate batch code | 23505 unique violation | pass |
| TC-07 | batch as its own input | P0001 from the cycle trigger; with the trigger disabled, 23514 `chk_bc_no_self_loop` | pass |
| TC-08 | malformed outlet email | 23514 `chk_outlet_email` | pass |
| TC-09 | shipment line for a non-existent batch | 23503 foreign key | pass |
| TC-10 | similarity score above 1 (constraint added by ALTER) | 23514 `chk_complaint_score` | pass |
| TC-11 | score without a matched batch | 23514 `chk_complaint_match_pair` | pass |
| TC-12 | delete a shipped batch | 23001 restrict violation | pass |
| TC-13 | schema shape: 12 tables, 20+ CHECKs | counts match | pass |

### 1.2 Triggers

| ID | Case | Expected | Result |
|---|---|---|---|
| TC-14 | ship a RECALLED batch | P0001 "is RECALLED and cannot be shipped" | pass |
| TC-15 | ship a batch on hold | P0001 "QUARANTINED" | pass |
| TC-16 | ship more than remains | P0001 "only 10.00 units left" | pass |
| TC-17 | lineage cycle A → B → A | P0001 "would create a lineage cycle" | pass |
| TC-18 | input newer than its consumer | P0001 "is newer than" | pass |
| TC-19 | recalled batch used as input | P0001 "cannot be used as an input" | pass |
| TC-20 | delete or edit lineage | P0001 "lineage records are permanent" | pass |
| TC-21 | shipment books stock; cancelling returns it; lines cascade | inventory 10 → 0, no lines left | pass |
| TC-22 | cancel a shipment of a recalled batch | P0001 "evidence of exposure" | pass |
| TC-23 | cancel a shipment already partly sold | P0001 "already sold" | pass |
| TC-24 | set RECALLED with a plain UPDATE | P0001 "only be recalled through sp_initiate_recall" | pass |
| TC-25 | every write audited and attributed | 3 × BATCH_CREATED, 2 × COMPOSITION_RECORDED, SHIPMENT_CREATED, all by the acting user | pass |
| TC-26 | UPDATE or DELETE on the audit log | P0001 "append only" | pass |
| TC-27 | delete a user who has audit rows | rows kept, `performed_by` NULL | pass |

### 1.3 Recall procedure, lineage functions, view

| ID | Case | Expected | Result |
|---|---|---|---|
| TC-28 | `fn_downstream_batches` on a diamond four levels deep | every descendant with its shortest depth | pass |
| TC-29 | `fn_upstream_batches` | exact inverse | pass |
| TC-30 | full cascade | all five batches RECALLED, stock quarantined at the direct outlet (depth 0) and at depth 3, unrelated outlet untouched, one audit row per batch | pass |
| TC-31 | affected set missing a batch (stale graph) | P0001 "Graph projection is stale" **and nothing changed**: atomic | pass |
| TC-32 | REGULATOR initiates; recall twice | 42501; P0001 "already recalled" | pass |
| TC-33 | `v_outlet_exposure` | 2 outlets, 5 and 7 units, depth 3, no double counting | pass |
| TC-34 | close by MANUFACTURER; close; close again | 42501; CLOSED and gone from the view; P0001 "already closed" | pass |
| TC-35 | edit a recall's scope | P0001 "scope of a recall is permanent" | pass |

### 1.4 API layer

| ID | Case | Expected | Result |
|---|---|---|---|
| TC-36 | trigger refusal through the API | HTTP 409, database message kept | pass |
| TC-37 | CHECK violation | HTTP 422, readable message | pass |
| TC-38 | procedure role check | HTTP 403 | pass |
| TC-39 | unexpected error | HTTP 500, no internals leaked | pass |
| TC-40 | invalid input | HTTP 400 naming the field | pass |
| TC-41 | batch code normalised, quantity rounded to NUMERIC(12,2) | upper-cased, 12.35 | pass |
| TC-42 | same batch twice in one shipment | rejected | pass |

### 1.5 End-to-end checks through the running app

Run with the dev server and `curl`, and through the browser:

| Check | Result |
|---|---|
| unauthenticated request | 401 |
| wrong password | 401, generic message |
| REGULATOR-only endpoint as MANUFACTURER | 403 |
| future manufacture date | 422 naming `chk_batch_date` |
| ship recalled AMN-FIN-001 | 409 "Batch AMN-FIN-001 is RECALLED and cannot be shipped", shown in the UI as "Refused by the database" |
| overship | 409 "only 601.00 units left" |
| clean shipment while Neo4j unreachable | 201, PostgreSQL committed, `sync.graph = failed` shown to the user, `GRAPH_SYNC_FAILED` audited |
| cancel a clean shipment | 200, stock returned |
| cancel a shipment holding a recalled batch | 409 "evidence of exposure" |
| complaint "the tropical juice smelled fermented and fizzy" | vector: Alphonso Mango Nectar; keyword: Cocoa Beans (wrong, via the word "fermented") |

## 2. SQL and Cypher agreement (`npm run graph:verify`)

For every batch the script runs three questions both ways and compares the result sets exactly:

* forward exposure: (outlet, batch, shipment) triples
* recall scope: (batch, hop depth) pairs
* provenance: (batch, hop depth) pairs

Result (2026-10-11, Neo4j 2026.09.0, PostgreSQL 18.4): **all 66 batches agree** on all three questions, hop depths included.

| Batch | Exposure rows (SQL / Cypher) | Downstream (SQL / Cypher) | Provenance (SQL / Cypher) |
|---|---|---|---|
| SUG-RAW-001 (raw sugar) | 102 / 102 | 13 / 13 | 0 / 0 |
| SUG-RAW-003 (raw sugar, also sold retail) | 67 / 67 | 10 / 10 | 0 / 0 |
| MNG-RAW-002 (raw mango pulp) | 30 / 30 | 5 / 5 | 0 / 0 |
| CCB-FIN-001 (finished biscuits) | 19 / 19 | 1 / 1 | 15 / 15 |
| … 62 more | identical | identical | identical |

`npm run graph:resync` beforehand rebuilt 66 batch nodes, 25 outlets, 73 `WENT_INTO` and 242 `SHIPPED_TO` relationships, matching PostgreSQL row for row.

## 3. Complaint matching (`npm run complaints:seed`)

| Complaint (abridged) | Shares words with the description? | Vector match | Keyword match |
|---|---|---|---|
| "Bottle smelled off, bought it last Tuesday…" | no | AMN-FIN (mango nectar) ✓ | nothing |
| "The kids' little carton had turned sour and lumpy…" | no | CMM-FIN (chocolate milk) ✓ | nothing |
| "Those chocolatey snacks from the school tiffin tasted rancid…" | no | CCB-FIN (cream biscuits) ✓ | nothing |
| "The makhani sauce had mould on it…" | no | BMP-FIN (masala paste) ✓ | nothing |
| "Bit down on a sharp hard sliver in the nutty stuff…" | no | PNB-FIN (peanut spread) ✓ | nothing |
| "The yellow fruit juice gave my whole family stomach cramps…" | "fruit" | AMN-FIN ✓ | AMN-FIN ✓ |
| "Kids flavoured milk smelled bad…" | "flavoured", "milk" | CMM-FIN ✓ | CMM-FIN ✓ |
| "Biscuit packet was soggy and the cream inside…" | "biscuit", "cream" | CCB-FIN ✓ | CCB-FIN ✓ |

Vector search: 8 / 8. Keyword search: 3 / 8, and only where the customer happened to use the product's own words.

Scores are modest (0.23 to 0.46): MiniLM is a small model. Two things keep it reliable here: candidates are restricted to batches that actually reached the outlet (or any outlet), and descriptions say what the product is rather than listing ingredients. An earlier masala description that was mostly an ingredient list lost to peanut spread; rewriting it fixed the match.

## 4. Indexing

See `docs/indexing-evidence.md` for the full plans.

| Query | Before | After | Speed-up |
|---|---:|---:|---:|
| Forward exposure (recursive CTE) | 33.98 ms | 0.36 ms | 95× |
| Backward provenance | 7.44 ms | 0.03 ms | 248× |
| Recall quarantine lookup | 7.91 ms | 0.02 ms | 439× |
| Latest shipments to an outlet | 1.09 ms | 0.01 ms | 84× |
| Audit log page by action | 5.13 ms | 0.01 ms | 428× |
