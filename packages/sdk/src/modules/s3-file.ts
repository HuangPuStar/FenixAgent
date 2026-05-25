import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  OkResponse,
  S3FileListResponse,
  S3PresignGetResponse,
  S3PresignPutResponse,
  S3UploadResponse,
} from "../types/schemas";

export class S3FileApi extends BaseApi {
  async list(query: { sessionId: string; prefix?: string }): Promise<ApiResult<S3FileListResponse>> {
    return this._get<S3FileListResponse>("/web/s3/files", { query });
  }
  async presignGet(query: { sessionId: string; key: string }): Promise<ApiResult<S3PresignGetResponse>> {
    return this._get<S3PresignGetResponse>("/web/s3/files/presign", { query });
  }
  async presignPut(body: {
    sessionId: string;
    key: string;
    contentType: string;
  }): Promise<ApiResult<S3PresignPutResponse>> {
    return this.post<S3PresignPutResponse>("/web/s3/files/presign", body);
  }
  async upload(query: { sessionId: string }, formData: FormData): Promise<ApiResult<S3UploadResponse>> {
    return this._upload<S3UploadResponse>("/web/s3/files/upload", formData, { query });
  }
  async deleteFile(body: { sessionId: string; key: string }): Promise<ApiResult<OkResponse>> {
    return this.del<OkResponse>("/web/s3/files", { body });
  }
}
