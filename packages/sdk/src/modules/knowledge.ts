import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  CreateKnowledgeBaseRequest,
  DeleteKnowledgeBaseResponse,
  DeleteKnowledgeResourceResponse,
  ImportKnowledgeUrlResponse,
  KnowledgeBaseInfo,
  KnowledgeBaseListResponse,
  KnowledgeResourceItem,
  UpdateKnowledgeBaseRequest,
  UploadKnowledgeResourcesResponse,
} from "../types/schemas";

export class KnowledgeBaseApi extends BaseApi {
  async list(): Promise<ApiResult<KnowledgeBaseListResponse>> {
    return this._get<KnowledgeBaseListResponse>("/web/knowledgeBases");
  }
  async create(body: CreateKnowledgeBaseRequest): Promise<ApiResult<KnowledgeBaseInfo>> {
    return this.post<KnowledgeBaseInfo>("/web/knowledgeBases", body);
  }
  async get(params: { id: string }): Promise<ApiResult<KnowledgeBaseInfo>> {
    return this._get<KnowledgeBaseInfo>("/web/knowledgeBases/:id", { params });
  }
  async update(params: { id: string }, body: UpdateKnowledgeBaseRequest): Promise<ApiResult<KnowledgeBaseInfo>> {
    return this.patch<KnowledgeBaseInfo>("/web/knowledgeBases/:id", body, { params });
  }
  async delete(params: { id: string }): Promise<ApiResult<DeleteKnowledgeBaseResponse>> {
    return this.del<DeleteKnowledgeBaseResponse>("/web/knowledgeBases/:id", { params });
  }
  async uploadResources(
    params: { id: string },
    formData: FormData,
  ): Promise<ApiResult<UploadKnowledgeResourcesResponse>> {
    return this._upload<UploadKnowledgeResourcesResponse>("/web/knowledgeBases/:id/resources/upload", formData, {
      params,
    });
  }
  async importUrl(
    params: { id: string },
    body: { url: string; sourceName?: string },
  ): Promise<ApiResult<ImportKnowledgeUrlResponse>> {
    return this.post<ImportKnowledgeUrlResponse>("/web/knowledgeBases/:id/resources/url", body, { params });
  }
  async listResources(params: { id: string }): Promise<ApiResult<KnowledgeResourceItem[]>> {
    return this._get<KnowledgeResourceItem[]>("/web/knowledgeBases/:id/resources", { params });
  }
  async deleteResource(params: {
    id: string;
    resourceId: string;
  }): Promise<ApiResult<DeleteKnowledgeResourceResponse>> {
    return this.del<DeleteKnowledgeResourceResponse>("/web/knowledgeBases/:id/resources/:resourceId", { params });
  }
}
