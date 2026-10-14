/**
 * 平台管理面（`/api/system/**`）的浏览器侧模块：跨组织工单列表、详情、写动作与项目级只读数据的镜像端点。
 *
 * 凭据是系统 master key（`RCS_SYSTEM_API_KEYS`），由 `/admin` 的门后提供，经 `request()` 的 `bearerToken`
 * 注入 `Authorization` 头——与 observer / plugin-market 的管理面同一条通道
 * （`@fenix/web-runtime/lib/admin-key`）。**每次请求现取**：门内 401 会清掉它，缓存一份会让下次请求继续用
 * 失效凭据。
 *
 * ## 镜像规则（本文件与 `/web` 面的唯一关系）
 *
 * 管理面端点与既有 `/web/**` 面**逐字对齐**：同名动作、同载荷 schema、同响应形状，只把路径前缀
 * `/web` 换成 `/api/system`。因此路径一律由 `MIRROR_BASE` + `/web` 面的同一段路径拼出，不新增、不改名、
 * 不省略任何 PATH 段；`/web` 面没有的动作在这里也不存在（管理面不创建工单、不开通项目）。
 *
 * | 控制台面（`/web`） | 管理面（`/api/system`） |
 * | --- | --- |
 * | `GET /tickets` | `GET /tickets`（跨组织，页码分页） |
 * | `GET /tickets/:projectId/:number` | `GET /tickets/:projectId/:number` |
 * | `PATCH /tickets/:projectId/:number` | `PATCH /tickets/:projectId/:number` |
 * | `PUT /tickets/:projectId/:number/labels` | `PUT /tickets/:projectId/:number/labels` |
 * | `GET/POST /tickets/:projectId/:number/comments` | 同路径 |
 * | `PATCH /tickets/:projectId/:number/comments/:commentId` | 同路径 |
 * | `GET/POST /tickets/:projectId/:number/attachments` | 同路径 |
 * | `GET /tickets/:projectId/:number/attachments/:attachmentId` | 同路径（字节流） |
 * | `GET /ticket-projects/:projectId/labels` | `GET /tickets/:projectId/labels` |
 * | `GET /ticket-projects/:projectId/members` | `GET /tickets/:projectId/members` |
 * | `GET /ticket-operations/:operationId` | `GET /tickets/operations/:operationId` |
 *
 * 最后三行是**唯一不逐字对齐的三条**，且是服务端的事实，不是本文件的自由选择：管理面的全部路由挂在同一个
 * Elysia 实例的前缀 `/api/system/tickets` 之下（宿主 `app-route` 贡献只能返回单个实例，实例前缀无法被嵌套
 * 插件改到另一个根），因此 `/web` 面那两个**不在 `/web/tickets` 之下**的路径族只能收进这个前缀：标签目录与
 * 成员名录落到 `/:projectId/{labels,members}`，操作账本落到静态段 `/operations/:operationId`（静态段与
 * `/:projectId/:number` 不冲突）。三者的**载荷与响应形状仍与 `/web` 面逐字相同**。契约以
 * `docs/arch/29-tickets.md` §12 的路径表为准。
 *
 * 这三条对管理面是必需的：要能改标签与负责人，就必须能读标签目录与成员名录；要能处置「待确认的写」，
 * 就必须能读操作账本。标签目录的**写**路由（`POST/PATCH /web/ticket-projects/:projectId/labels`）不在
 * 镜像内——那是组织内的仓库级管理动作，不在「工单页面等价能力」范围内（标签编辑器只从目录里勾选）。
 *
 * ## 信封与形状
 *
 * 成功 `{ success: true, data }`、失败 `{ error: { code, message } }`（`/api/system/*` 既有口径，
 * `request()` 两种信封都能解出 `ApiResponse`）。`data` 内的形状与 `/web` 面**同一个 schema**，因此
 * 类型直接复用 `./tickets`、`./ticket-comments` 等模块的既有定义，本文件只多出「往哪个面发」。
 *
 * 列表行是唯一的例外：`/api/system/tickets` 的行比 `/web` 列表行多 **归属坐标**（组织 ID / 组织名 /
 * 项目 ID / 项目名 / 项目 owner），它们是**服务端字段**（列表由后端 join 项目表得到），不是前端回填。
 * 详情响应里**没有**坐标（与 `/web` 面同形），管理面的详情视图因此只能从列表行把坐标带过去。
 *
 * 分页是页码语义（`/api/system/*` 的既有口径），与 `/web/tickets` 的工单号游标不同：跨项目时工单号不构成
 * 全局序，游标在这里没有意义。
 */

