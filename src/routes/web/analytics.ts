import { createLogger } from "@fenix/logger";
import { and, eq, gte, sql } from "drizzle-orm";
import Elysia from "elysia";
import { db } from "../../db";
import {
  agentConfig,
  agentConfigMcp,
  agentConfigSkill,
  agentKnowledgeBinding,
  agentSession,
  environment,
  knowledgeBase,
  mcpServer,
  member,
  skill,
  workflow,
  workflowRun,
} from "../../db/schema";
import { authGuardPlugin } from "../../plugins/auth";
import {
  type AnalyticsOverviewData,
  AnalyticsOverviewResponseSchema,
  AnalyticsRangeSchema,
} from "../../schemas/analytics.schema";
import { WebErrSchema } from "../../schemas/common.schema";

const logger = createLogger("analytics");

const RANGE_DAYS = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
} as const;

function internalErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Internal server error";
}

function toCount(value: unknown): number {
  return Number(value ?? 0);
}

function toDateKey(value: Date | string): string {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return value.slice(0, 10);
}

function buildDateKeys(days: number): string[] {
  const keys: string[] = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    keys.push(d.toISOString().slice(0, 10));
  }
  return keys;
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(2));
}

function ratioPercent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function summarizeResources(rows: Array<{ agents: unknown }>) {
  const total = rows.length;
  const bound = rows.filter((row) => toCount(row.agents) > 0).length;
  const reused = rows.filter((row) => toCount(row.agents) > 1).length;
  return {
    total,
    bound,
    reused,
    idle: total - bound,
  };
}

