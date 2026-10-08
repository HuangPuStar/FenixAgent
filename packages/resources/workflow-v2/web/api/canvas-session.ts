// web/api/canvas-session.ts
// 画布宿主页的域模块：控制台面（租户绑定 / 平台账号 / 一次性 code）与画布会话端点（兑换 / 续期 / 撤销）。
//
// 两条面在客户端也是两套信封，本文件是它们唯一的适配点：
// - `/web/workflow-v2/*` 是本平台信封 `{ success, data }`，`request()` 已解掉一层，失败**返回**
//   `{ success: false }` 而不 throw（§5.2），调用方必须 `unwrap()` 或显式判 `success`；
// - `/workflow-canvas/bff/session/*` 是 **上游信封** `{ code, msg, data }`（画布 SDK 依赖该形状，服务端刻意
//   不包装，冻结 §6）：它没有 `success` 字段，`request()` 于是走「`data` 在就解出 `data`」那条分支，
//   调用方拿到的同样是业务体本身；失败仍是真实 HTTP 状态码（票据失败必须是 401，冻结 §7）。
//
// 票据只经请求头 `X-Fenix-Workflow-Ticket` 传递，**绝不入 URL / storage / 日志**（设计 §5.3）：
// 本文件不打印任何请求内容，错误文案由 UI 按稳定 error code 取字典。
//
// 身份（user / org）不在本层拼装：组织谓词由服务端从会话 cookie 推导（§5.1「请求基建不做组织头注入」）。

import { type ApiResponse, request } from "@fenix/web-runtime/api/request";

/**
 * 画布票据的请求头名（冻结 §7）。
 *
 * 画布侧只认这个名字（`bot-http/src/host-bridge.ts` 的 `TICKET_HEADER_NAME`），改名必须两侧同步。
 */
export const CANVAS_TICKET_HEADER = "X-Fenix-Workflow-Ticket";

/**
 * 画布 iframe 的 API 基址（冻结 §7）：既写进 iframe URL 的 `apiBase` 参数（首屏请求就能直达 BFF），
 * 也写进 `token` 消息载荷（画布后续以它为准）。
 */
export const CANVAS_API_BASE = "/workflow-canvas/bff";

/**
 * 会话端点的单请求超时（ms）。
 *
 * 画布侧等待宿主换票的上限是 10s（`host-bridge.ts` 的 `TOKEN_WAIT_TIMEOUT_MS`，冻结 §7 明示「宿主换票
 * 慢时应由宿主侧缩短链路，而非放宽画布超时」），因此宿主的单个请求必须显著快于它——超时即判失败、
 * 立刻走降级分支，把剩余时间留给 UI 提示，而不是让画布先超时。
 */
export const CANVAS_SESSION_TIMEOUT_MS = 8_000;

/** 可取消调用的选项；宿主页在卸载/重试时 abort 在途请求（§3.4「主动取消用 signal」）。 */
export interface CanvasRequestOptions {
  readonly signal?: AbortSignal;
}

/** `GET /web/workflow-v2/org-app` 的视图（设计 §4.3）：租户 ↔ 上游应用 的绑定状态。 */
export interface WorkflowV2OrgAppBinding {
  /** 绑定的上游应用 ID（服务端注入 `project_id` 的来源）；未绑定时为 null。 */
  readonly appId: string | null;
  /** `active`=绑定可用；`degraded`=上游已明确目标 App 不可用；`unbound`=尚未绑定。 */
  readonly status: "active" | "degraded" | "unbound";
}

/**
 * `GET /web/workflow-v2/platform-account` 中本页消费的部分（设计 §4.3/§4.5）。
 *
 * 只声明用到的两个字段，不复制整份响应：画布 URL 的 `space_id` 是**平台个人空间**（`workflow_v2_platform_account`
 * 行），不是 workflow 记录里的字段，也不是租户 App ID。
 */
export interface WorkflowV2PlatformAccount {
  /** 上游个人空间 ID；取自服务端台账，**尚未引导账号**（台账无行）时为 null。 */
  readonly spaceId: string | null;
  /** `active`=进程持有可用会话；`degraded`=需要重登或上游不可用。 */
  readonly status: "active" | "degraded";
}

/** 一次性 code（`POST /web/workflow-v2/iframe-code`）：60s、单次消费、绑定 user + org + workflow。 */
export interface CanvasIframeCode {
  readonly code: string;
  /** 有效期（秒）。 */
  readonly expiresIn: number;
}

/** 画布票据（`session/exchange` 与 `session/refresh` 的业务体）。 */
export interface CanvasTicket {
  readonly ticket: string;
  /** 过期时间（epoch 毫秒），原样下发给画布。 */
  readonly expiresAt: number;
}