import { type ApiResponse, request } from "@fenix/web-runtime/api/request";
import { getAdminKey } from "@fenix/web-runtime/lib/admin-key";
import { learnPlatformAuditAuthors, rememberPlatformWrittenComment } from "../lib/platform-audit-author";
import { TICKET_ATTACHMENT_TIMEOUT_MS } from "../lib/ticket-attachment-limits";
import { isUncertainAccepted } from "../lib/ticket-write-outcome";
import type { TicketAttachment, TicketAttachmentUploadResult } from "./ticket-attachments";
import { buildTicketAttachmentForm, downloadTicketBytes } from "./ticket-attachments";
import type {
  TicketCommentCreateBody,
  TicketCommentListQuery,
  TicketCommentPage,
  TicketCommentUpdateBody,
  TicketCommentWriteResult,
} from "./ticket-comments";
import type { TicketDataSource } from "./ticket-data-source";
import type { TicketOperationView } from "./ticket-operations";
import type { TicketProjectLabel, TicketProjectMemberPage, TicketProjectMemberQuery } from "./ticket-projects";
import type {
  TicketActor,
  TicketDetail,
  TicketLabel,
  TicketLabelSetBody,
  TicketState,
  TicketStateFilter,
  TicketSyncStatus,
  TicketUpdateBody,
  TicketWriteAccepted,
  TicketWriteOutcomeDto,
  TicketWriteResult,
} from "./tickets";
import { attachDetailProjectId, toTicketWriteResult } from "./tickets";

/**
 * 镜像端点前缀：管理面的全部路由都在宿主贡献的**同一个** Elysia 实例上，实例前缀是 `/api/system/tickets`
 * （见文件头的三条路径差异说明），因此这里以工单资源为根拼路径。
 */
const MIRROR_BASE = "/api/system/tickets";

/** 工单资源路径（`request()` 的 `:param` 插值口径）。 */
const TICKETS_PATH = `${MIRROR_BASE}/:projectId/:number`;
const COMMENTS_PATH = `${TICKETS_PATH}/comments`;
const ATTACHMENTS_PATH = `${TICKETS_PATH}/attachments`;
/** 项目级只读目录（标签 / 成员）：收在工单前缀之下，与 `/web/ticket-projects/**` 一一对应。 */
const CATALOG_PATH = `${MIRROR_BASE}/:projectId`;
/** 操作账本：静态段 `operations`，与 `/:projectId/:number` 不冲突（静态优先）。 */
const OPERATIONS_PATH = `${MIRROR_BASE}/operations/:operationId`;

/**
 * 每次请求现取的凭据：只取不缓存（门内 401 已清掉它，缓存会让下一次请求继续用失效凭据）。
 * 返回 `undefined` 时不设置头——由服务端给出 401，回门流程照常触发。
 */
function adminAuthorization(): { bearerToken: string } | Record<string, never> {
  const key = getAdminKey();
  return key === null ? {} : { bearerToken: key };
}

/** 管理面列表行：`/web` 列表行的字段 + 归属组织与仓库坐标。 */
export interface SystemTicketSummary {
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
  organizationId: string;
  /** 组织展示名；身份目录缺名时后端回退为组织 ID。 */
  organizationName: string;
  projectId: string;
  projectName: string;
  projectOwner: string;
}

/**
 * 归属坐标：列表行带来的「这张工单属于谁」。
 *
 * 详情视图要它是因为 `/web` 面的详情响应里**没有**坐标（那是列表 join 出来的）——管理面的详情只能从
 * 列表带过去，而不是自己给详情补一份服务端没给的字段。坐标与工单号一起构成管理面内的定位键。
 */
export interface SystemTicketCoordinate {
  organizationId: string;
  organizationName: string;
  projectId: string;
  projectName: string;
  projectOwner: string;
}

/** 列表查询：`organizationId` / `projectId` 是筛选而不是范围强制（本面的凭据本来就允许看全部组织）。 */
export interface SystemTicketListQuery {
  page: number;
  pageSize: number;
  q?: string;
  state?: TicketStateFilter;
  organizationId?: string;
  projectId?: string;
}

export interface SystemTicketListResult {
  items: SystemTicketSummary[];
  /** 同一筛选条件下的命中总数（跨页）。 */
  total: number;
  page: number;
  pageSize: number;
}

/** 管理面写响应：与 `/web` 面同一形状（判别规则复用 `toTicketWriteResult`）。 */
type SystemTicketWriteResponse = TicketWriteOutcomeDto | TicketWriteAccepted;

