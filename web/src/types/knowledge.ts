export interface KnowledgeResourceInfo {
  id: string;
  knowledgeBaseId: string;
  sourceName: string;
  sourceType: string;
  sourcePath: string | null;
  remoteId: string | null;
  status: string;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseInfo {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  provider: string | null;
  remoteId: string | null;
  remoteAccountId: string | null;
  remoteUserId: string | null;
  status: string;
  lastError: string | null;
  bindingsCount: number;
  resourcesCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface KnowledgeBaseDetail extends KnowledgeBaseInfo {
  recentResources: KnowledgeResourceInfo[];
}

export interface KnowledgeUploadResponse {
  items: KnowledgeResourceInfo[];
}