/** 读取当前组织的上游应用 绑定（未绑定时 `appId` 为 null、`status` 为 `unbound`）。 */
export function fetchOrgAppBinding(options: CanvasRequestOptions = {}): Promise<ApiResponse<WorkflowV2OrgAppBinding>> {
  return request<WorkflowV2OrgAppBinding>("/web/workflow-v2/org-app", { method: "GET", signal: options.signal });
}

/**
 * 初始化并绑定当前组织的工作流空间（`POST /web/workflow-v2/org-app`）。
 *
 * **一键、无入参**：请求体为空，工作空间的展示名由服务端取当前**组织名称**（名称为空时服务端回退默认名）
 * ——客户端提交名称一律无效，本函数也不提供该入参：名称是用户可见文本，不该由请求体决定，用户也不需要为它
 * 做任何决定（上游以 ID 为准，重名不敏感）。
 *
 * **幂等**：已绑定时服务端直接返回既有的 `appId`、不重复建 App（`ensureOrgApp`），因此「初始化」按钮重复
 * 提交不会造出第二个空间；首次调用会顺带完成平台账号引导（登录并落库账号身份），所以调用可能比普通写操作慢。
 *
 * 失败码全部是稳定枚举（`UNAUTHENTICATED` / `INTERNAL_ERROR` / `PLATFORM_SESSION_UNAVAILABLE` /
 * `UPSTREAM_UNAVAILABLE` / `UPSTREAM_REJECTED`），文案由 UI 按码取字典（§9.3），
 * **不回显服务端 message**。权限上只要求已认证会话：任意成员都能初始化，这不是管理员动作。
 */
export function createOrgApp(options: CanvasRequestOptions = {}): Promise<ApiResponse<{ appId: string }>> {
  return request<{ appId: string }>("/web/workflow-v2/org-app", {
    method: "POST",
    signal: options.signal,
  });
}

/** 读取平台上游账号状态（只读本地，不触发上游请求；`spaceId` 为画布 URL 的 `space_id` 来源）。 */
export function fetchPlatformAccount(
  options: CanvasRequestOptions = {},
): Promise<ApiResponse<WorkflowV2PlatformAccount>> {
  return request<WorkflowV2PlatformAccount>("/web/workflow-v2/platform-account", {
    method: "GET",
    signal: options.signal,
  });
}

/**
 * 签发一次性 code（控制台会话鉴权）。
 *
 * `workflowId` 是 **上游 workflow ID**：它与票据 `claims.wf`、透传请求里的显式 `workflow_id` 逐字一致，
 * 也是画布 URL 的 `workflow_id` 参数（冻结 §7）。
 */
export function issueCanvasCode(
  workflowId: string,
  options: CanvasRequestOptions = {},
): Promise<ApiResponse<CanvasIframeCode>> {
  return request<CanvasIframeCode>("/web/workflow-v2/iframe-code", {
    method: "POST",
    body: { workflowId },
    signal: options.signal,
  });
}

/** 兑换票据（`POST /workflow-canvas/bff/session/exchange`）：免票端点，code 单次消费。 */
export function exchangeCanvasTicket(
  code: string,
  options: CanvasRequestOptions = {},
): Promise<ApiResponse<CanvasTicket>> {
  return request<CanvasTicket>(`${CANVAS_API_BASE}/session/exchange`, {
    method: "POST",
    body: { code },
    timeout: CANVAS_SESSION_TIMEOUT_MS,
    signal: options.signal,
  });
}

/** 续期票据（带票据头）；新票过期时间取「原 exp 与 现在 + TTL」的较小者，续期只能缩短会话。 */
export function refreshCanvasTicket(
  ticket: string,
  options: CanvasRequestOptions = {},
): Promise<ApiResponse<CanvasTicket>> {
  return request<CanvasTicket>(`${CANVAS_API_BASE}/session/refresh`, {
    method: "POST",
    headers: { [CANVAS_TICKET_HEADER]: ticket },
    timeout: CANVAS_SESSION_TIMEOUT_MS,
    signal: options.signal,
  });
}

/** 撤销票据族（带票据头）：登出、切组织与离开画布页时调用，撤销后再出示同一票据返回 401。 */
export function revokeCanvasTicket(ticket: string): Promise<ApiResponse<{ revoked: boolean }>> {
  return request<{ revoked: boolean }>(`${CANVAS_API_BASE}/session/revoke`, {
    method: "POST",
    headers: { [CANVAS_TICKET_HEADER]: ticket },
    timeout: CANVAS_SESSION_TIMEOUT_MS,
  });
}
