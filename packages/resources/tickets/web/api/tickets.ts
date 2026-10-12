/**
 * 工单域模块：列表、详情、创建（`/web/tickets/:projectId...`）。
 *
 * 类型逐字段对应后端 `TicketSummaryViewSchema` / `TicketDetailViewSchema` / `TicketListResponseSchema` /
 * `TicketResponseSchema` / `TicketUncertainResponseSchema`（本包 `src/schemas/ticket.schema.ts`）。两处与
 * 「按直觉命名」不同的地方都是后端事实，不是笔误：
 * - 列表行/详情的工单号字段名是 `issueNumber`（不是 `number`），类型是 `string`——外部数字 ID 在协议里
 *   一律按字符串承载，不得退化成 number；
 * - 索引时间与来源时间是分开的两个字段：`syncedAt`（本地索引写入时间）与 `providerUpdatedAt`
 *   （托管平台最后更新时间，可能为 `null`），界面表达索引新鲜度时必须用前者。
 *
 * **`projectId` 是回填字段，不是服务端字段**：后端行里没有它，而所有工单资源 URL 都必须显式带项目，
 * 否则默认项目切换的竞态窗口会把一次点击带去另一个仓库。回填来源是本模块自己在请求里带的
 * `projectId` 参数，因此不引入「服务端不返回却前端存在」的幻影字段。
 *
 * 域模块不做 `unwrap`（成功/失败分支留给调用方的 `useRequest`），也不生成幂等键——键由**用户动作层**
 * 持有并跨重试复用（见 `web/lib/ticket-write-outcome.ts`）。
 */

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import { request } from "@fenix/web-runtime/api/request";

/** 工单状态；用托管平台原生字段，不做本地映射。 */
export type TicketState = "open" | "closed";

/** 列表筛选用的状态：后端查询参数接受 `all`，缺省即 `all`。 */
export type TicketStateFilter = TicketState | "all";

/**
 * 作者归属来源：`aos` 表示归属账本核验通过，`external` 表示缺少受信记录或摘要不一致。
 *
 * 界面据此显示「外部来源／待核对」，且不得按外部自填的身份授予编辑权——权限判定只在服务端。
 */
export type TicketActorSource = "aos" | "external";

/** 作者/负责人投影；`id` 为 `null` 表示来源不可信（身份头与归属记录未同时通过核验）。 */
export interface TicketActor {
  id: string | null;
  name: string;
  source: TicketActorSource;
}

/** 标签投影；颜色是上游自由字段，缺失时由界面回退默认样式。 */
export interface TicketLabel {
  id: string;
  name: string;
  color: string | null;
}

/** 行的索引新鲜度：`stale` 表示本地索引未同步到最新（详情仍会回源上游）。 */
export type TicketSyncStatus = "ready" | "stale";

/** 后端返回的列表行，与 `TicketSummaryViewSchema` 逐字段一致（不含回填字段）。 */
interface TicketSummaryDto {
  issueNumber: string;
  title: string;
  state: TicketState;
  author: TicketActor;
  assignee: TicketActor | null;
  labels: TicketLabel[];
  version: string;
  providerUpdatedAt: string | null;
  syncedAt: string;
  syncStatus: TicketSyncStatus;
}

/** 后端返回的详情，与 `TicketDetailViewSchema` 逐字段一致（不含回填字段）。 */
interface TicketDetailDto extends TicketSummaryDto {
  body: string;
}

/** 列表行（含回填的 {@link TicketSummary.projectId}），供列表页直接渲染与建链接。 */
export interface TicketSummary extends TicketSummaryDto {
  /**
   * 产生本行的项目 ID。**不是服务端字段**：由 {@link ticketApi} 用请求上下文回填，行内链接必须用它，
   * 否则默认项目切换后同一个工单号会指向另一个仓库。
   */
  readonly projectId: string;
}

/** 详情：列表行之上补**已剥离身份头**的正文（身份头是服务端协议头，不渲染给人看）。 */
export interface TicketDetail extends TicketSummary {
  body: string;
}

/** 列表页：游标分页，`nextCursor` 为 `null` 表示没有下一页；游标对前端是不透明字符串。 */
export interface TicketListPage {
  items: TicketSummary[];
  nextCursor: string | null;
}