async function getAnalyticsOverview(
  organizationId: string,
  range: keyof typeof RANGE_DAYS,
): Promise<AnalyticsOverviewData> {
  const days = RANGE_DAYS[range];
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - days + 1);

  const [
    agentCountRows,
    memberCountRows,
    environmentRows,
    sessionCountRows,
    activeUserRows,
    activeAgentRows,
    workflowRunRows,
    sessionTrendRows,
    agentTrendRows,
    topAgentRows,
    skillResourceRows,
    mcpResourceRows,
    knowledgeResourceRows,
  ] = await Promise.all([
    db.select({ count: sql<number>`count(*)` }).from(agentConfig).where(eq(agentConfig.organizationId, organizationId)),
    db.select({ count: sql<number>`count(*)` }).from(member).where(eq(member.organizationId, organizationId)),
    db
      .select({ status: environment.status, count: sql<number>`count(*)` })
      .from(environment)
      .where(eq(environment.organizationId, organizationId))
      .groupBy(environment.status),
    db
      .select({ count: sql<number>`count(*)` })
      .from(agentSession)
      .innerJoin(environment, eq(agentSession.environmentId, environment.id))
      .where(and(eq(environment.organizationId, organizationId), gte(agentSession.createdAt, start))),
    db
      .select({ count: sql<number>`count(distinct ${agentSession.userId})` })
      .from(agentSession)
      .innerJoin(environment, eq(agentSession.environmentId, environment.id))
      .where(and(eq(environment.organizationId, organizationId), gte(agentSession.createdAt, start))),
    db
      .select({ count: sql<number>`count(distinct ${agentConfig.id})` })
      .from(agentSession)
      .innerJoin(environment, eq(agentSession.environmentId, environment.id))
      .innerJoin(agentConfig, eq(environment.agentConfigId, agentConfig.id))
      .where(and(eq(environment.organizationId, organizationId), gte(agentSession.createdAt, start))),
    db
      .select({
        total: sql<number>`count(*)`,
        succeeded: sql<number>`count(*) filter (where ${workflowRun.status} in ('completed', 'success', 'succeeded'))`,
      })
      .from(workflowRun)
      .innerJoin(workflow, eq(workflowRun.workflowId, workflow.id))
      .where(and(eq(workflow.organizationId, organizationId), gte(workflowRun.startedAt, start))),
    db
      .select({
        date: sql<string>`to_char(${agentSession.createdAt}, 'YYYY-MM-DD')`,
        sessions: sql<number>`count(*)`,
        activeUsers: sql<number>`count(distinct ${agentSession.userId})`,
      })
      .from(agentSession)
      .innerJoin(environment, eq(agentSession.environmentId, environment.id))
      .where(and(eq(environment.organizationId, organizationId), gte(agentSession.createdAt, start)))
      .groupBy(sql`to_char(${agentSession.createdAt}, 'YYYY-MM-DD')`),
    db
      .select({
        date: sql<string>`to_char(${agentConfig.createdAt}, 'YYYY-MM-DD')`,
        agentsCreated: sql<number>`count(*)`,
      })
      .from(agentConfig)
      .where(and(eq(agentConfig.organizationId, organizationId), gte(agentConfig.createdAt, start)))
      .groupBy(sql`to_char(${agentConfig.createdAt}, 'YYYY-MM-DD')`),
    db
      .select({
        agentId: agentConfig.id,
        name: agentConfig.name,
        sessions: sql<number>`count(${agentSession.id})`,
        activeUsers: sql<number>`count(distinct ${agentSession.userId})`,
      })
      .from(agentSession)
      .innerJoin(environment, eq(agentSession.environmentId, environment.id))
      .innerJoin(agentConfig, eq(environment.agentConfigId, agentConfig.id))
      .where(and(eq(environment.organizationId, organizationId), gte(agentSession.createdAt, start)))
      .groupBy(agentConfig.id, agentConfig.name)
      .orderBy(sql`count(${agentSession.id}) desc`)
      .limit(10),
    db
      .select({
        id: skill.id,
        agents: sql<number>`count(distinct ${agentConfig.id})`,
      })
      .from(skill)
      .leftJoin(agentConfigSkill, eq(skill.id, agentConfigSkill.skillId))
      .leftJoin(
        agentConfig,
        and(eq(agentConfigSkill.agentConfigId, agentConfig.id), eq(agentConfig.organizationId, organizationId)),
      )
      .where(eq(skill.organizationId, organizationId))
      .groupBy(skill.id),
    db
      .select({
        id: mcpServer.id,
        agents: sql<number>`count(distinct ${agentConfig.id})`,
      })
      .from(mcpServer)
      .leftJoin(agentConfigMcp, eq(mcpServer.id, agentConfigMcp.mcpServerId))
      .leftJoin(
        agentConfig,
        and(eq(agentConfigMcp.agentConfigId, agentConfig.id), eq(agentConfig.organizationId, organizationId)),
      )
      .where(eq(mcpServer.organizationId, organizationId))
      .groupBy(mcpServer.id),
    db
      .select({
        id: knowledgeBase.id,
        agents: sql<number>`count(distinct ${agentConfig.id})`,
      })
      .from(knowledgeBase)
      .leftJoin(
        agentKnowledgeBinding,
        and(eq(knowledgeBase.id, agentKnowledgeBinding.knowledgeBaseId), eq(agentKnowledgeBinding.enabled, true)),
      )
      .leftJoin(
        agentConfig,
        and(eq(agentKnowledgeBinding.agentConfigId, agentConfig.id), eq(agentConfig.organizationId, organizationId)),
      )
      .where(eq(knowledgeBase.organizationId, organizationId))
      .groupBy(knowledgeBase.id),
  ]);

  const agentCount = toCount(agentCountRows[0]?.count);
  const memberCount = toCount(memberCountRows[0]?.count);
  const sessionCount = toCount(sessionCountRows[0]?.count);
  const activeUserCount = toCount(activeUserRows[0]?.count);
  const activeAgentCount = toCount(activeAgentRows[0]?.count);
  const workflowRunCount = toCount(workflowRunRows[0]?.total);
  const workflowSucceededCount = toCount(workflowRunRows[0]?.succeeded);
  const environmentCount = environmentRows.reduce((sum, row) => sum + toCount(row.count), 0);
  const runningEnvironmentCount = environmentRows
    .filter((row) => row.status === "running")
    .reduce((sum, row) => sum + toCount(row.count), 0);
  const skillSummary = summarizeResources(skillResourceRows);
  const mcpSummary = summarizeResources(mcpResourceRows);
  const knowledgeSummary = summarizeResources(knowledgeResourceRows);
  const resourceSummary = {
    totalResources: skillSummary.total + mcpSummary.total + knowledgeSummary.total,
    boundResources: skillSummary.bound + mcpSummary.bound + knowledgeSummary.bound,
    reusedResources: skillSummary.reused + mcpSummary.reused + knowledgeSummary.reused,
    idleResources: skillSummary.idle + mcpSummary.idle + knowledgeSummary.idle,
    skills: skillSummary,
    mcpServers: mcpSummary,
    knowledgeBases: knowledgeSummary,
  };

  const trendMap = new Map(
    buildDateKeys(days).map((date) => [date, { date, sessions: 0, activeUsers: 0, agentsCreated: 0 }]),
  );
  for (const row of sessionTrendRows) {
    const key = toDateKey(row.date);
    const point = trendMap.get(key);
    if (point) {
      point.sessions = toCount(row.sessions);
      point.activeUsers = toCount(row.activeUsers);
    }
  }
  for (const row of agentTrendRows) {
    const key = toDateKey(row.date);
    const point = trendMap.get(key);
    if (point) {
      point.agentsCreated = toCount(row.agentsCreated);
    }
  }

  return {
    range,
    generatedAt: new Date().toISOString(),
    kpis: {
      agentCount,
      sessionCount,
      activeUserCount,
      activeAgentCount,
      memberCount,
      environmentCount,
      runningEnvironmentCount,
      workflowRunCount,
      workflowSuccessRate: ratio(workflowSucceededCount, workflowRunCount),
      activeAgentRatio: ratioPercent(activeAgentCount, agentCount),
      sessionsPerActiveAgent: ratio(sessionCount, activeAgentCount),
      activeUserRate: ratioPercent(activeUserCount, memberCount),
      resourceReuseRate: ratioPercent(resourceSummary.reusedResources, resourceSummary.totalResources),
      idleResourceCount: resourceSummary.idleResources,
    },
    trends: Array.from(trendMap.values()),
    topAgents: topAgentRows.map((row) => ({
      agentId: row.agentId,
      name: row.name,
      sessions: toCount(row.sessions),
      activeUsers: toCount(row.activeUsers),
    })),
    resourceSummary,
    proxyMetrics: [
      {
        key: "activeAgentRatio",
        value: ratioPercent(activeAgentCount, agentCount),
        unit: "percent",
        numerator: activeAgentCount,
        denominator: agentCount,
        estimated: true,
      },
      {
        key: "sessionsPerActiveAgent",
        value: ratio(sessionCount, activeAgentCount),
        unit: "sessions",
        numerator: sessionCount,
        denominator: activeAgentCount,
        estimated: true,
      },
      {
        key: "activeUserRate",
        value: ratioPercent(activeUserCount, memberCount),
        unit: "percent",
        numerator: activeUserCount,
        denominator: memberCount,
        estimated: true,
      },
      {
        key: "resourceReuseRate",
        value: ratioPercent(resourceSummary.reusedResources, resourceSummary.totalResources),
        unit: "percent",
        numerator: resourceSummary.reusedResources,
        denominator: resourceSummary.totalResources,
        estimated: true,
      },
      {
        key: "idleResources",
        value: resourceSummary.idleResources,
        unit: "items",
        numerator: resourceSummary.idleResources,
        denominator: resourceSummary.totalResources,
        estimated: true,
      },
    ],
    dataNotes: [
      "Agent、Environment、成员数为当前组织实时数据库统计。",
      "会话趋势与活跃用户来自 agent_session 业务会话，并通过 environment 关联当前组织。",
      "资源复用与闲置统计来自 Skill、MCP Server、Knowledge Base 与 Agent 的现有关联表。",
      "proxyMetrics 为基于真实使用数据推导的估算代理指标，当前不包含 token 成本、模型费用或人工收益。",
    ],
  };
}

