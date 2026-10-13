import { z } from "zod/v4";

/**
 * Trace 观测读取的**对外协议契约**（`/web/agents/:environmentId/sessions/:sessionId/traces*`）。
 *
 * 上游是 Langfuse 公共 API 的兼容实现，字段名由它定义；本文件是**本模块自己的**协议面，逐字段决定
 * 哪些上游字段可以到达浏览器（见 {@link OBSERVATION_ALLOWED_KEYS}）。两者刻意分开：上游换版本时，收敛
 * 点在这里；前端只依赖本协议，不依赖兼容实现的内部字段（`projectId`、`*Price` 这类既不进契约）。
 */

/** 一次 run（= peri 的一个 turn）的列表项：面板左栏只需这些字段。 */
export const TraceSummarySchema = z.object({
  /** Langfuse trace id（UUID）；后续详情请求以它为准，前端不自行拼接。 */
  id: z.string().min(1),
  /** trace 名称；peri 侧为 `turn <traceId>`。 */
  name: z.string().nullable(),
  /** 起始时间（ISO 字符串，上游原样）。 */
  timestamp: z.string().nullable(),
  /** 会话分组键，等于 ACP session id。 */
  sessionId: z.string().nullable(),
  userId: z.string().nullable(),
  version: z.string().nullable(),
  release: z.string().nullable(),
  environment: z.string().nullable(),
  bookmarked: z.boolean(),
  tags: z.array(z.string()),
});
export type TraceSummary = z.infer<typeof TraceSummarySchema>;

/** trace 列表响应：`configured: false` 表示部署未配置观测读取，与「这个会话没有 run」严格区分。 */
export const TraceListResponseSchema = z.object({
  configured: z.boolean(),
  /** 当前活跃 ACP session id（= Langfuse sessionId）；为 null 表示该会话尚未建立 ACP 会话。 */
  acpSessionId: z.string().nullable(),
  traces: z.array(TraceSummarySchema),
  /** 上游分页信息；未配置或未建立会话时 page 为 1、totalItems 为 0。 */
  page: z.number().int().positive(),
  totalItems: z.number().int().nonnegative(),
});
export type TraceListResponse = z.infer<typeof TraceListResponseSchema>;

/**
 * observation 允许到达浏览器的键（上游 v2 响应字段的子集）。
 *
 * 是白名单而不是黑名单：兼容实现新增字段时默认**不外泄**，需要展示时在这里显式登记。`projectId` 与
 * `inputPrice` / `outputPrice` / `totalPrice` 属于上游内部账务字段，本面板不消费。
 */
export const OBSERVATION_ALLOWED_KEYS = [
  "id",
  "traceId",
  "parentObservationId",
  "type",
  "name",
  "startTime",
  "endTime",
  "completionStartTime",
  "level",
  "statusMessage",
  "version",
  "environment",
  "userId",
  "sessionId",
  "bookmarked",
  "isRootObservation",
  "createdAt",
  "updatedAt",
  "input",
  "output",
  "metadata",
  "providedModelName",
  "internalModelId",
  "modelParameters",
  "usageDetails",
  "costDetails",
  "totalCost",
  "promptId",
  "promptName",
  "promptVersion",
  "latency",
  "timeToFirstToken",
  "tags",
  "release",
  "traceName",
] as const;

/**
 * observation 的宽松 schema。
 *
 * 只对图渲染真正依赖的三个字段做强约束（`id` / `type` / `startTime`，缺任一都无法定位节点），其余按白名单
 * 原样透传：上游字段的可空性随版本变化，逐字段强类型会把「上游加了字段」变成「面板整个不可用」，而面板对
 * 未知字段的处置本来就只是不展示。
 */
export const TraceObservationSchema = z.looseObject({
  id: z.string().min(1),
  type: z.string().min(1),
  startTime: z.string().min(1),
});
export type TraceObservation = z.infer<typeof TraceObservationSchema>;

/** observation 游标分页响应（游标语义与上游一致：不透明字符串，前端原样回传）。 */
export const ObservationPageResponseSchema = z.object({
  data: z.array(TraceObservationSchema),
  /** 下一页游标；null 表示已到末页。 */
  cursor: z.string().nullable(),
});
export type ObservationPageResponse = z.infer<typeof ObservationPageResponseSchema>;

/** 单条 observation（详情 / 图懒加载共用同一形状）。 */
export const ObservationResponseSchema = z.object({ data: TraceObservationSchema });
export type ObservationResponse = z.infer<typeof ObservationResponseSchema>;

/** 路径参数：environmentId 是 Environment 主键，sessionId 是前端 URL 的实例 uid（非 ACP session id）。 */
export const TraceRouteParamsSchema = z.object({
  environmentId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type TraceRouteParams = z.infer<typeof TraceRouteParamsSchema>;

/** trace 列表查询参数。 */
export const TraceListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(1_000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type TraceListQuery = z.infer<typeof TraceListQuerySchema>;

/** observation 列表查询参数：游标不透明，limit 上限压到 200（一次图渲染够用，且把上游响应体锁在有界范围）。 */
export const ObservationListQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(200),
});
export type ObservationListQuery = z.infer<typeof ObservationListQuerySchema>;
