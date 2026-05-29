/**
 * Workflow Jobs API Client。
 *
 * 对接后端 POST /web/workflow-jobs，通过 action 字段分发。
 * 对接 GET /web/workflow-jobs/events SSE 端点。
 */

// ── 类型 ──

export type JobStatus = "ready" | "running" | "suspended" | "completed";
export type DagStatus = "SUCCESS" | "FAILED" | "CANCELLED" | "ERROR";

export interface WorkflowJob {
  id: string;
  boardId: string;
  organizationId: string;
  userId: string;
  workflowId: string;
  version: number;
  params: Record<string, unknown> | null;
  status: JobStatus;
  lastRunId: string | null;
  lastDagStatus: DagStatus | null;
  runCount: number;
  createdAt: string;
  updatedAt: string;
  workflowName?: string;
  userName?: string | null;
}

export interface JobEventPayload {
  type: string;
  jobId: string;
  [key: string]: unknown;
}

export interface PendingApproval {
  runId: string;
  nodeId: string;
  approvalToken: string;
  expiresAt: string;
  displayData?: unknown;
}

// ── helpers ──

async function postAction(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch("/web/workflow-jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Unknown error");
  return json.data;
}

// ── API ──

export const workflowJobsApi = {
  async create(boardId: string, workflowId: string, params?: Record<string, unknown>): Promise<WorkflowJob> {
    return postAction("create", { boardId, workflowId, params }) as Promise<WorkflowJob>;
  },

  async list(boardId?: string): Promise<WorkflowJob[]> {
    const data = await postAction("list", boardId ? { boardId } : {});
    return Array.isArray(data) ? data : [];
  },

  async get(jobId: string): Promise<WorkflowJob> {
    return postAction("get", { jobId }) as Promise<WorkflowJob>;
  },

  async updateParams(jobId: string, params: Record<string, unknown>): Promise<void> {
    await postAction("updateParams", { jobId, params });
  },

  async run(jobId: string): Promise<{ runId: string }> {
    return postAction("run", { jobId }) as Promise<{ runId: string }>;
  },

  async cancel(jobId: string): Promise<void> {
    await postAction("cancel", { jobId });
  },

  async getPendingApprovals(jobId: string): Promise<PendingApproval[]> {
    const data = await postAction("getPendingApprovals", { jobId });
    return Array.isArray(data) ? data : [];
  },

  async approve(jobId: string, nodeId: string, token: string, data?: unknown): Promise<void> {
    await postAction("approve", { jobId, nodeId, token, data });
  },

  async delete(jobId: string): Promise<void> {
    await postAction("delete", { jobId });
  },

  createEventSource(): EventSource {
    return new EventSource("/web/workflow-jobs/events");
  },
};