/**
 * 附件下载端点的裸 URL（不经 `request()`：它只处理信封与 JSON，二进制没有落点）。
 *
 * 管理面的下载必须带 `Authorization`，`<a href>` / `<img src>` 都带不上，因此这里只给路径，
 * 取字节由 {@link systemTicketsApi.downloadAttachment} 完成。
 */
export function systemTicketAttachmentDownloadPath(projectId: string, number: string, attachmentId: string): string {
  const base = `${MIRROR_BASE}/${encodeURIComponent(projectId)}/${encodeURIComponent(number)}/attachments`;
  return `${base}/${encodeURIComponent(attachmentId)}`;
}

/** 域模块不做 `unwrap`：成功/失败分支留给调用方的 `useRequest`（与 `./tickets` 同口径）。 */
export const systemTicketsApi = {
  list: (query: SystemTicketListQuery): Promise<ApiResponse<SystemTicketListResult>> =>
    request<SystemTicketListResult>(MIRROR_BASE, { ...adminAuthorization(), method: "GET", query }),

  /** 详情：与 `/web` 面同 schema，正文已剥离身份头；`pendingOperationId` 非空即有待确认的写。 */
  get: async (projectId: string, number: string): Promise<ApiResponse<TicketDetail>> => {
    const response = await request<{ ticket: Omit<TicketDetail, "projectId"> }>(TICKETS_PATH, {
      ...adminAuthorization(),
      params: { projectId, number },
    });
    if (!response.success || response.data === undefined) return { success: false, error: response.error };
    return { success: true, data: attachDetailProjectId(projectId, response.data.ticket) };
  },

  /** 修改标题 / 描述 / 负责人 / 状态（字段缺席表示不改，`assigneeId: null` 表示取消指派）。 */
  update: async (
    projectId: string,
    number: string,
    body: TicketUpdateBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketWriteResult>> => {
    const response = await request<SystemTicketWriteResponse>(TICKETS_PATH, {
      ...adminAuthorization(),
      method: "PATCH",
      params: { projectId, number },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (!response.success || response.data === undefined) return { success: false, error: response.error };
    return { success: true, data: toTicketWriteResult(projectId, response.data) };
  },

  /** 挂载标签（`labelIds` 是目标集合的全量列表，空数组表示清空）。 */
  setLabels: async (
    projectId: string,
    number: string,
    body: TicketLabelSetBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketWriteResult>> => {
    const response = await request<SystemTicketWriteResponse>(`${TICKETS_PATH}/labels`, {
      ...adminAuthorization(),
      method: "PUT",
      params: { projectId, number },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (!response.success || response.data === undefined) return { success: false, error: response.error };
    return { success: true, data: toTicketWriteResult(projectId, response.data) };
  },

  /**
   * 评论列表：按时间倒序（首屏最新），`nextCursor` 指向更早一页。
   *
   * 响应顺带喂给平台审计主体识别（`../lib/platform-audit-author`）：本面写入的评论在列表里解析出真实作者 id
   * 之后，同一主体的历史评论才能被认出来并呈现成「平台系统管理员」。
   */
  listComments: async (
    projectId: string,
    number: string,
    query?: TicketCommentListQuery,
  ): Promise<ApiResponse<TicketCommentPage>> => {
    const response = await request<TicketCommentPage>(COMMENTS_PATH, {
      ...adminAuthorization(),
      params: { projectId, number },
      query,
    });
    if (response.success && response.data !== undefined) learnPlatformAuditAuthors(response.data.items);
    return response;
  },

  /**
   * 发表评论（评论正文是唯一由调用方决定的字段）。成功后登记 `commentId`：这是「这条评论由平台凭据写的」
   * 唯一可靠信号（写响应里的作者恒为 `external`，服务端写入路径不回读刚落的归属行）。
   */
  createComment: async (
    projectId: string,
    number: string,
    body: TicketCommentCreateBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketCommentWriteResult>> => {
    const response = await request<TicketCommentWriteResult>(COMMENTS_PATH, {
      ...adminAuthorization(),
      method: "POST",
      params: { projectId, number },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (response.success && response.data !== undefined && !isUncertainAccepted(response.data)) {
      rememberPlatformWrittenComment(response.data.comment.commentId);
      learnPlatformAuditAuthors([response.data.comment]);
    }
    return response;
  },

  /**
   * 修改评论（管理面对任意评论开放：这一面不做原作者判定，凭据即判据）。
   *
   * **不登记** `commentId`：服务端事实是「修改不转移作者」，把一条组织成员写的评论登记成「平台写入的评论」
   * 会让它的作者被错误地呈现为系统管理员。只做作者识别（202 受理体没有评论本体，跳过）。
   */
  updateComment: async (
    projectId: string,
    number: string,
    commentId: string,
    body: TicketCommentUpdateBody,
    idempotencyKey: string,
  ): Promise<ApiResponse<TicketCommentWriteResult>> => {
    const response = await request<TicketCommentWriteResult>(`${COMMENTS_PATH}/:commentId`, {
      ...adminAuthorization(),
      method: "PATCH",
      params: { projectId, number, commentId },
      body,
      headers: { "Idempotency-Key": idempotencyKey },
    });
    if (response.success && response.data !== undefined && !isUncertainAccepted(response.data)) {
      learnPlatformAuditAuthors([response.data.comment]);
    }
    return response;
  },

  /** 附件列表（回源托管平台；上游不可用报错，不返回空列表）。 */
  listAttachments: (projectId: string, number: string): Promise<ApiResponse<{ items: TicketAttachment[] }>> =>
    request<{ items: TicketAttachment[] }>(ATTACHMENTS_PATH, {
      ...adminAuthorization(),
      params: { projectId, number },
    }),

  /** 上传单个附件（multipart、字段名 `file`、一次一个文件）。 */
  uploadAttachment: (
    projectId: string,
    number: string,
    file: File,
    idempotencyKey: string,
    signal?: AbortSignal,
  ): Promise<ApiResponse<TicketAttachmentUploadResult>> =>
    request<TicketAttachmentUploadResult>(ATTACHMENTS_PATH, {
      ...adminAuthorization(),
      method: "POST",
      params: { projectId, number },
      body: buildTicketAttachmentForm(file),
      headers: { "Idempotency-Key": idempotencyKey },
      timeout: TICKET_ATTACHMENT_TIMEOUT_MS,
      ...(signal === undefined ? {} : { signal }),
    }),

  /** 下载附件字节：管理面的凭据是 `Authorization` 头，`<a>` / `<img>` 带不上，只能取回 `Blob` 再落盘。 */
  downloadAttachment: (projectId: string, number: string, attachmentId: string, signal?: AbortSignal): Promise<Blob> =>
    downloadTicketBytes(systemTicketAttachmentDownloadPath(projectId, number, attachmentId), {
      ...(signal === undefined ? {} : { signal }),
      ...adminAuthorization(),
    }),

  /** 项目标签目录（仓库级小集合，服务端一次给全）：标签编辑的候选来源。 */
  listProjectLabels: (projectId: string): Promise<ApiResponse<{ items: TicketProjectLabel[] }>> =>
    request<{ items: TicketProjectLabel[] }>(`${CATALOG_PATH}/labels`, {
      ...adminAuthorization(),
      params: { projectId },
    }),

  /** 可指派成员（服务端已收窄成 `{ userId, name }`）：负责人编辑的候选来源。 */
  listProjectMembers: (
    projectId: string,
    query?: TicketProjectMemberQuery,
  ): Promise<ApiResponse<TicketProjectMemberPage>> =>
    request<TicketProjectMemberPage>(`${CATALOG_PATH}/members`, {
      ...adminAuthorization(),
      params: { projectId },
      query,
    }),

  /** 核对一次写操作的结果（202 之后唯一的取数入口）。 */
  getOperation: async (operationId: string): Promise<ApiResponse<TicketOperationView>> => {
    const response = await request<{ operation: TicketOperationView }>(OPERATIONS_PATH, {
      ...adminAuthorization(),
      params: { operationId },
    });
    if (!response.success || response.data === undefined) return { success: false, error: response.error };
    return { success: true, data: response.data.operation };
  },
};

/**
 * 平台管理面数据源：与 `webTicketDataSource`（`./ticket-data-source`）同接口，页面编排层与展示组件因此可以
 * 整体复用到管理面（同一套取数、写状态机、冲突与待确认处置）。
 */
export const systemTicketDataSource: TicketDataSource = {
  tickets: { get: systemTicketsApi.get, update: systemTicketsApi.update, setLabels: systemTicketsApi.setLabels },
  comments: {
    list: systemTicketsApi.listComments,
    create: systemTicketsApi.createComment,
    update: systemTicketsApi.updateComment,
  },
  attachments: {
    list: systemTicketsApi.listAttachments,
    upload: systemTicketsApi.uploadAttachment,
    download: systemTicketsApi.downloadAttachment,
  },
  projects: { labels: systemTicketsApi.listProjectLabels, members: systemTicketsApi.listProjectMembers },
  operations: { get: systemTicketsApi.getOperation },
};
