/**
 * 工单数据源端口：把「页面要哪些数据动作」与「这些动作打到哪个协议面」拆开。
 *
 * 同一个工单功能有两个协议面，**判据不同、范围不同，但业务形状逐字相同**：
 * - 控制台面 `/web/tickets/**`：凭据是用户会话（cookie），可见范围由组织与项目授权收敛；
 * - 平台管理面 `/api/system/tickets/**`：凭据是系统 master key（`Authorization: Bearer`），跨组织，无 actor。
 * 两面的路径、载荷与响应形状按镜像规则对齐（见 `./system-tickets` 的文件头），因此页面编排层（取数、写状态机、
 * 幂等键、冲突与待确认处置）与展示组件**完全共用一份**，差异只剩这一层的绑定。
 *
 * 端口按域（tickets / comments / attachments / projects / operations）分组，组内签名与 `ticketApi`、
 * `ticketCommentsApi`、`ticketAttachmentsApi`、`ticketProjectsApi`、`ticketOperationsApi` **逐个相同**——
 * 控制台源因此是纯绑定（没有一行适配代码），接口漂移会在绑定处立刻类型报错，而不是运行期才 404。
 *
 * **幂等键与错误分类不在本层**：键由用户动作层持有并跨重试复用（`web/lib/ticket-write-outcome`），失败语义
 * 由 `web/lib/ticket-write-failure` 统一分类；端口只负责「把请求发到哪个面」这一件事。
 */

import type { ApiResponse } from "@fenix/web-runtime/api/request";
import type { TicketAttachment, TicketAttachmentUploadResult } from "./ticket-attachments";
import { downloadTicketAttachment, ticketAttachmentsApi } from "./ticket-attachments";
import type {
  TicketCommentCreateBody,
  TicketCommentListQuery,
  TicketCommentPage,
  TicketCommentUpdateBody,
  TicketCommentWriteResult,
} from "./ticket-comments";
import { ticketCommentsApi } from "./ticket-comments";
import type { TicketOperationView } from "./ticket-operations";
import { ticketOperationsApi } from "./ticket-operations";
import type { TicketProjectLabel, TicketProjectMemberPage, TicketProjectMemberQuery } from "./ticket-projects";
import { ticketProjectsApi } from "./ticket-projects";
import type { TicketDetail, TicketLabelSetBody, TicketUpdateBody, TicketWriteResult } from "./tickets";
import { ticketApi } from "./tickets";

/** 工单详情的读写动作（`/web/tickets/:projectId/:number`）。 */
export interface TicketDataSourceTickets {
  /** 取详情：正文回源托管平台，作者归属经服务端账本核验。 */
  readonly get: (projectId: string, number: string) => Promise<ApiResponse<TicketDetail>>;
  /** 修改标题 / 描述 / 负责人 / 状态；请求体只带本次动作字段 + `expectedVersion`。 */
  readonly update: (
    projectId: string,
    number: string,
    body: TicketUpdateBody,
    idempotencyKey: string,
  ) => Promise<ApiResponse<TicketWriteResult>>;
  /** 挂载标签（全量集合语义）。 */
  readonly setLabels: (
    projectId: string,
    number: string,
    body: TicketLabelSetBody,
    idempotencyKey: string,
  ) => Promise<ApiResponse<TicketWriteResult>>;
}

/** 评论的读写动作（`/web/tickets/:projectId/:number/comments`）。 */
export interface TicketDataSourceComments {
  readonly list: (
    projectId: string,
    number: string,
    query?: TicketCommentListQuery,
  ) => Promise<ApiResponse<TicketCommentPage>>;
  readonly create: (
    projectId: string,
    number: string,
    body: TicketCommentCreateBody,
    idempotencyKey: string,
  ) => Promise<ApiResponse<TicketCommentWriteResult>>;
  /**
   * 修改评论。控制台面要求「原作者或组织管理员」；平台管理面无 actor，镜像端点是否放行由服务端裁定，
   * 前端不预判——管理面今天也不渲染编辑入口（无会话用户 = 无从判断「这条是不是我写的」）。
   */
  readonly update: (
    projectId: string,
    number: string,
    commentId: string,
    body: TicketCommentUpdateBody,
    idempotencyKey: string,
  ) => Promise<ApiResponse<TicketCommentWriteResult>>;
}

/** 附件的读写动作（`/web/tickets/:projectId/:number/attachments`）。 */
export interface TicketDataSourceAttachments {
  readonly list: (projectId: string, number: string) => Promise<ApiResponse<{ items: TicketAttachment[] }>>;
  readonly upload: (
    projectId: string,
    number: string,
    file: File,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) => Promise<ApiResponse<TicketAttachmentUploadResult>>;
  /** 下载字节（不是 `/web` 信封，故返回 `Blob`，失败抛 `ApiError`）。 */
  readonly download: (projectId: string, number: string, attachmentId: string, signal?: AbortSignal) => Promise<Blob>;
}

/** 项目级只读数据：标签目录与可指派成员（写入点在工单上，见 `tickets.setLabels` 与 `tickets.update`）。 */
export interface TicketDataSourceProjects {
  readonly labels: (projectId: string) => Promise<ApiResponse<{ items: TicketProjectLabel[] }>>;
  readonly members: (
    projectId: string,
    query?: TicketProjectMemberQuery,
  ) => Promise<ApiResponse<TicketProjectMemberPage>>;
}

/** 操作账本（`/web/ticket-operations/:operationId`）：202 之后「核对结果」的唯一取数入口。 */
export interface TicketDataSourceOperations {
  readonly get: (operationId: string) => Promise<ApiResponse<TicketOperationView>>;
}

/**
 * 一份完整的数据源。页面编排层只依赖本接口，因此同一套 hooks 与展示组件可以整体挂到另一个协议面上。
 */
export interface TicketDataSource {
  readonly tickets: TicketDataSourceTickets;
  readonly comments: TicketDataSourceComments;
  readonly attachments: TicketDataSourceAttachments;
  readonly projects: TicketDataSourceProjects;
  readonly operations: TicketDataSourceOperations;
}

/** 控制台面数据源：`/web/**` + 会话 cookie。 */
export const webTicketDataSource: TicketDataSource = {
  tickets: { get: ticketApi.get, update: ticketApi.update, setLabels: ticketApi.setLabels },
  comments: { list: ticketCommentsApi.list, create: ticketCommentsApi.create, update: ticketCommentsApi.update },
  attachments: {
    list: ticketAttachmentsApi.list,
    upload: ticketAttachmentsApi.upload,
    download: downloadTicketAttachment,
  },
  projects: { labels: ticketProjectsApi.labels, members: ticketProjectsApi.members },
  operations: { get: ticketOperationsApi.get },
};
