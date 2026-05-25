import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  BatchDeleteResponse,
  FileContent,
  FileListResponse,
  FileUploadResponse,
  FileWriteResult,
  MkdirResponse,
  OkResponse,
  RenameResponse,
  TreeResponse,
} from "../types/schemas";

export class FileApi extends BaseApi {
  async listDir(params: { id: string }, query?: { path?: string }): Promise<ApiResult<FileListResponse>> {
    return this._get<FileListResponse>("/web/environments/:id/user", { params, query });
  }
  async readFile(params: { id: string; path: string }, query?: { preview?: boolean }): Promise<ApiResult<FileContent>> {
    return this._get<FileContent>(`/web/environments/:id/user/${params.path}`, {
      params: { id: params.id },
      query,
    });
  }
  async upload(params: { id: string; path?: string }, formData: FormData): Promise<ApiResult<FileUploadResponse>> {
    const url = params.path ? `/web/environments/:id/user/${params.path}` : "/web/environments/:id/user/";
    return this._upload<FileUploadResponse>(url, formData, { params: { id: params.id } });
  }
  async writeFile(
    params: { id: string; path: string },
    body: { content: string },
  ): Promise<ApiResult<FileWriteResult>> {
    return this.put<FileWriteResult>(`/web/environments/:id/user/${params.path}`, body, {
      params: { id: params.id },
    });
  }
  async deleteFile(params: { id: string; path: string }): Promise<ApiResult<OkResponse>> {
    return this.del<OkResponse>(`/web/environments/:id/user/${params.path}`, {
      params: { id: params.id },
    });
  }
}

export class UserFileApi extends BaseApi {
  async tree(params: { id: string }): Promise<ApiResult<TreeResponse>> {
    return this._get<TreeResponse>("/web/environments/:id/user-file/tree", { params });
  }
  async rename(params: { id: string }, body: { oldPath: string; newPath: string }): Promise<ApiResult<RenameResponse>> {
    return this.post<RenameResponse>("/web/environments/:id/user-file/rename", body, { params });
  }
  async mkdir(params: { id: string }, body: { path: string }): Promise<ApiResult<MkdirResponse>> {
    return this.post<MkdirResponse>("/web/environments/:id/user-file/mkdir", body, { params });
  }
  async batchDelete(params: { id: string }, body: { paths: string[] }): Promise<ApiResult<BatchDeleteResponse>> {
    return this.del<BatchDeleteResponse>("/web/environments/:id/user-file/batch", {
      params,
      body,
    });
  }
}
