import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  GetWorkerResponse,
  StatusOkResponse,
  UpdateWorkerRequest,
  UpdateWorkerResponse,
  WorkerEventsRequest,
  WorkerEventsResponse,
  WorkerHeartbeatResponse,
  WorkerStateRequest,
} from "../types/schemas";

export class V2WorkerApi extends BaseApi {
  async get(params: { id: string }): Promise<ApiResult<GetWorkerResponse>> {
    return this._get("/v1/code/sessions/:id/worker", { params });
  }
  async update(params: { id: string }, body: UpdateWorkerRequest): Promise<ApiResult<UpdateWorkerResponse>> {
    return this.put("/v1/code/sessions/:id/worker", body, { params });
  }
  async heartbeat(params: { id: string }): Promise<ApiResult<WorkerHeartbeatResponse>> {
    return this.post("/v1/code/sessions/:id/worker/heartbeat", undefined, { params });
  }
  async register(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/code/sessions/:id/worker/register", undefined, { params });
  }
  async sendEvents(params: { id: string }, body: WorkerEventsRequest): Promise<ApiResult<WorkerEventsResponse>> {
    return this.post("/v1/code/sessions/:id/worker/events", body, { params });
  }
  async updateState(params: { id: string }, body: WorkerStateRequest): Promise<ApiResult<StatusOkResponse>> {
    return this.put("/v1/code/sessions/:id/worker/state", body, { params });
  }
  async updateMetadata(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.put("/v1/code/sessions/:id/worker/external_metadata", undefined, { params });
  }
  async deliveryBatch(params: { id: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/code/sessions/:id/worker/events/delivery", undefined, { params });
  }
  async deliveryEvent(params: { id: string; eventId: string }): Promise<ApiResult<StatusOkResponse>> {
    return this.post("/v1/code/sessions/:id/worker/events/:eventId/delivery", undefined, {
      params,
    });
  }
}
