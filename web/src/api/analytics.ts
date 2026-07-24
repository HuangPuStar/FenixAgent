import { request } from "./request";

export type AnalyticsRange = "7d" | "30d" | "90d";

export interface AnalyticsKpis {
  agentCount: number;
  sessionCount: number;
  activeUserCount: number;
  activeAgentCount?: number;
  memberCount: number;
  environmentCount: number;
  runningEnvironmentCount: number;
  workflowRunCount: number;
  workflowSuccessRate: number;
  activeAgentRatio?: number;
  sessionsPerActiveAgent?: number;
  activeUserRate?: number;
  resourceReuseRate?: number;
  idleResourceCount?: number;
}

export interface AnalyticsTrendPoint {
  date: string;
  sessions: number;
  activeUsers: number;
  agentsCreated: number;
}

export interface AnalyticsTopAgent {
  agentId: string;
  name: string;
  sessions: number;
  activeUsers: number;
}

export interface AnalyticsResourceBucket {
  total: number;
  bound: number;
  reused: number;
  idle: number;
}

export interface AnalyticsResourceSummary {
  totalResources: number;
  boundResources: number;
  reusedResources: number;
  idleResources: number;
  skills: AnalyticsResourceBucket;
  mcpServers: AnalyticsResourceBucket;
  knowledgeBases: AnalyticsResourceBucket;
}

export interface AnalyticsProxyMetric {
  key: string;
  value: number;
  unit: string;
  numerator?: number;
  denominator?: number;
  estimated: true;
}

export interface AnalyticsOverview {
  range: AnalyticsRange;
  generatedAt: string;
  kpis: AnalyticsKpis;
  trends: AnalyticsTrendPoint[];
  topAgents: AnalyticsTopAgent[];
  resourceSummary?: AnalyticsResourceSummary;
  proxyMetrics: AnalyticsProxyMetric[];
  dataNotes: string[];
}

export const analyticsApi = {
  overview: (range: AnalyticsRange = "30d") =>
    request<AnalyticsOverview>("/web/analytics/overview", { method: "GET", query: { range } }),
};
