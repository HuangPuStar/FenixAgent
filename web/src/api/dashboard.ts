/**
 * dashboard.ts — 平台概览仪表盘 API 模块
 */
import { request } from "./request";

export interface AgentStats {
  agentCount: number;
  running: number;
  stopped: number;
  trend: Array<{ day: string; count: number }>;
}

export interface ConversationStats {
  totalConversations: number;
  todayCount: number;
  dayChange: number;
  trend: Array<{ day: string; count: number }>;
}

export interface ActiveUserStats {
  activeUsers: number;
  recentUsers: Array<{ userId: string; name: string }>;
}

export interface TokenStats {
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  responseP50: number;
  responseP95: number;
  responseP99: number;
}

export interface DocStats {
  totalDocs: number;
  vectorized: number;
  vectorizedRate: number;
}

export interface TopAgent {
  agentId: string;
  agentName: string;
  count: number;
  ratio: number;
}

export interface Activity {
  id: string;
  type: string;
  subType: string | null;
  title: string;
  content: string | null;
  targetUrl: string | null;
  metadata: unknown;
  createdAt: string;
}

export interface RecentDocument {
  id: string;
  sourceName: string;
  status: string;
  kbName: string;
  kbId: string;
  createdAt: string;
}

export interface DashboardData {
  agentStats: AgentStats;
  conversationStats: ConversationStats;
  activeUserStats: ActiveUserStats;
  tokenStats: TokenStats;
  docStats: DocStats;
  topAgents: TopAgent[];
  recentActivities: Activity[];
  recentDocuments: RecentDocument[];
}

export const dashboardApi = {
  overview: () => request<DashboardData>("/web/dashboard", { method: "GET" }),
};
