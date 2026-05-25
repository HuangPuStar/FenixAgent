import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  DeleteInstanceResponse,
  InstanceInfo,
  InstanceListResponse,
  SpawnInstanceFromEnvironmentRequest,
} from "../types/schemas";

export class InstanceApi extends BaseApi {
  async create(body: Record<string, unknown>): Promise<ApiResult<InstanceInfo>> {
    return this.post<InstanceInfo>("/web/instances", body);
  }
  async spawn(body: SpawnInstanceFromEnvironmentRequest): Promise<ApiResult<InstanceInfo>> {
    return this.post<InstanceInfo>("/web/instances/from-environment", body);
  }
  async list(): Promise<ApiResult<InstanceListResponse>> {
    return this._get<InstanceListResponse>("/web/instances");
  }
  async delete(params: { id: string }): Promise<ApiResult<DeleteInstanceResponse>> {
    return this.del<DeleteInstanceResponse>("/web/instances/:id", { params });
  }
}
