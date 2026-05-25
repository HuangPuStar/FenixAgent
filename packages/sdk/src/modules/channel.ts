import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  ChannelBinding,
  ChannelBindingListResponse,
  ChannelProviderListResponse,
  CreateChannelBindingRequest,
  CreateChannelBindingResponse,
  DeleteChannelBindingResponse,
  HermesStatus,
  UpdateChannelBindingResponse,
} from "../types/schemas";

export class ChannelApi extends BaseApi {
  async listProviders(): Promise<ApiResult<ChannelProviderListResponse>> {
    return this._get<ChannelProviderListResponse>("/web/channels/providers");
  }
  async hermesStatus(): Promise<ApiResult<HermesStatus>> {
    return this._get<HermesStatus>("/web/channels/hermes/status");
  }
  async listBindings(): Promise<ApiResult<ChannelBindingListResponse>> {
    return this._get<ChannelBindingListResponse>("/web/channels/bindings");
  }
  async createBinding(body: CreateChannelBindingRequest): Promise<ApiResult<CreateChannelBindingResponse>> {
    return this.post<CreateChannelBindingResponse>("/web/channels/bindings", body);
  }
  async deleteBinding(params: { id: string }): Promise<ApiResult<DeleteChannelBindingResponse>> {
    return this.del<DeleteChannelBindingResponse>("/web/channels/bindings/:id", { params });
  }
  async updateBinding(
    params: { id: string },
    body: Partial<Pick<ChannelBinding, "platform" | "chatId" | "agentId" | "enabled">>,
  ): Promise<ApiResult<UpdateChannelBindingResponse>> {
    return this.patch<UpdateChannelBindingResponse>("/web/channels/bindings/:id", body, { params });
  }
}
