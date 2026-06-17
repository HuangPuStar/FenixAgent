import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  CreateEnvironmentRequest,
  DeleteEnvironmentResponse,
  EnterEnvironmentResponse,
  EnvironmentDetailResponse,
  EnvironmentListResponse,
  ListInstancesResponse,
  UpdateEnvironmentRequest,
  UpdateEnvironmentResponse,
} from "../types/schemas";

export class EnvironmentApi extends BaseApi {
  /**
   * 获取环境列表。
   *
   * @param params.mine 传入 true 时仅返回当前用户创建的环境（用于 workflow 等只需"我的环境"的场景）；
   *                    不传或 false 时返回当前组织下的全部环境。
   */
  async list(params?: { mine?: boolean }): Promise<ApiResult<EnvironmentListResponse[]>> {
    return this._get<EnvironmentListResponse[]>("/web/environments", {
      query: params?.mine !== undefined ? { mine: params.mine } : undefined,
    });
  }
  async create(body: CreateEnvironmentRequest): Promise<ApiResult<EnvironmentDetailResponse>> {
    return this.post<EnvironmentDetailResponse>("/web/environments", body);
  }
  async get(params: { id: string }): Promise<ApiResult<EnvironmentDetailResponse>> {
    return this._get<EnvironmentDetailResponse>("/web/environments/:id", { params });
  }
  async update(params: { id: string }, body: UpdateEnvironmentRequest): Promise<ApiResult<UpdateEnvironmentResponse>> {
    return this.put<UpdateEnvironmentResponse>("/web/environments/:id", body, { params });
  }
  async delete(params: { id: string }): Promise<ApiResult<DeleteEnvironmentResponse>> {
    return this.del<DeleteEnvironmentResponse>("/web/environments/:id", { params });
  }
  async enter(
    params: { id: string },
    body?: { instance_number?: number },
  ): Promise<ApiResult<EnterEnvironmentResponse>> {
    return this.post<EnterEnvironmentResponse>("/web/environments/:id/enter", body, { params });
  }
  async listInstances(params: { id: string }): Promise<ApiResult<ListInstancesResponse>> {
    return this._get<ListInstancesResponse>("/web/environments/:id/instances", { params });
  }
}
