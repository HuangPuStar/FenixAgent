import { WebOkSchema } from "@fenix/platform-sdk";
import * as z from "zod/v4";
import {
  IDEMPOTENCY_KEY_PATTERN,
  TICKET_LIST_DEFAULT_LIMIT,
  TICKET_LIST_MAX_LIMIT,
  TICKET_TITLE_MAX_LENGTH,
} from "../server/services/ticket-limits";

/**
 * 工单（`/web/tickets/:projectId...`）的请求、查询与响应 schema。
 *
 * 视图 schema 与 Facade 的 `TicketSummaryView` / `TicketDetailView` 一一对应（backend contract §4.3），
 * 只允许出现真实返回的字段：前端按这些 schema 建型，多一个「幻影字段」就会让前端渲染出永不存在的值。
 *
 * 请求体**不含**任何身份字段（作者、message_id）：作者一律取凭据主体，服务端在写入路径生成身份头
 * （backend contract §7.3）。schema 层的拒绝不是授权依据——组织范围与角色判定只在 Facade。
 */

/**
 * 创建工单：标题长度按字符数限定，正文的 UTF-8 字节上限在 `buildTicketBody` 的最终字符串上再校验一次。
 *
 * 用 `strictObject` 而非 `object`：请求体只接受标题与正文，多传任何字段（例如伪造的 `author`）都当场
 * 400，而不是被静默剥掉。剥掉同样安全，但「拒绝」能把调用方的契约错误暴露在边界上（§10 的伪造 author 用例）。
 */
export const TicketCreateRequestSchema = z.strictObject({
  title: z.string().min(1).max(TICKET_TITLE_MAX_LENGTH).describe("标题"),
  body: z.string().min(1).describe("正文（Markdown；服务端负责加身份头）"),
});

/**
 * 列表查询：`q` 只匹配标题（不承诺评论全文检索），`state` 缺省按 `all` 处理，游标是本页末条的工单号。
 *
 * `limit` 用 `z.coerce` 是因为查询串一律是字符串；`.default` 让路由不必再判缺省值。
 */
export const TicketListQuerySchema = z.object({
  q: z.string().min(1).max(200).optional(),
  state: z.enum(["open", "closed", "all"]).optional(),
  assigneeId: z.string().min(1).optional(),
  labelId: z.string().min(1).optional(),
  cursor: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_LIST_MAX_LIMIT).default(TICKET_LIST_DEFAULT_LIMIT),
});

/** 工单作者/负责人投影：`id` 为 `null` 表示来源不可信（身份头与归属记录未同时通过核验）。 */
export const TicketActorViewSchema = z.object({
  id: z.string().nullable(),
  name: z.string(),
  source: z.enum(["aos", "external"]),
});

/** 标签投影：颜色是可空的上游自由字段，缺失时由前端回退默认样式。 */
const TicketLabelViewSchema = z.object({
  id: z.string(),
  name: z.string(),
  color: z.string().nullable(),
});

/** 列表行：只来自 `ticket_index`（列表不回源上游），`version` 是内容指纹，`syncStatus` 表达索引新鲜度。 */
export const TicketSummaryViewSchema = z.object({
  issueNumber: z.string(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  author: TicketActorViewSchema,
  assignee: TicketActorViewSchema.nullable(),
  labels: TicketLabelViewSchema.array(),
  version: z.string(),
  providerUpdatedAt: z.string().nullable(),
  syncedAt: z.string(),
  syncStatus: z.enum(["ready", "stale"]),
});

/** 详情：在列表行之上补**已剥离身份头**的正文（前端不渲染协议头）。 */
export const TicketDetailViewSchema = TicketSummaryViewSchema.extend({
  body: z.string(),
});

/** 列表响应：`nextCursor` 为 `null` 表示没有下一页。 */
export const TicketListResponseSchema = WebOkSchema(
  z.object({
    items: TicketSummaryViewSchema.array(),
    nextCursor: z.string().nullable(),
  }),
);

/** 创建成功（201）：`operationId` 同时给出，便于前端在需要时复核操作账本。 */
export const TicketResponseSchema = WebOkSchema(
  z.object({
    ticket: TicketDetailViewSchema,
    operationId: z.string(),
  }),
);

/** 详情响应（200）：只带工单本体，不带操作账本（`GET /tickets/:projectId/:number`）。 */
export const TicketDetailResponseSchema = WebOkSchema(
  z.object({
    ticket: TicketDetailViewSchema,
  }),
);

/** 创建未确认（202）：上游可能已写入，前端据此提示「结果确认中」并按 operationId 手动复核。 */
export const TicketUncertainResponseSchema = WebOkSchema(
  z.object({
    operationId: z.string(),
    status: z.literal("uncertain"),
  }),
);

/** 工单路径参数：`projectId` 是 uuid（工单资源 URL 显式带项目，避免默认项目切换后链接漂移）。 */
export const TicketProjectParamsSchema = z.object({
  projectId: z.string().uuid().describe("工单项目 ID"),
});

/** 工单详情路径参数：`number` 是 Forgejo 的 issue 序号，按字符串承载（外部数字 ID 不得退化为 number）。 */
export const TicketDetailParamsSchema = z.object({
  projectId: z.string().uuid().describe("工单项目 ID"),
  number: z
    .string()
    .regex(/^[1-9]\d*$/)
    .describe("工单号（正整数）"),
});

/**
 * 写路由（创建工单、开通项目）共用的 `Idempotency-Key` 头模型。
 *
 * 键名一律小写：HTTP 头名大小写不敏感，但 Elysia 的 `headers` 模型按小写键匹配。缺失与不合法在路由层
 * 分别映射为 `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID`（校验失败时两者无法在 schema 内区分）。
 */
export const IdempotencyKeyHeaderSchema = z.object({
  "idempotency-key": z.string().regex(IDEMPOTENCY_KEY_PATTERN),
});
