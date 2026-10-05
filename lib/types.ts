/*
 * Shapes shared by the API and the screens. Types only: safe to import
 * from client components because nothing here touches a database.
 */

export type Role = "MANUFACTURER" | "REGULATOR";
export type BatchStatus = "ACTIVE" | "QUARANTINED" | "RECALLED";
export type RecallStatus = "OPEN" | "CLOSED";

export interface SessionUser {
  userId: number;
  username: string;
  role: Role;
}

export interface Batch {
  batch_id: number;
  batch_code: string;
  product_name: string;
  description: string | null;
  manufacture_date: string;
  quantity_produced: number;
  status: BatchStatus;
  quantity_consumed: number;
  quantity_shipped: number;
  quantity_available: number;
  input_count: number;
  output_count: number;
}

export interface CompositionInput {
  batch_id: number;
  batch_code: string;
  product_name: string;
  status: BatchStatus;
  quantity_used: number;
}

export interface Outlet {
  outlet_id: number;
  outlet_name: string;
  city: string;
  contact_email: string | null;
}

export interface ShipmentLine {
  batch_id: number;
  batch_code: string;
  product_name: string;
  status: BatchStatus;
  quantity: number;
}

export interface Shipment {
  shipment_id: number;
  outlet_id: number;
  outlet_name: string;
  city: string;
  shipment_date: string;
  dispatched_by: string;
  lines: ShipmentLine[];
  total_units: number;
}

export interface Recall {
  recall_id: number;
  batch_id: number;
  batch_code: string;
  product_name: string;
  reason: string;
  initiated_by: string;
  initiated_at: string;
  recall_status: RecallStatus;
  closed_by: string | null;
  closed_at: string | null;
  batches_in_scope: number;
  outlets_exposed: number;
  units_quarantined: number;
}

/** One row of the forward exposure: an outlet that received an affected batch. */
export interface ExposureRow {
  outletId: number;
  outletName: string;
  city: string;
  affectedBatchId: number;
  affectedBatchCode: string;
  hopDepth: number;
  shipmentId: number;
  quantity: number;
}

export interface LineageNode {
  batchId: number;
  batchCode: string;
  productName: string;
  status: BatchStatus;
  hopDepth: number;
}

export interface LineageEdge {
  from: number;
  to: number;
  quantityUsed: number;
}

export interface ExposureReport {
  source: LineageNode;
  downstream: LineageNode[];
  edges: LineageEdge[];
  outlets: ExposureRow[];
  engine: "neo4j";
  elapsedMs: number;
}

export interface ProvenanceReport {
  source: LineageNode;
  upstream: LineageNode[];
  edges: LineageEdge[];
  engine: "neo4j";
  elapsedMs: number;
}

export interface EngineRun {
  engine: "postgres" | "neo4j";
  query: string;
  rows: number;
  elapsedMs: number;
  keys: string[];
}

export interface ComparisonReport {
  batchCode: string;
  sql: EngineRun;
  cypher: EngineRun;
  agree: boolean;
  onlyInSql: string[];
  onlyInCypher: string[];
}

export interface OutletExposure {
  recall_id: number;
  source_batch_id: number;
  source_batch_code: string;
  initiated_at: string;
  outlet_id: number;
  outlet_name: string;
  city: string;
  affected_batches: number;
  min_hop_depth: number;
  max_hop_depth: number;
  units_shipped: number;
  units_quarantined: number;
}

export interface VectorMatch {
  batchId: number;
  batchCode: string;
  productName: string;
  status: BatchStatus;
  similarity: number;
  lastShippedToOutlet: string | null;
}

export interface KeywordMatch {
  batchId: number;
  batchCode: string;
  productName: string;
  rank: number;
}

export interface SimilarComplaint {
  complaintId: number;
  text: string;
  similarity: number;
  matchedBatchCode: string | null;
}

export interface Complaint {
  complaint_id: number;
  outlet_id: number | null;
  outlet_name: string | null;
  complaint_text: string;
  received_at: string;
  matched_batch_id: number | null;
  matched_batch_code: string | null;
  matched_product: string | null;
  similarity_score: number | null;
}

export interface ComplaintAnalysis {
  complaint: Complaint;
  vectorMatches: VectorMatch[];
  keywordMatches: KeywordMatch[];
  keywordQuery: string;
  similarComplaints: SimilarComplaint[];
  candidateScope: "outlet" | "shipped";
  elapsedMs: { embed: number; search: number };
}

export interface AuditEntry {
  log_id: number;
  action: string;
  entity_name: string;
  entity_id: number | null;
  performed_by: string | null;
  performed_at: string;
  details: string | null;
}

export interface Page<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Report {
  id: string;
  title: string;
  summary: string;
  features: string[];
  sql: string;
  columns: string[];
  rows: Record<string, unknown>[];
  elapsedMs: number;
}

/** Postgres succeeded; this reports whether the Neo4j / Qdrant projection did too. */
export interface SyncStatus {
  graph: "ok" | "failed" | "skipped";
  vector: "ok" | "failed" | "skipped";
  errors: string[];
}

export interface ApiErrorBody {
  error: string;
  code: string;
  detail?: string;
  hint?: string;
  source?: "database" | "validation" | "auth" | "graph" | "vector" | "server";
}