export interface TicketListQuery {
  /** 关键词（标题），服务端按本地索引检索。 */
  q?: string;
  state?: TicketStateFilter;
  assigneeId?: string;
  labelId?: string;
  /** 上一页返回的游标；首页不传。 */
  cursor?: string;
  /** 服务端默认 30、上限 100；调用方显式传值，避免默认值漂移。 */
  limit?: number;
}

/**
 * 创建请求体。
 *
 * 后端 `TicketCreateRequestSchema` 是 `strictObject({ title, body })`，`body` 最小长度 1：正文是**必填**，
 * 省略会被边界以 400 拒绝（不会建出一个没有正文的工单），因此这里不给可选；多传字段同样 400。
 */
export interface TicketCreateBody {
  title: string;
  body: string;
}

/** 创建成功（201）：工单本体 + 操作账本 ID。 */
export interface TicketCreateOutcome {
  ticket: TicketDetail;
  operationId: string;
}

/** 受理（202）：上游写入结果未定，`status` 是判别字段（工单本体只有 `state`，两者不会混淆）。 */
export interface TicketWriteAccepted {
  operationId: string;
  status: "uncertain";
}

/** 创建响应：201 工单本体，202 受理体；判别用 `web/lib/ticket-write-outcome.ts` 的类型守卫。 */
export type TicketCreateResult = TicketCreateOutcome | TicketWriteAccepted;

/** 后端创建响应（201）：`ticket` 尚未回填 `projectId`。 */
interface TicketCreateOutcomeDto {
  ticket: TicketDetailDto;
  operationId: string;
}

/** 后端列表响应对应的原始形状。 */
interface TicketListPageDto {
  items: TicketSummaryDto[];
  nextCursor: string | null;
}

function attachProjectId(projectId: string, ticket: TicketSummaryDto): TicketSummary {
  return { ...ticket, projectId };
}

function attachDetailProjectId(projectId: string, ticket: TicketDetailDto): TicketDetail {
  return { ...ticket, projectId };
}

/** 失败信封原样透传：工单错误不携带附加 `data`（`error.code` 才是调用方的分支依据）。 */
function passthroughFailure(response: ApiResponse<unknown>): { success: false; error: ApiResponse<unknown>["error"] } {
  return { success: false, error: response.error };
}

export const ticketApi = {
  /** 按项目列出工单索引（不回源上游正文）；关键词与状态筛选、游标翻页都由服务端完成。 */
  list: async (projectId: string, query?: TicketListQuery): Promise<ApiResponse<TicketListPage>> => {
    const response = await request<TicketListPageDto>("/web/tickets/:projectId", { params: { projectId }, query });
    if (!response.success || response.data === undefined) return passthroughFailure(response);
    return {
      success: true,
      data: {
        nextCursor: response.data.nextCursor,
        items: response.data.items.map((item) => attachProjectId(projectId, item)),
      },
    };
  },

  /** 按工单号取详情：正文回源托管平台，作者归属经服务端账本核验。 */
  get: async (projectId: string, number: string): Promise<ApiResponse<TicketDetail>> => {
    const response = await request<{ ticket: TicketDetailDto }>("/web/tickets/:projectId/:number", {
      params: { projectId, number },
    });
    if (!response.success || response.data === undefined) return passthroughFailure(response);
    return { success: true, data: attachDetailProjectId(projectId, response.data.ticket) };
  },

  /**
   * 创建工单。`idempotencyKey` 由用户动作层生成并跨重试复用（同键同内容返回原操作，同键不同内容 409），
   * 域模块不自己生成，否则每次调用都是新键，服务端的去重失效。
   */
  create: async (
    projectId: string,
    body: TicketCreateBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketCreateResult>> => {
    const response = await request<TicketCreateOutcomeDto | TicketWriteAccepted>("/web/tickets/:projectId", {
      method: "POST",
      params: { projectId },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (!response.success || response.data === undefined) return passthroughFailure(response);
    const outcome = response.data;
    // 两种响应形状靠 `status` 的**存在性**区分：202 受理体带 `status`，201 工单本体只有 `state`
    //（各自的 schema 已把这个区分钉死在类型上，故不需要额外的值判别）。只有 201 需要回填 projectId；
    // 调用方对拿到手的结果用 `web/lib/ticket-write-outcome.ts` 的 `isUncertainAccepted` 做判别。
    if ("status" in outcome) return { success: true, data: outcome };
    return {
      success: true,
      data: { operationId: outcome.operationId, ticket: attachDetailProjectId(projectId, outcome.ticket) },
    };
  },
};
