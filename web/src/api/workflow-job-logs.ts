/**
 * Workflow Job Logs API Client。
 *
 * 对接 GET /web/workflow-jobs/:jobId/logs SSE 端点。
 * 对接 POST /web/workflow-jobs getOutputs action。
 */

export interface NodeOutput {
  nodeId: string;
  nodeType: string | null;
  stdout: string;
  json: unknown | null;
  exitCode: number;
  status: "pending" | "running" | "completed" | "failed";
  startedAt: string | null;
  completedAt: string | null;
}

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

export const workflowJobLogsApi = {
  async getOutputs(jobId: string): Promise<NodeOutput[]> {
    const data = await postAction("getOutputs", { jobId });
    return Array.isArray(data) ? data : [];
  },

  createLogsEventSource(jobId: string): EventSource {
    return new EventSource(`/web/workflow-jobs/${jobId}/logs`);
  },
};
