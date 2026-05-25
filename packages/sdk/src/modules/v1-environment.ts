import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type { BridgeRegistrationRequest, BridgeRegistrationResponse, StatusOkResponse } from "../types/schemas";

export class V1EnvironmentApi extends BaseApi {
  async registerBridge(body: BridgeRegistrationRequest): Promise<ApiResult<BridgeRegistrationResponse>> {
    return this.post("/v1/environments/bridge", body);
  }
  async deregisterBridge(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.del("/v1/environments/bridge/:id", { params });
  }
  async reconnectBridge(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/bridge/reconnect", undefined, { params });
  }
  async pollWork(params: { id: string }): Promise<ApiResult<unknown>> {
    return this._get("/v1/environments/:id/work/poll", { params });
  }
  async ackWork(params: { id: string; workId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/work/:workId/ack", undefined, { params });
  }
  async stopWork(params: { id: string; workId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/work/:workId/stop", undefined, { params });
  }
  async heartbeat(params: { id: string; workId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/environments/:id/work/:workId/heartbeat", undefined, { params });
  }
}
