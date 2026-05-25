import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type { CodeSessionBridgeResponse, CreateCodeSessionRequest, CreateCodeSessionResponse } from "../types/schemas";

export class V2CodeSessionApi extends BaseApi {
  async create(body: CreateCodeSessionRequest): Promise<ApiResult<CreateCodeSessionResponse>> {
    return this.post("/v1/code/sessions", body);
  }
  async bridge(params: { id: string }): Promise<ApiResult<CodeSessionBridgeResponse>> {
    return this.post("/v1/code/sessions/:id/bridge", undefined, { params });
  }
}
