import { BaseApi } from "../base";
import type { ApiResult } from "../result";
import type {
  ClearTaskLogsResponse,
  CreateTaskRequest,
  DeleteTaskResponse,
  PaginatedLogs,
  TaskInfo,
  ToggleTaskResponse,
  TriggerTaskResponse,
  UpdateTaskRequest,
} from "../types/schemas";

export class TaskApi extends BaseApi {
  async list(): Promise<ApiResult<TaskInfo[]>> {
    return this._get<TaskInfo[]>("/web/tasks");
  }
  async create(body: CreateTaskRequest): Promise<ApiResult<TaskInfo>> {
    return this.post<TaskInfo>("/web/tasks", body);
  }
  async get(params: { id: string }): Promise<ApiResult<TaskInfo>> {
    return this._get<TaskInfo>("/web/tasks/:id", { params });
  }
  async update(params: { id: string }, body: UpdateTaskRequest): Promise<ApiResult<TaskInfo>> {
    return this.put<TaskInfo>("/web/tasks/:id", body, { params });
  }
  async delete(params: { id: string }): Promise<ApiResult<DeleteTaskResponse>> {
    return this.del<DeleteTaskResponse>("/web/tasks/:id", { params });
  }
  async toggle(params: { id: string }): Promise<ApiResult<ToggleTaskResponse>> {
    return this.post<ToggleTaskResponse>("/web/tasks/:id/toggle", undefined, { params });
  }
  async trigger(params: { id: string }): Promise<ApiResult<TriggerTaskResponse>> {
    return this.post<TriggerTaskResponse>("/web/tasks/:id/trigger", undefined, { params });
  }
  async logs(params: { id: string }, query?: { page?: number; pageSize?: number }): Promise<ApiResult<PaginatedLogs>> {
    return this._get<PaginatedLogs>("/web/tasks/:id/logs", { params, query });
  }
  async clearLogs(params: { id: string }): Promise<ApiResult<ClearTaskLogsResponse>> {
    return this.del<ClearTaskLogsResponse>("/web/tasks/:id/logs", { params });
  }
}
