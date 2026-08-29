import type { GatewayUsage, GatewayUsageQuery, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import { stableInternalUserId } from "./credential-service";

const MAX_RANGE_MS = 90 * 24 * 60 * 60 * 1000;
const USAGE_QUERY_BATCH_SIZE = 3;

export interface UsageQueryInput extends Omit<GatewayUsageQuery, "externalUserId" | "externalCredentialId"> {
  gatewayProviderId: string;
  userId?: string;
  organizationId?: string;
  agentConfigId?: string;
  /** 是否计算按模型、组织、用户和 Agent 的明细聚合；概览查询默认关闭。 */
  includeBreakdowns?: boolean;
}

export interface UsageCredentialMapping {
  externalCredentialId: string;
  organizationId: string;
  organizationName?: string | null;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
  agentConfigId: string;
  agentName?: string | null;
}

export interface ModelGatewayUsageServiceDeps {
  adapter: ModelGatewayAdapter;
  listCredentialMappings: (gatewayProviderId: string) => Promise<UsageCredentialMapping[]>;
}

export interface AggregatedUsage extends GatewayUsage {
  /** 当前查询范围内有用量的 Fenix 用户数，概览使用此轻量指标。 */
  activeUserCount: number;
  byModel?: Array<{
    modelId: string;
    spendUsd: number;
    requests: number;
    promptTokens: number;
    completionTokens: number;
  }>;
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
}

function assertDateRange(startAt: string, endAt: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startAt) || !/^\d{4}-\d{2}-\d{2}$/.test(endAt)) {
    throw new Error("usage dates must use YYYY-MM-DD format");
  }
  const start = Date.parse(`${startAt}T00:00:00.000Z`);
  const end = Date.parse(`${endAt}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("usage dates must be valid");
  if (start > end) throw new Error("usage start must not be after end");
  // 日期范围首尾均包含，因此相差 90 天即代表 91 个自然日。
  if (end - start >= MAX_RANGE_MS) throw new Error("usage date range cannot exceed 90 days");
}

function add<T extends { spendUsd: number; requests: number }>(map: Map<string, T>, key: string, record: T): void {
  const current = map.get(key);
  if (current) {
    current.spendUsd += record.spendUsd;
    current.requests += record.requests;
  } else {
    map.set(key, { ...record });
  }
}

/** 统一保持所有用量维度按消耗金额降序，避免各调用方重复排序。 */
function sortBySpendDesc<T extends { spendUsd: number }>(items: Iterable<T>): T[] {
  return [...items].sort((left, right) => right.spendUsd - left.spendUsd);
}

/** 按固定批次查询多个 Virtual Key，避免筛选范围较大时瞬间打满 LiteLLM。 */
async function queryUsageByCredentialBatches(
  adapter: ModelGatewayAdapter,
  input: UsageQueryInput,
  mappings: UsageCredentialMapping[],
): Promise<GatewayUsage[]> {
  const results: GatewayUsage[] = [];
  for (let offset = 0; offset < mappings.length; offset += USAGE_QUERY_BATCH_SIZE) {
    const batch = mappings.slice(offset, offset + USAGE_QUERY_BATCH_SIZE);
    results.push(
      ...(await Promise.all(
        batch.map((mapping) =>
          adapter.queryUsage({
            startAt: input.startAt,
            endAt: input.endAt,
            externalCredentialId: mapping.externalCredentialId,
            ...(input.modelId ? { modelId: input.modelId } : {}),
          }),
        ),
      )),
    );
  }
  return results;
}

/** 查询并聚合模型网关用量；普通 Provider 不会进入本服务的数据源。 */
export function createModelGatewayUsageService(deps: ModelGatewayUsageServiceDeps) {
  async function queryUsage(input: UsageQueryInput): Promise<AggregatedUsage> {
    assertDateRange(input.startAt, input.endAt);
    const mappings = await deps.listCredentialMappings(input.gatewayProviderId);
    const filtered = mappings.filter((mapping) => {
      if (input.organizationId && mapping.organizationId !== input.organizationId) return false;
      if (input.userId && mapping.userId !== input.userId) return false;
      if (input.agentConfigId && mapping.agentConfigId !== input.agentConfigId) return false;
      return true;
    });
    // 无可归属的凭证时不查询 LiteLLM，避免将同一实例上其他来源的 Key 纳入当前 Provider。
    if (filtered.length === 0) {
      return {
        totalSpendUsd: 0,
        records: [],
        activeUserCount: 0,
        ...(input.includeBreakdowns
          ? {
              byModel: [],
              byOrganization: [],
              byUser: [],
              byAgent: [],
            }
          : {}),
      };
    }
    const query: GatewayUsageQuery = {
      startAt: input.startAt,
      endAt: input.endAt,
      ...(input.userId
        ? {
            externalUserId: stableInternalUserId(input.gatewayProviderId, input.userId),
          }
        : {}),
    };
    const mappingByKey = new Map(filtered.map((mapping) => [mapping.externalCredentialId, mapping]));
    // 有主体筛选时逐 Key 查询，确保返回范围只包含目标主体。
    const usageResults =
      input.organizationId || input.userId || input.agentConfigId
        ? await queryUsageByCredentialBatches(deps.adapter, input, filtered)
        : [await deps.adapter.queryUsage(query)];
    const byModel = input.includeBreakdowns
      ? new Map<
          string,
          {
            modelId: string;
            spendUsd: number;
            requests: number;
            promptTokens: number;
            completionTokens: number;
          }
        >()
      : undefined;
    const byOrganization = input.includeBreakdowns
      ? new Map<
          string,
          { organizationId: string; organizationName: string | null; spendUsd: number; requests: number }
        >()
      : undefined;
    const byUser = input.includeBreakdowns
      ? new Map<
          string,
          { userId: string; userName: string | null; userEmail: string | null; spendUsd: number; requests: number }
        >()
      : undefined;
    const byAgent = input.includeBreakdowns
      ? new Map<
          string,
          {
            agentConfigId: string;
            organizationName: string | null;
            agentName: string | null;
            spendUsd: number;
            requests: number;
          }
        >()
      : undefined;
    const activeUserIds = new Set<string>();
    const records = [];
    let totalSpendUsd = 0;
    for (const [resultIndex, result] of usageResults.entries()) {
      const queriedMapping =
        input.organizationId || input.userId || input.agentConfigId ? filtered[resultIndex] : undefined;
      for (const record of result.records) {
        if (input.modelId && record.modelId !== input.modelId) continue;
        const mapping = record.externalCredentialId ? mappingByKey.get(record.externalCredentialId) : queriedMapping;
        // 所有查询都只保留当前 Gateway Provider 可归属的 Key，避免混入 LiteLLM 中其他来源的调用。
        if (!mapping) continue;
        totalSpendUsd += record.spendUsd;
        records.push(record);
        if (byModel && record.modelId) {
          const current = byModel.get(record.modelId) ?? {
            modelId: record.modelId,
            spendUsd: 0,
            requests: 0,
            promptTokens: 0,
            completionTokens: 0,
          };
          current.spendUsd += record.spendUsd;
          current.requests += record.requests;
          current.promptTokens += record.promptTokens;
          current.completionTokens += record.completionTokens;
          byModel.set(record.modelId, current);
        }
        if (mapping) {
          activeUserIds.add(mapping.userId);
          if (byOrganization && byUser && byAgent) {
            add(byOrganization, mapping.organizationId, {
              organizationId: mapping.organizationId,
              organizationName: mapping.organizationName ?? null,
              spendUsd: record.spendUsd,
              requests: record.requests,
            });
            add(byUser, mapping.userId, {
              userId: mapping.userId,
              userName: mapping.userName ?? null,
              userEmail: mapping.userEmail ?? null,
              spendUsd: record.spendUsd,
              requests: record.requests,
            });
            add(byAgent, mapping.agentConfigId, {
              agentConfigId: mapping.agentConfigId,
              organizationName: mapping.organizationName ?? null,
              agentName: mapping.agentName ?? null,
              spendUsd: record.spendUsd,
              requests: record.requests,
            });
          }
        }
      }
    }
    return {
      totalSpendUsd,
      records,
      activeUserCount: activeUserIds.size,
      ...(input.includeBreakdowns
        ? {
            byModel: sortBySpendDesc(byModel!.values()),
            byOrganization: sortBySpendDesc(byOrganization!.values()),
            byUser: sortBySpendDesc(byUser!.values()),
            byAgent: sortBySpendDesc(byAgent!.values()),
          }
        : {}),
    };
  }
  return { queryUsage };
}
