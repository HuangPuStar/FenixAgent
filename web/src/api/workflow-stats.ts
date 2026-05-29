/**
 * Workflow Statistics API Client。
 *
 * 对接 POST /web/workflow-stats，通过 action 字段分发。
 */

export type StatsRange = "7d" | "30d" | "all";

export interface StatsOverview {
  totalRuns: number;
  successRuns: number;
  failedRuns: number;
  successRate: number;
  avgDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}

export interface DailyCount {
  date: string;
  success: number;
  failed: number;
}

export interface TokenDaily {
  date: string;
  inputTokens: number;
  outputTokens: number;
}

export interface FailedRun {
  runId: string;
  workflowId: string;
  workflowName: string;
  dagStatus: string;
  startedAt: string;
  completedAt: string | null;
  durationMs: number | null;
}

async function postAction(action: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch("/web/workflow-stats", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ action, ...extra }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(json.error?.message ?? "Unknown error");
  return json.data;
}

export const workflowStatsApi = {
  async overview(range: StatsRange): Promise<StatsOverview> {
    return postAction("overview", { range }) as Promise<StatsOverview>;
  },

  async trend(range: StatsRange): Promise<DailyCount[]> {
    const data = await postAction("trend", { range });
    return Array.isArray(data) ? data : [];
  },

  async tokens(range: StatsRange): Promise<TokenDaily[]> {
    const data = await postAction("tokens", { range });
    return Array.isArray(data) ? data : [];
  },

  async failedRuns(): Promise<FailedRun[]> {
    const data = await postAction("failedRuns");
    return Array.isArray(data) ? data : [];
  },
};