const app = new Elysia({ name: "web-analytics" }).use(authGuardPlugin).model({
  "analytics-range": AnalyticsRangeSchema,
  "analytics-overview-response": AnalyticsOverviewResponseSchema,
});

app.get(
  "/analytics/overview",
  // biome-ignore lint/suspicious/noExplicitAny: Elysia 在 query/response 组合下类型推断不稳定
  async ({ store, query, status }: any) => {
    const authCtx = store.authContext!;
    const q = query as { range?: keyof typeof RANGE_DAYS };
    const range = q.range ?? "30d";
    try {
      return { success: true as const, data: await getAnalyticsOverview(authCtx.organizationId, range) };
    } catch (err: unknown) {
      logger.error("Failed to get analytics overview", err);
      return status(500, { success: false, error: { code: "INTERNAL_ERROR", message: internalErrorMessage(err) } });
    }
  },
  {
    sessionAuth: true,
    query: "analytics-range",
    response: {
      200: "analytics-overview-response",
      500: WebErrSchema,
    },
    detail: {
      tags: ["Analytics"],
      summary: "获取运营统计看板概览",
      description:
        "返回当前组织的 Agent 数量、业务会话趋势、活跃用户、状态分布和基于真实使用量推导的代理 ROI 指标；代理指标会显式标记为估算。",
    },
  },
);

export default app;
