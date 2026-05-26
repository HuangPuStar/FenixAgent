import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class WorkflowDefApi extends BaseApi {
  async create(body: Record<string, unknown>): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "create", ...body });
  }
  async save(workflowId: string, yaml: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "save", workflowId, yaml });
  }
  async publish(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "publish", workflowId });
  }
  async list(): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "list" });
  }
  async get(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "get", workflowId });
  }
  async getVersions(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "getVersions", workflowId });
  }
  async getVersion(workflowId: string, version: number): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "getVersion", workflowId, version });
  }
  async setLatest(workflowId: string, version: number): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "setLatest", workflowId, version });
  }
  async delete(workflowId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "delete", workflowId });
  }
  async updateMeta(workflowId: string, data: Record<string, unknown>): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "updateMeta", workflowId, data });
  }
  async restoreToDraft(workflowId: string, version: number): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "restoreToDraft", workflowId, version });
  }
  async recover(): Promise<ApiResult<string[]>> {
    return this.post("/web/workflow-defs", { action: "recover" });
  }
  async recoverApply(workflowIds: string[]): Promise<ApiResult<unknown[]>> {
    return this.post("/web/workflow-defs", { action: "recoverApply", workflowIds });
  }

  // ── Trigger ──

  async createTrigger(
    workflowId: string,
    type?: string,
    config?: Record<string, unknown>,
  ): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "createTrigger", workflowId, type: type ?? "webhook", config });
  }

  async listTriggers(workflowId: string): Promise<ApiResult<unknown[]>> {
    return this.post("/web/workflow-defs", { action: "listTriggers", workflowId });
  }

  async deleteTrigger(triggerId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "deleteTrigger", triggerId });
  }

  async regenerateTriggerHash(triggerId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "regenerateHash", triggerId });
  }

  async enableTrigger(triggerId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "enableTrigger", triggerId });
  }

  async disableTrigger(triggerId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-defs", { action: "disableTrigger", triggerId });
  }
}
