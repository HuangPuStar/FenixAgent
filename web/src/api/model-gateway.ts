import { getAdminKey } from "../lib/admin-key";
import { request, unwrap } from "./request";

export interface ModelSyncChange {
  modelId: string;
  kind: "added" | "updated" | "removed";
  displayName?: string;
}
export interface ModelSyncStatus {
  status: "synced" | "pending" | "unknown";
  changes: ModelSyncChange[];
  models?: Array<{ id: string; displayName?: string; provider?: string }>;
  providerBaseUrlChanged?: boolean;
  error?: string;
}
export interface ModelGatewayConfiguration {
  provider: {
    id: string;
    name: string;
    displayName: string;
    gatewayType: string;
    baseUrl: string | null;
    modelCount: number;
    owner: { email: string; organizationSlug: string };
  } | null;
  adminUiUrl: string | null;
  defaultBudget: { maxBudgetUsd: number | null; duration: string | null };
}
export interface ModelSyncResult {
  added: number;
  updated: number;
  removed: number;
}
export interface GatewayUsage {
  gatewayProvider: {
    id: string;
    name: string;
    displayName: string;
  };
  totalSpendUsd: number;
  records: Array<{
    date: string;
    spendUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }>;
  activeUserCount: number;
  byModel?: Array<{ modelId: string; spendUsd: number; requests: number }>;
  byOrganization?: Array<{
    organizationId: string;
    organizationName: string | null;
    spendUsd: number;
    requests: number;
  }>;
  byUser?: Array<{
    userId: string;
    userName: string | null;
    userEmail: string | null;
    spendUsd: number;
    requests: number;
  }>;
  byAgent?: Array<{
    agentConfigId: string;
    organizationName: string | null;
    agentName: string | null;
    spendUsd: number;
    requests: number;
  }>;
  budget: {
    maxBudgetUsd: number | null;
    duration: string | null;
    spendUsd: number;
    resetAt: string | null;
  } | null;
}

export interface ModelGatewayBudgetItem {
  id: string;
  name: string;
  email: string;
  budget: {
    maxBudgetUsd: number | null;
    duration: string | null;
    spendUsd: number;
    resetAt: string | null;
  };
  source: "litellm" | "default";
  isActivated: boolean;
}

function adminOptions() {
  return { bearerToken: getAdminKey() ?? undefined };
}

export function checkModelGateway(providerId?: string) {
  return unwrap(
    request<ModelSyncStatus>("/api/system/model-gateway/models/status", {
      ...adminOptions(),
      query: providerId ? { providerId } : undefined,
    }),
  );
}

export function getModelGatewayConfiguration() {
  return unwrap(request<ModelGatewayConfiguration>("/api/system/model-gateway/config", adminOptions()));
}

export function syncModelGateway(providerId?: string) {
  return unwrap(
    request<ModelSyncResult>("/api/system/model-gateway/models/actions/sync", {
      ...adminOptions(),
      method: "POST",
      query: providerId ? { providerId } : undefined,
    }),
  );
}

export function listModelGatewayBudgets(
  page = 1,
  pageSize = 20,
  filters: {
    organizationId?: string;
    userId?: string;
    budgetStatus?: "pending" | "active" | "exhausted";
  } = {},
) {
  return unwrap(
    request<{
      items: ModelGatewayBudgetItem[];
      total: number;
      page: number;
      pageSize: number;
    }>("/api/system/model-gateway/budgets", {
      ...adminOptions(),
      query: {
        page,
        pageSize,
        ...(filters.organizationId ? { organizationId: filters.organizationId } : {}),
        ...(filters.userId ? { userId: filters.userId } : {}),
        ...(filters.budgetStatus ? { budgetStatus: filters.budgetStatus } : {}),
      },
    }),
  );
}

export function listModelGatewayUsers(input: { keyword?: string; pageSize?: number } = {}) {
  return unwrap(
    request<{
      items: Array<{ id: string; name: string; email: string }>;
      total: number;
    }>("/api/system/model-gateway/subjects/users", {
      ...adminOptions(),
      query: { page: 1, pageSize: input.pageSize ?? 100, ...input },
    }),
  );
}

export function listModelGatewayAgents(input: { keyword?: string; pageSize?: number } = {}) {
  return unwrap(
    request<
      Array<{
        id: string;
        name: string;
        organizationId: string;
        userId: string;
      }>
    >("/api/system/model-gateway/subjects/agents", {
      ...adminOptions(),
      query: { page: 1, pageSize: input.pageSize ?? 100, ...input },
    }),
  );
}

export function queryModelGatewayUsage(input: {
  startAt: string;
  endAt: string;
  userId?: string;
  organizationId?: string;
  agentConfigId?: string;
  modelId?: string;
  includeBreakdowns?: boolean;
}) {
  return unwrap(
    request<GatewayUsage>("/api/system/model-gateway/usage", {
      ...adminOptions(),
      query: input,
    }),
  );
}

export function updateModelGatewayBudgets(userIds: string[], maxBudgetUsd: number | null, duration: string | null) {
  return unwrap(
    request("/api/system/model-gateway/budgets/actions/bulk-update", {
      ...adminOptions(),
      method: "POST",
      body: { userIds, maxBudgetUsd, duration },
    }),
  );
}

export function resetModelGatewayBudgets(userIds: string[]) {
  return unwrap(
    request("/api/system/model-gateway/budgets/actions/bulk-reset", {
      ...adminOptions(),
      method: "POST",
      body: { userIds },
    }),
  );
}

export function queryMyModelGatewayUsage(providerId: string, input: { startAt: string; endAt: string }) {
  return unwrap(
    request<GatewayUsage>("/web/model-gateway/:providerId/usage", { params: { providerId }, query: input }),
  );
}
