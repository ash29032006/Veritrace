# VERITRACE: Batch Provenance and Recall Cascade Engine

**DBMS Experiential Learning: Level 3 Project Synopsis**

Ashwin C H (PES1UG24AM900) and Aman Priyanch (PES1UG24AM030)
Department of CSE (AI and ML), PES University
Course Instructor: Dr. Nagasundari S

---

## Problem statement

Manufacturers produce goods in batches, and one batch is often used as an input to another batch before the finished product is split across shipments to many retail outlets. When a batch is found to be contaminated, the question that has to be answered is not who received that batch, but which outlets received any product that contains material from it. The chain from the bad batch to an affected outlet may pass through one processing step or five, and the number of steps is not known when the query is written. In SQL this needs a recursive CTE, which is long and hard to filter on the properties of each link in the chain. Carrying out the recall is a different kind of problem. The batch status, the inventory quarantine at every affected outlet and the audit record all have to succeed or fail together, which is what transactions are for. A third problem is that customer complaints arrive as free text with no batch number in them, so they cannot be matched to a batch by keyword search. VERITRACE handles these three problems with three different databases.

## Objectives

* Store batch composition, shipments and inventory in a normalised relational schema with foreign key integrity.
* Store batch lineage as a directed graph so that forward exposure and backward provenance can be traversed to any depth.
* Run a recall as a single transaction covering batch status, inventory quarantine and audit logging.
* Match free text customer complaints to likely batches using vector similarity search.
* Block dispatch of recalled stock in the database itself rather than in application code.
* Build a Next.js interface with two roles over a server side API layer, with no credentials in the source code.

## Databases used and why

| Data | Database | Reason |
|---|---|---|
| Batches, outlets, shipments, inventory, recalls, users, audit log | PostgreSQL | Needs ACID transactions and foreign key integrity, since a recall that quarantines stock at many outlets has to be atomic. PostgreSQL is used instead of MySQL for its array parameters, triggers that fire on cascaded deletes, transactional DDL and PL/pgSQL, all of which the recall cascade uses. |
| Batch lineage and outlet distribution network | Neo4j | Needs traversal to an unknown depth with filtering on the properties of each link. The recursive CTE for the same exposure query is about 25 lines; the Cypher version is three. Both will be shown side by side at evaluation. |
| Customer complaint text | Qdrant | Complaints contain no batch identifier and are written in ordinary language, so keyword search fails on paraphrase. Complaint text is embedded and matched against batch and product descriptions by cosine similarity, in a dedicated vector database. |

## Scope

In scope: batch and composition entry, shipment recording, forward exposure and backward provenance traversal, transactional recall with inventory quarantine, audit logging, complaint entry and similarity matching, and two roles (Manufacturer and Regulator).

Out of scope: sensor or IoT data, delivery routing and scheduling, procurement and payment workflows, and regulatory filing formats.

## Advanced database features

Seven are planned against the required minimum of four. A transaction for the recall cascade, a trigger that rejects any shipment line referencing a recalled batch, a stored procedure holding the recall logic, a view for the per outlet exposure summary, indexing shown through EXPLAIN ANALYZE, graph traversal using variable length Cypher paths, and vector similarity search on complaint embeddings.

## Technology stack

Next.js with the App Router for the frontend and Route Handlers for the API layer. PostgreSQL 16 or later, Neo4j 5, and Qdrant. Sentence embeddings from all-MiniLM-L6-v2, computed locally. Passwords hashed with bcrypt and session based authentication. Database configuration through environment variables. Git and GitHub for version control.

## Expected outcome

A working web application where a recall started on any batch traverses the lineage graph to find every downstream outlet, quarantines the matching inventory in one transaction, and writes an audit record that cannot be edited. Complaints entered as plain text are matched to the batches they most likely refer to. Each database is used for the kind of data it handles best rather than to demonstrate the technology.
