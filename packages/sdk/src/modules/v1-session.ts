import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  CreateSessionRequest,
  StatusOkResponse,
  UpdateSessionRequest,
  V1CreateSessionResponse,
  V1GetSessionResponse,
  V1SendEventsResponse,
} from "../types/schemas";

export class V1SessionApi extends BaseApi {
  async create(body: CreateSessionRequest): Promise<ApiResult<V1CreateSessionResponse>> {
    return this.post("/v1/sessions", body);
  }
  async get(params: { id: string }): Promise<ApiResult<V1GetSessionResponse>> {
    return this._get("/v1/sessions/:id", { params });
  }
  async update(params: { id: string }, body: UpdateSessionRequest): Promise<ApiResult<V1GetSessionResponse>> {
    return this.patch("/v1/sessions/:id", body, { params });
  }
  async archive(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/sessions/:id/archive", undefined, { params });
  }
  async sendEvents(
    params: { id: string },
    body: { events: Record<string, unknown>[] | Record<string, unknown> },
  ): Promise<ApiResult<V1SendEventsResponse>> {
    return this.post("/v1/sessions/:id/events", body, { params });
  }
}
