import * as z from "zod/v4";
import { WebOkSchema } from "./common.schema";

export const AnalyticsRangeSchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).optional().default("30d").describe("统计时间范围。"),
});

export const AnalyticsKpiSchema = z.object({
  agentCount: z.number().describe("当前组织下 Agent 配置总数。"),
  sessionCount: z.number().describe("统计周期内创建的业务会话总数。"),
  activeUserCount: z.number().describe("统计周期内发起过业务会话的去重用户数。"),
  activeAgentCount: z.number().describe("统计周期内至少产生过一次业务会话的 Agent 数。"),
  memberCount: z.number().describe("当前组织成员总数。"),
  environmentCount: z.number().describe("当前组织下运行环境总数。"),
  runningEnvironmentCount: z.number().describe("当前组织下 running 状态的运行环境数量。"),
  workflowRunCount: z.number().describe("统计周期内工作流运行次数。"),
  workflowSuccessRate: z.number().describe("统计周期内工作流成功率，范围 0-1；没有运行记录时为 0。"),
  activeAgentRatio: z.number().describe("活跃 Agent 占比，范围 0-1；没有 Agent 时为 0。"),
  sessionsPerActiveAgent: z.number().describe("单活跃 Agent 产出：统计周期内会话数 / 活跃 Agent 数。"),
  activeUserRate: z.number().describe("用户活跃率：统计周期内活跃用户数 / 当前组织成员数。"),
  resourceReuseRate: z.number().describe("资源复用率：被 2 个及以上 Agent 绑定的资源数 / 资源总数。"),
  idleResourceCount: z.number().describe("闲置资源数：没有被任何 Agent 绑定的 Skill、MCP Server、知识库数量。"),
});

export const AnalyticsTrendPointSchema = z.object({
  date: z.string().describe("日期，格式为 YYYY-MM-DD。"),
  sessions: z.number().describe("该日新增业务会话数。"),
  activeUsers: z.number().describe("该日发起过业务会话的去重用户数。"),
  agentsCreated: z.number().describe("该日新增 Agent 配置数。"),
});

export const AnalyticsTopAgentSchema = z.object({
  agentId: z.string().describe("Agent 配置 ID。"),
  name: z.string().describe("Agent 名称。"),
  sessions: z.number().describe("统计周期内该 Agent 关联的业务会话数。"),
  activeUsers: z.number().describe("统计周期内该 Agent 关联的去重活跃用户数。"),
});

export const AnalyticsResourceBucketSchema = z.object({
  total: z.number().describe("该类资源总数。"),
  bound: z.number().describe("已被至少 1 个 Agent 绑定的资源数。"),
  reused: z.number().describe("已被 2 个及以上 Agent 绑定的资源数。"),
  idle: z.number().describe("未被任何 Agent 绑定的资源数。"),
});

export const AnalyticsResourceSummarySchema = z.object({
  totalResources: z.number().describe("Skill、MCP Server、知识库资源总数。"),
  boundResources: z.number().describe("已绑定到至少 1 个 Agent 的资源总数。"),
  reusedResources: z.number().describe("已绑定到 2 个及以上 Agent 的资源总数。"),
  idleResources: z.number().describe("未绑定到任何 Agent 的资源总数。"),
  skills: AnalyticsResourceBucketSchema.describe("Skill 资源复用与闲置统计。"),
  mcpServers: AnalyticsResourceBucketSchema.describe("MCP Server 资源复用与闲置统计。"),
  knowledgeBases: AnalyticsResourceBucketSchema.describe("知识库资源复用与闲置统计。"),
});

export const AnalyticsProxyMetricSchema = z.object({
  key: z.string().describe("代理指标键名。"),
  value: z.number().describe("代理指标值。"),
  unit: z.string().describe("指标单位。"),
  numerator: z.number().describe("计算该指标使用的分子。"),
  denominator: z.number().describe("计算该指标使用的分母；计数类指标用于展示总量口径。"),
  estimated: z.literal(true).describe("是否为估算或代理指标；当前固定为 true。"),
});

export const AnalyticsOverviewDataSchema = z.object({
  range: z.enum(["7d", "30d", "90d"]).describe("本次统计时间范围。"),
  generatedAt: z.string().describe("统计生成时间 ISO 字符串。"),
  kpis: AnalyticsKpiSchema.describe("核心平台指标。"),
  trends: AnalyticsTrendPointSchema.array().describe("按日聚合的趋势数据。"),
  topAgents: AnalyticsTopAgentSchema.array().describe("统计周期内使用量最高的 Agent。"),
  resourceSummary: AnalyticsResourceSummarySchema.describe("当前组织下资源绑定、复用与闲置统计。"),
  proxyMetrics: AnalyticsProxyMetricSchema.array().describe("基于真实使用量推导的代理 ROI 指标，非真实成本收益数据。"),
  dataNotes: z.string().array().describe("数据口径说明，包含估算字段提示。"),
});

export const AnalyticsOverviewResponseSchema = WebOkSchema(AnalyticsOverviewDataSchema).describe("运营看板概览响应。");

export type AnalyticsOverviewData = z.infer<typeof AnalyticsOverviewDataSchema>;
export type AnalyticsRange = z.infer<typeof AnalyticsRangeSchema>;
