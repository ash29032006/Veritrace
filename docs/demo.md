# Demo script (10 minutes)

Before the evaluation: `npm run setup` on a fresh database, `npm run dev`, sign in as **maker** in one browser window and **inspector** in a private window. Open `db/postgres/03_queries.sql` and Neo4j Browser in two more tabs.

| # | Time | Do | Say |
|---|---|---|---|
| 1 | 0:30 | Show the title page. | "A contaminated batch. Which outlets have it? The depth of processing between the two is unknown." |
| 2 | 1:00 | Open `docs/er/er-diagram.png`. Point at COMPOSED_OF. | "This recursive many-to-many relationship on BATCH is why a graph database is here." |
| 3 | 1:30 | Exposure → **SQL vs Cypher**, pick **SUG-RAW-001**. | "Same question, two languages, run live. Recursive CTE on the left, one Cypher pattern on the right. The app checks the results are identical, row for row." |
| 4 | 1:00 | Batches → **New batch**, e.g. `CCB-FIN-004` made from `BBK-INT-002` and `CRF-INT-002`. Then Shipments → ship 20 of it to any outlet. | "Every input was checked by a trigger: active, enough left, older than this batch, no cycle. The shipment booked stock at the outlet by trigger too." |
| 5 | 1:30 | Recalls → pick **SUG-RAW-003**, show the lineage graph, enter a reason, **Initiate recall**. | "Neo4j found everything downstream: outlets that bought the sugar directly, depth 0, and outlets four processing steps away. One stored procedure, one transaction: statuses, quarantine, audit. And it re-checks the graph with a recursive CTE before touching anything." |
| 6 | 1:00 | Shipments → try to ship **SYR-INT-001** or a recalled finished batch. | "The database refuses, not the app: trigger `trg_block_unsafe_shipment`, HTTP 409. Try cancelling an old shipment of a recalled batch: refused too, it's evidence." |
| 7 | 0:45 | In the inspector window: Complaints → **Audit log**, filter `BATCH_RECALLED`. | "Written by the database in the same transaction as the quarantine. Append only: a trigger refuses UPDATE and DELETE." |
| 8 | 1:15 | Complaints → type *"The makhani sauce had mould on it the day I opened it, and the lid had bulged."* | "Not one word in common with 'butter masala paste'. Keyword search finds nothing; vector search finds the right product and narrows to the lot shipped to that outlet." Optionally also *"the tropical juice smelled fermented"*: keyword search picks cocoa beans because of the word "fermented". |
| 9 | 0:45 | Open `docs/indexing-evidence.md`. | "Exposure query on 200k shipment lines: 34 ms to 0.36 ms once `idx_shipment_line_batch` exists. The before plan is a sequential scan; the after plan is an index scan." |
| 10 | 0:45 | `git log --format='%an %s' | head -30` | "Individual contributions." |

## If something breaks

| Symptom | Fix |
|---|---|
| Health panel shows Neo4j down | start the DBMS in Neo4j Desktop; then `npm run graph:resync` |
| "Graph projection is stale" on a recall | `npm run graph:resync`, retry: this is the safety check working |
| SQL vs Cypher disagree | `npm run graph:resync` |
| Complaint shows "Vector matching failed" | check `QDRANT_URL` / `QDRANT_API_KEY`, then `npm run vectors:resync` |
| Want a clean slate | `npm run setup` (rebuilds all three databases from scratch) |

## Questions to expect

* **Why not do the recall entirely inside a stored procedure?** A PostgreSQL procedure cannot query Neo4j. The API resolves the affected set from the graph, the procedure does all PostgreSQL work atomically. The cross-database boundary is the API.
* **What if Neo4j is out of date?** The procedure recomputes the downstream set with a recursive CTE and refuses if anything is missing. PostgreSQL is the source of truth.
* **What if Neo4j fails after PostgreSQL commits?** The change stands, the failure is shown to the user and written to the audit log as `GRAPH_SYNC_FAILED`, and `graph:resync` repairs it.
* **Why Qdrant and not pgvector?** A separate vector database keeps three genuinely different engines, and filters inside the HNSW search. Complaint text and the match result stay in PostgreSQL.
* **Is Neo4j faster?** Not at this size; PostgreSQL is. The argument is the shape of the query, and the CTE needs `CYCLE` handling and de-duplication that Cypher's pattern does implicitly.
* **Why is there a CHECK on the password hash?** Requirement 12 and 13 together: even a buggy application cannot store a plain-text password.
