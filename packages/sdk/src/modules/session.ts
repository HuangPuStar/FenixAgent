import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  InterruptResponse,
  SendEventResponse,
  SessionHistory,
  SessionListResponse,
  SessionResponse,
} from "../types/schemas";

export type SessionEventPayload = Record<string, unknown>;

export class SessionApi extends BaseApi {
  async list(): Promise<ApiResult<SessionListResponse>> {
    return this._get<SessionListResponse>("/web/sessions");
  }
  async create(body: Record<string, unknown>): Promise<ApiResult<SessionResponse>> {
    return this.post<SessionResponse>("/web/sessions", body);
  }
  async get(params: { id: string }): Promise<ApiResult<SessionResponse>> {
    return this._get<SessionResponse>("/web/sessions/:id", { params });
  }
  async history(params: { id: string }): Promise<ApiResult<SessionHistory>> {
    return this._get<SessionHistory>("/web/sessions/:id/history", { params });
  }
}

export class ControlApi extends BaseApi {
  async sendEvent(params: { id: string }, payload: SessionEventPayload): Promise<ApiResult<SendEventResponse>> {
    return this.post<SendEventResponse>("/web/sessions/:id/events", payload, { params });
  }
  async control(params: { id: string }, payload: SessionEventPayload): Promise<ApiResult<SendEventResponse>> {
    return this.post<SendEventResponse>("/web/sessions/:id/control", payload, { params });
  }
  async interrupt(params: { id: string }): Promise<ApiResult<InterruptResponse>> {
    return this.post<InterruptResponse>("/web/sessions/:id/interrupt", undefined, { params });
  }
}
