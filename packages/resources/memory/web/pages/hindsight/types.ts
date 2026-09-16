/** 内存单元 */
export interface MemoryItem {
  id: string;
  text: string;
  context: string;
  date: string;
  fact_type: "world" | "experience" | "observation";
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string;
  chunk_id: string | null;
  proof_count: number;
  tags: string[];
  consolidated_at: string | null;
  consolidation_failed_at: string | null;
}

/** 内存列表响应 */
export interface MemoriesResponse {
  items: MemoryItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 内存详情 */
export interface MemoryDetail {
  id: string;
  text: string;
  context: string;
  date: string;
  type: string;
  mentioned_at: string | null;
  occurred_start: string | null;
  occurred_end: string | null;
  entities: string[];
  document_id: string | null;
  chunk_id: string | null;
  tags: string[];
  observation_scopes: string | string[][] | null;
}

/** 文档 */
export interface DocumentItem {
  document_id: string;
  bank_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  chunk_count: number;
  memory_unit_count: number;
  tags: string[];
}

/** 文档列表响应 */
export interface DocumentsResponse {
  items: DocumentItem[];
  total: number;
  limit: number;
  offset: number;
}

/** 文档分块 */
export interface DocumentChunk {
  chunk_id: string;
  document_id: string;
  bank_id: string;
  chunk_index: number;
  chunk_text: string;
  created_at: string;
}

/** 心理模型 */
export interface MentalModel {
  id: string;
  bank_id: string;
  name: string;
  source_query: string;
  content: string;
  tags: string[];
  max_tokens: number;
  last_refreshed_at: string;
  created_at: string;
  is_stale?: boolean | null;
}

/** Recall 响应 */
export interface RecallResponse {
  facts: Array<{
    id: string;
    text: string;
    type: string;
    score: number;
  }>;
}

/** Reflect 响应 */
export interface ReflectResponse {
  answer: string;
  facts?: Array<{ id: string; text: string }>;
}

/** Status 响应 */
export interface HindsightStatus {
  enabled: boolean;
  url?: string;
  bankId?: string;
}

/** 实体 */
export interface EntityItem {
  id: string;
  canonical_name: string;
  mention_count: number;
  first_seen: string | null;
  last_seen: string | null;
}

/** 实体列表响应 */
export interface EntityListResponse {
  items: EntityItem[];
  total: number;
}

/** 实体共现边 */
export interface EntityEdge {
  data: {
    source: string;
    target: string;
    weight: number;
    lastCooccurred: string | null;
  };
}

/** 实体共现图谱响应 */
export interface EntityGraphResponse {
  nodes: Array<{ data: { id: string; [key: string]: unknown } }>;
  edges: EntityEdge[];
}

/** Graph API 返回的表格行数据（MemoryItem 的超集，含可选字段） */
export interface MemoryTableRow {
  id: string;
  text: string;
  entities?: string | string[];
  context?: string;
  occurred_start?: string | null;
  occurred_end?: string | null;
  mentioned_at?: string | null;
  proof_count?: number;
  tags?: string[];
  fact_type?: string;
  chunk_id?: string | null;
  document_id?: string | null;
  node_id?: string;
}

/** Graph API 返回的整体数据结构 */
export interface GraphApiData {
  table_rows?: MemoryTableRow[];
  nodes?: Array<{ data: { id: string; label?: string; color?: string } }>;
  edges?: Array<{
    data: {
      source: string;
      target: string;
      color?: string;
      lineStyle?: string;
      linkType?: string;
      entityName?: string;
      weight?: number;
      similarity?: number;
    };
  }>;
  total_units?: number;
}

/** Bank 统计信息 */
export interface BankStats {
  pending_consolidation?: number;
  last_consolidated_at?: string | null;
}
