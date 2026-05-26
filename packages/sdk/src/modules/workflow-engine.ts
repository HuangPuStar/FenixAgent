import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class WorkflowEngineApi extends BaseApi {
  async run(
    yaml: string,
    opts?: { params?: Record<string, unknown>; workflowId?: string },
  ): Promise<ApiResult<{ runId: string }>> {
    return this.post("/web/workflow-engine", { action: "run", yaml, ...opts });
  }
  async dryRun(yaml: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "dryRun", yaml });
  }
  async cancel(runId: string): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/workflow-engine", { action: "cancel", runId });
  }
  async approve(
    runId: string,
    nodeId: string,
    token: string,
    data?: Record<string, unknown>,
  ): Promise<ApiResult<{ success: boolean }>> {
    return this.post("/web/workflow-engine", { action: "approve", runId, nodeId, token, data });
  }
  async getRunStatus(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getRunStatus", runId });
  }
  async getEvents(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getEvents", runId });
  }
  async getOutput(runId: string, nodeId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getOutput", runId, nodeId });
  }
  async getPendingApprovals(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "getPendingApprovals", runId });
  }
  async listRuns(workflowId?: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "listRuns", workflowId });
  }
  async recover(runId: string, opts?: { yaml?: string }): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "recover", runId, ...opts });
  }
  async rerunFrom(
    runId: string,
    opts?: { yaml?: string; fromNodeId?: string; workflowId?: string },
  ): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "rerunFrom", runId, ...opts });
  }
}
