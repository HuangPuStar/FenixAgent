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
