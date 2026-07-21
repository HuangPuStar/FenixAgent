import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentLitellmKey } from "../../db/schema";
import { litellmRequest } from "./client";

// ── LiteLLM API 类型 ──────────────────────────────────────

/** /spend/keys 返回的单条 key */
interface KeySummary {
  token: string;
  key_alias: string | null;
  user_id: string;
}

/**
 * /user/daily/activity 的 api_keys 拆分条目。
 * 每条对应一个 key 在某日的汇总（含 token 数 + 模型拆分）。
 *
 * 注意：LiteLLM 在不同版本中返回的 metrics 字段略有差异，
 * extra 字段（successful_requests / failed_requests / cache_*）用可选类型兼容。
 */
interface DailyApiKeyMetrics {
  metrics: {
    spend: number;
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    api_requests: number;
    successful_requests?: number;
    failed_requests?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  metadata: {
    key_alias: string | null;
  };
  breakdown?: {
    models?: Record<
      string,
      {
        metrics: {
          spend: number;
          total_tokens: number;
          prompt_tokens?: number;
          completion_tokens?: number;
          api_requests?: number;
        };
      }
    >;
  };
}

interface DailyActivityResult {
  date: string;
  metrics: {
    spend: number;
    total_tokens: number;
    api_requests: number;
    /** LiteLLM >= v1.60 加入 */
    successful_requests?: number;
    failed_requests?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  breakdown: {
    api_keys?: Record<string, DailyApiKeyMetrics>;
  };
}

interface DailyActivityResponse {
  results: DailyActivityResult[];
  metadata: {
    total_spend: number;
    total_tokens: number;
    total_api_requests?: number;
    total_successful_requests?: number;
    total_failed_requests?: number;
    total_cache_read_input_tokens?: number;
    total_cache_creation_input_tokens?: number;
  };
}

// ── API 调用 ──────────────────────────────────────────────

async function listKeySummaries(): Promise<KeySummary[]> {
  return litellmRequest<KeySummary[]>("GET", "/spend/keys");
}

async function getUserDailyActivity(params: {
  user_id: string;
  start_date: string;
  end_date: string;
}): Promise<DailyActivityResponse> {
  const query = new URLSearchParams();
  query.set("user_id", params.user_id);
  query.set("start_date", params.start_date);
  query.set("end_date", params.end_date);
  return litellmRequest<DailyActivityResponse>("GET", `/user/daily/activity?${query.toString()}`);
}

export async function getSpendByTags(tags: string[]): Promise<{ [tag: string]: { spend: number } }> {
  return litellmRequest("GET", `/global/spend/tags?tags=${tags.join(",")}`);
}

// ── Usage 聚合 ────────────────────────────────────────────

export interface UsageReportEntry {
  date: string;
  agentName: string;
  model: string;
  spend: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  apiRequests: number;
}

/** 按天聚合的数据点，供前端渲染折线图/柱状图 */
export interface DailySummary {
  date: string;
  spend: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  apiRequests: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface UsageReport {
  entries: UsageReportEntry[];
  /** 按天聚合的时序数据（用于图表渲染） */
  dailySummary: DailySummary[];
  totalSpend: number;
  totalTokens: number;
  totalRequests: number;
  periodDays: number;
}

/**
 * 按 agent 维度的用量报表。
 *
 * 终极方案：使用 LiteLLM /user/daily/activity（按天聚合 + api_keys 拆分 + token 数）。
 * 一次调用即可获取所有 agent 的每日 spend + token，无 10K 性能问题。
 *
 * 流程：
 * 1. DB 获取本组织 alias 集合
 * 2. /spend/keys 获取 alias → user_id 映射
 * 3. 按 user_id 去重，每个 user 调一次 /user/daily/activity
 * 4. 从 api_keys 拆分中按 alias 过滤，提取 agent 名
 */
export async function getUsageReport(organizationId: string, days: number, userId?: string): Promise<UsageReport> {
  const tomorrow = new Date(Date.now() + 86400000).toISOString();
  const startDate = new Date(Date.now() - days * 86400000).toISOString();

  // 1. 本组织、当前用户的 alias 集合
  const conditions = [eq(agentLitellmKey.organizationId, organizationId), eq(agentLitellmKey.enabled, true)];
  if (userId) {
    conditions.push(eq(agentLitellmKey.userId, userId));
  }
  const keyRecords = await db
    .select({ keyAlias: agentLitellmKey.keyAlias })
    .from(agentLitellmKey)
    .where(and(...conditions));

  const orgAliases = new Set(keyRecords.map((r) => r.keyAlias).filter((a): a is string => !!a));
  if (orgAliases.size === 0) {
    return { entries: [], dailySummary: [], totalSpend: 0, totalTokens: 0, totalRequests: 0, periodDays: days };
  }

  // 2. alias → user_id 映射（含前缀匹配兼容后缀）
  const aliasToUserId = new Map<string, string>();
  try {
    const allKeys = await listKeySummaries();
    for (const k of allKeys) {
      if (!k.key_alias) continue;
      if (orgAliases.has(k.key_alias)) {
        if (!aliasToUserId.has(k.key_alias)) aliasToUserId.set(k.key_alias, k.user_id);
        continue;
      }
      for (const orgAlias of orgAliases) {
        if (k.key_alias.startsWith(orgAlias) && !aliasToUserId.has(orgAlias)) {
          aliasToUserId.set(orgAlias, k.user_id);
          break;
        }
      }
    }
  } catch (_err) {
    return { entries: [], dailySummary: [], totalSpend: 0, totalTokens: 0, totalRequests: 0, periodDays: days };
  }

  // 3. 按 user_id 去重，每个 user 调一次 /user/daily/activity
  const uniqueUsers = [...new Set(aliasToUserId.values())];
  const allEntries: UsageReportEntry[] = [];
  let totalSpend = 0;
  let totalTokens = 0;
  let totalRequests = 0;

  const dateParams = {
    start_date: startDate.slice(0, 10),
    end_date: tomorrow.slice(0, 10),
  };

  // 按天聚合的临时 Map（用于生成 dailySummary）
  const dailyMap = new Map<string, DailySummary>();

  for (const userId of uniqueUsers) {
    let activity: DailyActivityResponse;
    try {
      activity = await getUserDailyActivity({ user_id: userId, ...dateParams });
    } catch (_err) {
      continue;
    }

    for (const day of activity.results) {
      const date = day.date?.slice(0, 10) ?? "unknown";
      const apiKeys = day.breakdown?.api_keys ?? {};

      // 累加按天级别的指标（从 day.metrics + 各 key 的 metrics）
      const daySpend = day.metrics.spend;
      const dayTokens = day.metrics.total_tokens;
      const dayRequests = day.metrics.api_requests ?? 0;
      let dayCacheRead = day.metrics.cache_read_input_tokens ?? 0;
      let dayCacheCreation = day.metrics.cache_creation_input_tokens ?? 0;

      for (const [_token, keyMetrics] of Object.entries(apiKeys)) {
        const keyM = keyMetrics.metrics;
        const keyAlias = keyMetrics.metadata?.key_alias;
        // key 级别额外的 cache / success/failed
        dayCacheRead += keyM.cache_read_input_tokens ?? 0;
        dayCacheCreation += keyM.cache_creation_input_tokens ?? 0;

        if (!keyAlias) continue;

        const matchedAlias = findMatchingAlias(keyAlias, orgAliases);
        if (!matchedAlias) continue;

        const agentName = extractAgentName(matchedAlias);
        const m = keyM;
        totalSpend += m.spend;
        totalTokens += m.total_tokens;
        totalRequests += m.api_requests ?? 0;

        // 尝试 model 级拆分（含 api_requests）
        const models = keyMetrics.breakdown?.models ?? {};
        if (Object.keys(models).length > 0) {
          for (const [model, modelMetrics] of Object.entries(models)) {
            if (modelMetrics.metrics.spend <= 0 && modelMetrics.metrics.total_tokens <= 0) continue;
            allEntries.push({
              date,
              agentName,
              model,
              spend: modelMetrics.metrics.spend,
              totalTokens: modelMetrics.metrics.total_tokens,
              promptTokens: modelMetrics.metrics.prompt_tokens ?? 0,
              completionTokens: modelMetrics.metrics.completion_tokens ?? 0,
              apiRequests: modelMetrics.metrics.api_requests ?? 0,
            });
          }
        } else {
          allEntries.push({
            date,
            agentName,
            model: "all",
            spend: m.spend,
            totalTokens: m.total_tokens,
            promptTokens: m.prompt_tokens ?? 0,
            completionTokens: m.completion_tokens ?? 0,
            apiRequests: m.api_requests ?? 0,
          });
        }
      }

      // 合并当天数据到 dailyMap
      const existingDaily = dailyMap.get(date);
      if (existingDaily) {
        existingDaily.spend += daySpend;
        existingDaily.totalTokens += dayTokens;
        existingDaily.apiRequests += dayRequests;
        existingDaily.cacheReadInputTokens += dayCacheRead;
        existingDaily.cacheCreationInputTokens += dayCacheCreation;
        // prompt/completion tokens 在此聚合级别只能从 key 累加，
        // 由于 DailyActivityResult 级别没有 prompt/completion，这里留 0，
        // 交由 entries 合并后再计算 daily prompt/completion。
      } else {
        dailyMap.set(date, {
          date,
          spend: daySpend,
          totalTokens: dayTokens,
          promptTokens: 0,
          completionTokens: 0,
          apiRequests: dayRequests,
          cacheReadInputTokens: dayCacheRead,
          cacheCreationInputTokens: dayCacheCreation,
        });
      }
    }
  }

  // 4. 按 date + agentName + model 合并去重 entries
  const merged = new Map<string, UsageReportEntry>();
  for (const e of allEntries) {
    const k = `${e.date}|${e.agentName}|${e.model}`;
    const existing = merged.get(k);
    if (existing) {
      existing.spend += e.spend;
      existing.totalTokens += e.totalTokens;
      existing.promptTokens += e.promptTokens;
      existing.completionTokens += e.completionTokens;
      existing.apiRequests += e.apiRequests;
    } else {
      merged.set(k, { ...e });
    }
  }

  // 5. 从 entries 反算 dailySummary 的 promptTokens / completionTokens
  for (const e of merged.values()) {
    const ds = dailyMap.get(e.date);
    if (ds) {
      ds.promptTokens += e.promptTokens;
      ds.completionTokens += e.completionTokens;
    }
  }

  // 按日期排序 dailySummary
  const dailySummary = [...dailyMap.values()].sort((a, b) => a.date.localeCompare(b.date));

  return {
    entries: [...merged.values()].sort(
      (a, b) =>
        a.date.localeCompare(b.date) || a.agentName.localeCompare(b.agentName) || a.model.localeCompare(b.model),
    ),
    dailySummary,
    totalSpend,
    totalTokens,
    totalRequests,
    periodDays: days,
  };
}

/** 在 orgAliases 中找到匹配的 alias（精确或前缀） */
function findMatchingAlias(keyAlias: string, orgAliases: Set<string>): string | undefined {
  if (orgAliases.has(keyAlias)) return keyAlias;
  for (const a of orgAliases) {
    if (keyAlias.startsWith(a)) return a;
  }
  return;
}

/** 从 keyAlias（格式 RCS:userId:agentName）提取 agent 名称 */
function extractAgentName(keyAlias: string): string {
  const parts = keyAlias.split(":");
  if (parts.length >= 3 && parts[0] === "RCS") {
    return parts.slice(2).join(":");
  }
  return keyAlias;
}
