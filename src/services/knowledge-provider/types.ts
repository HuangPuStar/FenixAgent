export type KnowledgeBaseStatus = "empty" | "indexing" | "ready" | "error";
export type KnowledgeResourceStatus = "pending" | "processing" | "ready" | "error";

export interface KnowledgeBaseSnapshot {
  remoteId: string | null;
  name: string;
  status: KnowledgeBaseStatus;
  description?: string | null;
  lastError?: string | null;
}

export interface KnowledgeResourceSnapshot {
  remoteId: string;
  knowledgeBaseRemoteId?: string | null;
  sourceName: string;
  sourceType: string;
  status: KnowledgeResourceStatus;
  source?: string | null;
  lastError?: string | null;
}

export interface KnowledgeSearchResult {
  title: string;
  snippet: string;
  source: string;
  score: number;
  knowledgeBaseId?: string | null;
  resourceId?: string | null;
}

export interface KnowledgeResourceContent {
  resourceId: string;
  title?: string | null;
  content: string;
  source?: string | null;
}

export interface KnowledgeProvider {
  createKnowledgeBase(input: {
    organizationId: string;
    userId: string;
    slug: string;
    name: string;
    description?: string;
  }): Promise<KnowledgeBaseSnapshot>;
  /** 删除整个知识库；RagFlow 不同版本可能使用单资源路径或集合端点。 */
  deleteKnowledgeBase(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<void>;
  addResource(input: {
    knowledgeBaseRemoteId?: string | null;
    targetRemoteId?: string | null;
    remoteAccountId: string;
    remoteUserId: string;
    filePath?: string;
    url?: string;
    sourceName?: string;
    wait?: boolean;
  }): Promise<KnowledgeResourceSnapshot>;
  listResources(input: {
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<KnowledgeResourceSnapshot[]>;
  deleteResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
    recursive?: boolean;
  }): Promise<void>;
  search(input: {
    knowledgeBases: Array<{
      remoteId: string;
      remoteAccountId: string;
      remoteUserId: string;
    }>;
    query: string;
    topK: number;
  }): Promise<KnowledgeSearchResult[]>;
  readResource(input: {
    resourceRemoteId: string;
    knowledgeBaseRemoteId: string;
    remoteAccountId: string;
    remoteUserId: string;
  }): Promise<KnowledgeResourceContent>;
}
