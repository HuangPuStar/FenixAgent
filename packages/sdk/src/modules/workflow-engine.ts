import { BaseApi } from "../base";
import type { ApiResult } from "../result";

export class WorkflowEngineApi extends BaseApi {
  async run(workflowId: string, body?: Record<string, unknown>): Promise<ApiResult<{ runId: string }>> {
    return this.post("/web/workflow-engine", { action: "run", workflowId, ...body });
  }
  async dryRun(workflowId: string, body?: Record<string, unknown>): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "dryRun", workflowId, ...body });
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
  async recover(runId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "recover", runId });
  }
  async rerunFrom(runId: string, nodeId: string): Promise<ApiResult<unknown>> {
    return this.post("/web/workflow-engine", { action: "rerunFrom", runId, nodeId });
  }
}
