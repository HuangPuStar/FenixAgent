/**
 * 画布透传面的业务实现（`/workflow-canvas/bff/*`，冻结 §6/§7）。
 *
 * 本面是画布的唯一 API 出口，也是**租户隔离的唯一权威**：上游只校验「平台账号属于该 space」
 * （`checkUserSpace`），既不校验 workflow ↔ App 归属，creator 也永远是同一个平台账号（设计 §1.4）。因此每次
 * 透传都必须先过「票据 → 显式 workflow 身份 → 本地注册表」三道门，之后才谈转发。路由
 * （`routes/canvas/bff.ts`）只做协议适配：读请求头/查询串/请求体，把结果交给 HTTP 层。
 *
 * 失败形状（画布侧依赖它决定是否换票，冻结 §7）：
 * - 票据缺失或验签失败 → **真实 HTTP 401** + `{code:401,msg:"ticket_invalid"}`。画布只在
 *   `error.response.status === 401` 时触发换票，若改成 `HTTP 200 + code:401` 会落进业务错误分支，永不换票；
 * - 归属不符（显式 workflow 身份与票据不一致、或注册表未命中）→ **404**，与「不存在」同形，不泄漏存在性；
 * - 白名单外路径 → 404；上游侧失败按语义映射（超时 504、网络 502、会话不可用 503、未预期 500）。
 *
 * 成功面**原样回传** 上游的 `{data,code,msg}` 与 HTTP 状态：画布 SDK 依赖该形状（`list_spans` 是裸对象、
 * `sign_image_url` 的 `url` 在顶层、`update_meta`/`cancel` 没有 `data`），任何「统一包一层」都会打断解析。
 * 唯一的两处主动改写是安全必需的：上游 panic 的 `msg` 脱敏（含 Go 堆栈）与节点白名单过滤（冻结 §5/§6）；
 * 另有一处只对 `get_process` 的窗口复用（见「调试运行的轮询预算」一节），回放的同样是一次真实上游响应。
 *
 * 依赖方向：本文件是路由的下游，只用 `callUpstream`（会话注入与鉴权重放由它负责，这里不碰 Cookie）、
 * `iframe-ticket`（票据）、`workflow-registry`（归属）与 `tenant-binding-repository`（注入值来源）。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";
import { findTenantBinding, type TenantBindingSnapshot } from "../repositories/tenant-binding-repository";
import { redeemCode, refreshTicket, revokeSession, verifyTicket } from "./iframe-ticket";
import { filterNodePayload } from "./node-scope";
import { createTokenBucketLimiter, policyPerMinute, type TokenBucketPolicy } from "./rate-limit";
import { callUpstream, UPSTREAM_PANIC_CODE, UpstreamRequestError } from "./upstream-client";
import { UpstreamSessionUnavailableError } from "./upstream-session";
import { findWorkflowByUpstreamId } from "./workflow-registry";

const logger = createLogger("wf-v2-canvas-bff");

/** 画布票据的请求头名（冻结 §7；两侧必须逐字一致，否则静默失效）。 */
export const CANVAS_TICKET_HEADER = "x-fenix-workflow-ticket";

/**
 * 画布面的响应：上游信封 `{code,msg,data?}` + HTTP 状态；透传成功时状态原样沿用上游。
 *
 * `retryAfterSeconds` 只在 429 上出现，由路由层写成 `Retry-After` 响应头（见 `routes/canvas/bff.ts`）。
 */
export interface CanvasBffResult {
  readonly status: number;
  readonly body: unknown;
  readonly retryAfterSeconds?: number;
}

// ── 透传白名单与字段口径 ──

/** 允许透传的上游路径前缀（冻结 §6 的三条）：其余一律 404。 */
const WORKFLOW_API_PREFIX = "/api/workflow_api/";
const UPLOAD_PREFIX = "/api/common/upload/";
const IMAGEX_URL_PATH = "/api/playground_api/get_imagex_url";

/**
 * 客户端不得自报的字段（冻结 §6 的注入白名单）：空间、租户 App 与身份相关字段，一律先剥离。
 *
 * 其中只有 `space_id` / `project_id` 会被写入权威值（租户绑定快照）。本模块使用 App 执行上下文；
 * `bot_id` 表示 Agent 执行上下文，与 `project_id` 互斥，因此只剥离、不注入。`owner_id` /
 * `login_user_create` / `creator` / `operator` 在本层**没有可注入的权威值**：上游按会话 cookie 判定调用者
 * 身份（请求结构里也确实没有 `creator`/`operator`，`owner_id` 只在 `list_publish_workflow` 里作可选过滤），
 * 写入我方的用户 ID 等于向上游声明一个不存在的身份。剥离已经满足「客户端伪造无效」的目标。
 */
const CLIENT_SUPPLIED_FIELDS: ReadonlySet<string> = new Set([
  "space_id",
  "project_id",
  "bot_id",
  "owner_id",
  "login_user_create",
  "creator",
  "operator",
]);

/**
 * 请求里可能出现的 workflow 身份字段（上游的字段口径）：`workflow_id`（单数，绝大多数端点）、
 * `workflow_ids`（按 id 批量查）、`workflow_id_list`（批量删除）。
 * `exclude_workflow_id` 这类**排除**字段不在此列：它只能缩小结果集，不能扩大可达范围。
 */
const WORKFLOW_ID_FIELDS = ["workflow_id", "workflow_ids", "workflow_id_list"] as const;

/** 需要按节点白名单裁剪响应的端点（冻结 §5；判定与实现都在 `node-scope`）。 */
const NODE_SCOPE_PATHS: ReadonlySet<string> = new Set([
  "/api/workflow_api/node_type",
  "/api/workflow_api/node_template_list",
  "/api/workflow_api/node_panel_search",
]);

/** 返回存储直链的端点（冻结 §6.1）：只在这两条上改写 URL，避免误伤其它响应里的同形字段。 */
const IMAGE_URL_PATHS: ReadonlySet<string> = new Set(["/api/workflow_api/sign_image_url", IMAGEX_URL_PATH]);

// ── 请求体上界与超时 ──

/** JSON 请求体上界：画布 `save` 的 `schema` 随节点数增长，正常图在数百 KB 量级，8 MiB 是留足余量的硬顶。 */
const MAX_JSON_BODY_BYTES = 8 * 1024 * 1024;
/** 上传路径的请求体上界：显式放大，但仍必须有界（不随上游要求无限放开）。 */
const UPLOAD_MAX_BODY_BYTES = 32 * 1024 * 1024;
/** 上传路径的上游超时：显式长于 `upstreamTimeoutMs`（上传与图片签名链路慢于普通读接口）。 */
const UPLOAD_TIMEOUT_MS = 60_000;

// ── 固定文案 ──

const MSG_SUCCESS = "success";
const MSG_TICKET_INVALID = "ticket_invalid";
const MSG_NOT_FOUND = "not_found";
const MSG_INVALID_CODE = "invalid_code";
const MSG_TOO_MANY_ATTEMPTS = "too_many_attempts";
const MSG_PAYLOAD_TOO_LARGE = "payload_too_large";
const MSG_UNSUPPORTED_BODY = "unsupported_body";
const MSG_TENANT_NOT_BOUND = "tenant_not_bound";
const MSG_UPSTREAM_TIMEOUT = "upstream_timeout";
const MSG_UPSTREAM_UNAVAILABLE = "upstream_unavailable";
const MSG_UPSTREAM_SESSION_UNAVAILABLE = "upstream_session_unavailable";
const MSG_INTERNAL_ERROR = "internal_error";
/** 上游 panic 的固定替代文案：原始 `msg` 带 Go 堆栈与绝对路径，只准进服务端日志（冻结 §6）。 */
const MSG_UPSTREAM_REJECTED = "upstream rejected the request";
/** 非 JSON 上游响应的固定替代文案（原文只进日志）。 */
const MSG_UPSTREAM_ERROR = "upstream_error";

/** 日志里保留的上游原文长度上界：足够定位形态，又不至于把整份堆栈写进日志。 */
const LOG_TEXT_LIMIT = 500;

// ── 信封构造 ──

function success(data: unknown): CanvasBffResult {
  return { status: 200, body: { code: 0, msg: MSG_SUCCESS, data } };
}

function failure(status: number, msg: string, code = status): CanvasBffResult {
  return { status, body: { code, msg } };
}

/**
 * 429 固定回应：`Retry-After` 由调用方（路由层）写成响应头。
 *
 * **429 不是 401**：画布只在 401 时换票（冻结 §7），429 落进它的普通失败分支——这正是我们要的，限流
 * 绝不能被误判成「票据失效」。文案沿用既有 `too_many_attempts`，不新增第二套措辞。
 */
const tooManyRequests = (retryAfterSeconds: number): CanvasBffResult => ({
  ...failure(429, MSG_TOO_MANY_ATTEMPTS),
  retryAfterSeconds,
});

const ticketInvalid = (): CanvasBffResult => failure(401, MSG_TICKET_INVALID);
const notFound = (): CanvasBffResult => failure(404, MSG_NOT_FOUND);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 按 `Content-Type` 与解析结果判定请求体是否可经 `callUpstream` 转发。
 *
 * `callUpstream` 只发 JSON（`JSON.stringify`），因此 ArrayBuffer / Blob / FormData 形态的请求体（
 * `POST /api/common/upload/*tos_uri` 的裸字节上传腿）透传不了：JSON 序列化会把字节变成对象字面量，
 * 静默损坏上传内容比显式拒绝更糟。这一条属已知缺口，解除条件是 `callUpstream` 支持原样透传请求体。
 */
function isForwardableBody(body: unknown): boolean {
  return body === undefined || isRecord(body);
}

// ── 路径与字段 ──

/**
 * 按需放行的**只读元数据端点**：画布首屏会调、且不在这三条前缀里的上游端点。
 *
 * 来源与用途（2026-09-30 实测，直连上游对照）：`/api/bot/get_type_list`（节点/类型清单）、
 * `/api/memory/variable/get_meta`（变量元数据）、`/api/passport/account/info/v2/`（账号信息）。
 * 三条在直连上游时回 200，经本面因不在白名单里被 fail-closed 挡成 404。
 *
 * **为什么必须精确匹配**：这三条是枚举出来的具体端点而不是命名空间；按前缀放行 `/api/passport/`、
 * `/api/memory/`、`/api/bot/` 等于把上游三个完整命名空间交给画布，远超「让画布首屏可用」所需。
 * 要素：全等路径 + 仅 POST。移除条件：上游把它们并进 `/api/workflow_api/`，或画布不再需要。
 */
const READ_ONLY_METADATA_PATHS: ReadonlySet<string> = new Set([
  "/api/bot/get_type_list",
  "/api/memory/variable/get_meta",
  "/api/passport/account/info/v2/",
]);

/** 透传面允许的上游路径分类；返回 null 表示该路径不在白名单内（调用方回 404）。 */
type CanvasPassthroughKind = "workflow_api" | "upload" | "imagex_url" | "metadata";

/** 判定上游路径是否在透传白名单内（末尾多出空段的 `/api/workflow_api/` 不算端点）。 */
export function classifyUpstreamPath(path: string): CanvasPassthroughKind | null {
  if (path.startsWith(WORKFLOW_API_PREFIX) && path.length > WORKFLOW_API_PREFIX.length) return "workflow_api";
  if (path.startsWith(UPLOAD_PREFIX) && path.length > UPLOAD_PREFIX.length) return "upload";
  if (path === IMAGEX_URL_PATH) return "imagex_url";
  if (READ_ONLY_METADATA_PATHS.has(path)) return "metadata";
  return null;
}

/** 请求显式声明的 workflow 身份是否与票据一致；未声明任何身份字段时返回 true（此时只有票据的 `wf` 参与校验）。 */
function declaredWorkflowMatches(body: unknown, query: Record<string, string>, workflowId: string): boolean {
  // 形态不受支持（数字、对象等）时按不一致处理：fail-closed，宁可 404 也不让上游见到未经校验的身份。
  const matches = (value: unknown): boolean =>
    typeof value === "string"
      ? value === workflowId
      : Array.isArray(value)
        ? value.every((item) => item === workflowId)
        : false;
  if (isRecord(body)) {
    for (const field of WORKFLOW_ID_FIELDS) if (field in body && !matches(body[field])) return false;
  }
  for (const field of WORKFLOW_ID_FIELDS) if (field in query && !matches(query[field])) return false;
  return true;
}

/** 剥离客户端自报字段后的请求体副本（不修改入参），并写入服务端权威值。 */
function buildUpstreamBody(body: unknown, binding: TenantBindingSnapshot): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  if (isRecord(body)) {
    for (const [key, value] of Object.entries(body)) if (!CLIENT_SUPPLIED_FIELDS.has(key)) next[key] = value;
  }
  next.space_id = binding.platformSpaceId;
  next.project_id = binding.appId;
  return next;
}

/**
 * 剥离客户端自报字段后的查询串副本，并补上 GET 面的 `space_id`。
 *
 * GET 端点（`get_process` / `get_node_execute_history`）把 `space_id` 绑在查询串上（IDL 的
 * `GetWorkflowProcessRequest.space_id` 为必填），客户端同名字段已被剥离，不补就是缺参。`project_id` /
 * `bot_id` 在 GET 面没有消费者，不注入以免凭空多出参数。
 */
function buildUpstreamQuery(
  query: Record<string, string>,
  binding: TenantBindingSnapshot,
  method: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) if (!CLIENT_SUPPLIED_FIELDS.has(key)) next[key] = value;
  if (method === "GET") next.space_id = binding.platformSpaceId;
  return next;
}

// ── 响应后处理 ──

/** 上游 panic 信封判定（`HTTP 200 + code 777777775`，`msg` 含 Go 堆栈）。 */
function isPanicEnvelope(body: unknown): boolean {
  return isRecord(body) && body.code === UPSTREAM_PANIC_CODE;
}

/**
 * 非 JSON 上游响应降级为固定文案。
 *
 * 上游的纯文本响应只有 Go panic 兜底一种已知形态（`HTTP 500 + code=777777775 message=…Go 堆栈…`，
 * 契约快照 §2.1 F5），而堆栈里带内部函数名与绝对路径。因此**任何**非 JSON 响应都不原样回传：命中 panic
 * 码的按 panic 文案，其余按通用文案；原文只进服务端日志。这是对冻结 §6「panic 脱敏」的同向加固。
 */
function recoverTextResponse(text: string, status: number, path: string): unknown {
  logger.warn("上游返回非 JSON 响应，已替换为固定文案", { path, status, upstream: text.slice(0, LOG_TEXT_LIMIT) });
  return text.includes(String(UPSTREAM_PANIC_CODE))
    ? { code: UPSTREAM_PANIC_CODE, msg: MSG_UPSTREAM_REJECTED }
    : { code: status >= 400 ? status : 502, msg: MSG_UPSTREAM_ERROR };
}

/** 存储直链的路径锚点：上游默认存储桶（部署模板 `STORAGE_BUCKET=opencoze`）。 */
const STORAGE_PATH_PREFIX = "/opencoze/";
/** 存储域的同源反代前缀（冻结 §6.1；`/workflow-canvas/storage/*` 由静态反代映射到存储服务）。 */
const STORAGE_PROXY_PREFIX = "/workflow-canvas/storage";

/**
 * 存储直链 → 同源反代路径；不属于已知存储直链时返回 null（保持原值）。
 *
 * 为什么必须改写：上游返回的是存储服务（MinIO）的预签名**内网直链**（实测 `http://127.0.0.1:9000/opencoze/…`），
 * host 不是上游自身，浏览器经 `/workflow-canvas/*` 无法到达；不改写则画布内图片一律加载失败（冻结 §6.1）。
 * 为什么只认固定前缀：只处理「origin 不是上游自身」且路径落在已知存储桶下的 URL，不按 host 泛化、不用
 * 正则，避免把响应里其它形态的 URL 改坏。查询串原样保留（`X-Amz-*` 是签名材料，丢掉就取不到对象）。
 * 移除条件：上游能配置对外存储域（或本包拿到存储基址配置）时整段删除，回到纯透传。
 */
function toStorageProxyUrl(value: unknown, upstreamOrigin: string): string | null {
  if (typeof value !== "string") return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.origin === upstreamOrigin || !parsed.pathname.startsWith(STORAGE_PATH_PREFIX)) return null;
  return `${STORAGE_PROXY_PREFIX}${parsed.pathname}${parsed.search}`;
}

/** 图片端点的 URL 字段改写：`sign_image_url` 的 `url` 在顶层，`get_imagex_url` 在 `data.url_info[].url`。 */
function rewriteStorageUrls(body: unknown, path: string, upstreamOrigin: string): unknown {
  if (!IMAGE_URL_PATHS.has(path)) return body;
  const root = body;
  if (!isRecord(root)) return body;

  if (path === IMAGEX_URL_PATH) {
    const data = root.data;
    const urlInfo = isRecord(data) ? data.url_info : null;
    if (!isRecord(urlInfo)) return body;
    let changed = false;
    const nextUrlInfo: Record<string, unknown> = {};
    for (const [uri, entry] of Object.entries(urlInfo)) {
      const rewritten = isRecord(entry) ? toStorageProxyUrl(entry.url, upstreamOrigin) : null;
      if (!isRecord(entry) || rewritten === null) {
        nextUrlInfo[uri] = entry;
        continue;
      }
      nextUrlInfo[uri] = { ...entry, url: rewritten };
      changed = true;
    }
    return changed ? { ...root, data: { ...(data as Record<string, unknown>), url_info: nextUrlInfo } } : body;
  }

  const rewritten = toStorageProxyUrl(root.url, upstreamOrigin);
  return rewritten === null ? body : { ...root, url: rewritten };
}

/**
 * 回传前的响应后处理：panic 脱敏 → 节点白名单裁剪 → 存储直链改写。
 *
 * 顺序不影响结果（三步各自认形状，互不重叠），但脱敏必须在最前：panic 信封只剩 `{code,msg}`，后两步对
 * 它天然无操作，不会把上游堆栈漏回浏览器。
 */
function postProcessResponse(body: unknown, path: string): unknown {
  if (typeof body === "string") return recoverTextResponse(body, 500, path);
  if (isPanicEnvelope(body)) {
    logger.warn("上游 panic，已剥离原始 msg", {
      path,
      upstream:
        typeof (body as { msg?: unknown }).msg === "string"
          ? (body as { msg: string }).msg.slice(0, LOG_TEXT_LIMIT)
          : undefined,
    });
    return { code: UPSTREAM_PANIC_CODE, msg: MSG_UPSTREAM_REJECTED };
  }
  const scoped = NODE_SCOPE_PATHS.has(path) ? filterNodePayload(body, path) : body;
  return rewriteStorageUrls(scoped, path, upstreamOriginOf());
}

/** 上游基址的 origin：判定存储直链时排除上游自身的 URL。 */
function upstreamOriginOf(): string {
  try {
    return new URL(getWorkflowV2Config().upstreamBaseUrl).origin;
  } catch {
    return "";
  }
}

// ── 透传主路径 ──

export interface CanvasPassthroughInput {
  /** 请求方法；只有 GET/POST 会被转发（上游的两个面都只注册这两种）。 */
  readonly method: string;
  /** 已归一的上游路径（`/api/...`）。 */
  readonly path: string;
  /** 查询串（已解析为标量映射）。 */
  readonly query: Record<string, string>;
  /** 票据头值；缺失为 null。 */
  readonly ticket: string | null;
  /** 解析后的请求体；无请求体为 undefined。 */
  readonly body: unknown;
  /** 入站 `Content-Length`；无该头为 null。 */
  readonly contentLength: number | null;
}

/** 上游调用失败 → 画布面的错误分支；不透传上游错误文案（可能含内网地址与实现细节）。 */
function mapUpstreamFailure(error: unknown, path: string): CanvasBffResult {
  if (error instanceof UpstreamSessionUnavailableError) {
    logger.error("上游会话不可用，画布请求无法转发", { path });
    return failure(503, MSG_UPSTREAM_SESSION_UNAVAILABLE);
  }
  if (error instanceof UpstreamRequestError) {
    if (error.code === "UPSTREAM_INVALID_PATH") return notFound();
    if (error.code === "UPSTREAM_TIMEOUT") {
      logger.warn("上游超时", { path });
      return failure(504, MSG_UPSTREAM_TIMEOUT);
    }
    logger.error("上游请求失败", { path, reason: error.message });
    return failure(502, MSG_UPSTREAM_UNAVAILABLE);
  }
  // 未预期失败（本地依赖异常等）：保留诊断信息在日志里，对外只给固定文案。
  logger.error("画布透传未预期失败", { path, reason: error instanceof Error ? error.message : typeof error });
  return failure(500, MSG_INTERNAL_ERROR);
}

// ── 调试运行的轮询预算（get_process） ──

/**
 * 调试运行的状态查询端点：唯一参与预算的路径。契约快照 §2 第 16 行与 A8 表明它只挂 `GET`、
 * `execute_id` 在查询串上，而画布整个调试运行都靠它以 300ms 无上限递归轮询（`LOOP_GAP_TIME`）。
 */
const GET_PROCESS_PATH = "/api/workflow_api/get_process";

/**
 * 回放窗口：与画布轮询间隔同量级，回放的状态因此最多滞后一个轮询周期，用户不可感知。
 *
 * 为什么是合并而不是限流：画布把调试运行期间任何非成功响应当作运行失败（`systemError` 并终止轮询），
 * 429 会让用户的调试凭空失败；复用同一次成功响应不改变任何一次调用的语义，是唯一安全的省请求手段。
 */
export const GET_PROCESS_CACHE_TTL_MS = 300;

/** 条目上限：窗口只有 300ms，条目数正常收敛在「活跃调试运行数」，上限只为洪峰下的内存兜底。 */
const GET_PROCESS_CACHE_MAX_ENTRIES = 256;

interface ProcessCacheEntry {
  readonly expiresAtMs: number;
  readonly result: CanvasBffResult;
}

/** 窗口内的成功响应；`processInFlight` 不需要上限——条目随各自的 Promise 落定即删，不跨请求累积。 */
let processCache = new Map<string, ProcessCacheEntry>();
let processInFlight = new Map<string, Promise<CanvasBffResult>>();

/**
 * 缓存键是「组织 + `execute_id`」：`execute_id` 已是运行级唯一标识，跨组织必须隔离（平台第一安全约束）。
 *
 * 不把 `workflow_id` 拼进键：上游本就不校验 workflow ↔ 运行归属（冻结 §1.4），命中与否都不改变本组织
 * 的可达集合，多一段只会让同一次运行的请求因字段有无而分裂成多个键。
 */
function getProcessCacheKey(organizationId: string, executeId: string): string {
  return `${organizationId}\u0000${executeId}`;
}

/** 只缓存成功响应：把非 2xx 或 `code !== 0` 写进去，等于把一次瞬时失败放大成一段时间内的稳定失败。 */
function isCacheableProcessResult(result: CanvasBffResult): boolean {
  return result.status >= 200 && result.status < 300 && isRecord(result.body) && result.body.code === 0;
}

/** 读窗口内的成功响应；过期条目就地回收，读路径即清扫路径。 */
function readProcessCache(key: string, nowMs: number): CanvasBffResult | null {
  const entry = processCache.get(key);
  if (entry === undefined) return null;
  if (entry.expiresAtMs <= nowMs) {
    processCache.delete(key);
    return null;
  }
  return entry.result;
}

function writeProcessCache(key: string, result: CanvasBffResult, nowMs: number): void {
  if (processCache.size >= GET_PROCESS_CACHE_MAX_ENTRIES) {
    for (const [candidate, entry] of processCache) if (entry.expiresAtMs <= nowMs) processCache.delete(candidate);
    // 扫完仍满：按插入顺序淘汰最旧的（Map 迭代序即插入序）。
    while (processCache.size >= GET_PROCESS_CACHE_MAX_ENTRIES) {
      const oldest = processCache.keys().next();
      if (oldest.done === true) break;
      processCache.delete(oldest.value);
    }
  }
  processCache.set(key, { expiresAtMs: nowMs + GET_PROCESS_CACHE_TTL_MS, result });
}

/**
 * 走一次预算内的上游调用：窗口内直接回放；同键在飞行时后来者共享同一个 Promise，不重复打上游。
 *
 * 共享失败结果也是安全的：在飞行期间到达的调用本来就拿不到更新的状态，共享只是避免把同一时刻的
 * 上游故障按并发数放大；失败一律不落缓存，窗口外的下一次调用照常重新打上游。
 */
function withGetProcessBudget(key: string, run: () => Promise<CanvasBffResult>): Promise<CanvasBffResult> {
  const cached = readProcessCache(key, Date.now());
  if (cached !== null) return Promise.resolve(cached);
  const inFlight = processInFlight.get(key);
  if (inFlight !== undefined) return inFlight;

  const attempt = run()
    .then((result) => {
      if (isCacheableProcessResult(result)) writeProcessCache(key, result, Date.now());
      return result;
    })
    .finally(() => {
      processInFlight.delete(key);
    });
  processInFlight.set(key, attempt);
  return attempt;
}

/** 只有 `GET get_process` 且查询串里的 `execute_id` 是非空字符串才参与预算；其余形态一律保持原始透传。 */
function readProcessExecuteId(input: CanvasPassthroughInput): string | null {
  if (input.path !== GET_PROCESS_PATH || input.method !== "GET") return null;
  const executeId = input.query.execute_id;
  return typeof executeId === "string" && executeId.length > 0 ? executeId : null;
}

/** 清空轮询预算的进程内状态；**只供测试**从零计数（生产没有「清空缓存」的场景）。 */
export function resetGetProcessBudget(): void {
  processCache = new Map();
  processInFlight = new Map();
}

/**
 * 处理一次透传请求：白名单 → 票据 → 显式身份 → 本地注册表 → 租户绑定 → 注入 → 上游 → 后处理。
 *
 * 校验顺序即拒绝顺序：先做零成本的本地判定（路径、票据、显式身份），再落到注册表与绑定查询，最后才发
 * 上游请求——未通过任一道门的请求都不会触碰上游，也不会因为「上游先看到」而泄漏存在性。
 */
export async function handleCanvasPassthrough(input: CanvasPassthroughInput): Promise<CanvasBffResult> {
  const kind = classifyUpstreamPath(input.path);
  if (kind === null || (input.method !== "GET" && input.method !== "POST")) return notFound();
  // 提取成常量：闭包（`forward`）里再引用 `input.method` 会丢掉上面这行带来的 `GET | POST` 窄化。
  const method = input.method;
  // 只读元数据端点只接受 POST（客户端实际用法）：路径放行不等于方法放行。
  if (kind === "metadata" && method !== "POST") return notFound();
  if (!isForwardableBody(input.body)) return failure(501, MSG_UNSUPPORTED_BODY);

  const claims = input.ticket === null ? null : verifyTicket(input.ticket);
  if (claims === null) return ticketInvalid();

  // 限流（4B）紧跟票据门：受保护的资源（本地注册表、租户绑定与上游）都在后面，越早拒绝越省资源；只有验过
  // 票的请求才按 `sub` 计数。票据无效的请求**不设**来源桶：反代之后所有用户共享同一个入口地址，一个脚本
  // 刷 401 就能把来源桶打满并连带拒绝正常用户（自伤），而伪造票据在 HMAC 下不可行，401 路径本身也很便宜。
  const limited = acquire(`bff:sub:${claims.sub}`, rateLimitPolicies().bff);
  if (limited !== null) return limited;

  const bodyLimit = kind === "upload" ? UPLOAD_MAX_BODY_BYTES : MAX_JSON_BODY_BYTES;
  if (input.contentLength !== null && input.contentLength > bodyLimit) return failure(413, MSG_PAYLOAD_TOO_LARGE);
  if (!declaredWorkflowMatches(input.body, input.query, claims.wf)) return notFound();

  try {
    const record = await findWorkflowByUpstreamId(claims.org, claims.wf);
    if (!record) return notFound();

    const binding = await findTenantBinding(claims.org);
    if (!binding) return failure(503, MSG_TENANT_NOT_BOUND);

    const upstreamBody = method === "POST" ? buildUpstreamBody(input.body, binding) : undefined;
    if (upstreamBody !== undefined && JSON.stringify(upstreamBody).length > bodyLimit)
      return failure(413, MSG_PAYLOAD_TOO_LARGE);

    const forward = async (): Promise<CanvasBffResult> => {
      const result = await callUpstream({
        path: input.path,
        method,
        query: buildUpstreamQuery(input.query, binding, method),
        body: upstreamBody,
        timeoutMs: kind === "upload" ? UPLOAD_TIMEOUT_MS : undefined,
      });
      return { status: result.status, body: postProcessResponse(result.body, input.path) };
    };

    // 预算在全部校验之后才生效：缓存不得成为绕过票据/归属门或租户绑定的旁路。
    const executeId = readProcessExecuteId(input);
    if (executeId === null) return await forward();
    return await withGetProcessBudget(getProcessCacheKey(claims.org, executeId), forward);
  } catch (error) {
    return mapUpstreamFailure(error, input.path);
  }
}

// ── 会话端点（冻结 §7） ──

/**
 * 限流（4B）：画布面与票据端点共用一个进程内令牌桶限流器（`services/rate-limit.ts` 里写明维度选择与取舍）。
 *
 * 维度：
 * - 画布透传与续期/撤销：**票据 `sub`**（鉴权后的稳定主体）。按来源地址会误伤反代后共享同一入口 IP 的
 *   正常用户，按 `jti` 又可以被重新换票绕过；
 * - 兑换（免票）与票据无效的续期/撤销：**来源地址**——那里没有 `sub` 可用（这正是它们要拿票的原因），
 *   阈值取「正常画布打开远达不到」的量级（默认 60/分钟），真正的边缘限流归部署层。
 *
 * 阈值取模块配置（`bffRateLimitPerMinute` / `sessionRateLimitPerMinute`，env 可调）。每次拒绝**不写日志**：
 * 洪峰下日志本身会变成放大面，429 响应（带 `Retry-After`）已是可观测信号。
 */
const rateLimiter = createTokenBucketLimiter();

/** 清空限流桶；**只供测试**从零计数（生产没有「重置限流」的场景）。 */
export function resetRateLimitBuckets(): void {
  rateLimiter.reset();
}

/** 读限流阈值（每次调用现读，阈值改配后无需重启即可生效于新请求）。 */
function rateLimitPolicies(): { bff: TokenBucketPolicy; session: TokenBucketPolicy } {
  const config = getWorkflowV2Config();
  return {
    bff: policyPerMinute(config.bffRateLimitPerMinute),
    session: policyPerMinute(config.sessionRateLimitPerMinute),
  };
}

/** 取一个令牌；`key` 由调用方按维度拼好（见上面的维度说明）。 */
function acquire(key: string, policy: TokenBucketPolicy): CanvasBffResult | null {
  const decision = rateLimiter.tryAcquire(key, policy, Date.now());
  return decision.allowed ? null : tooManyRequests(decision.retryAfterSeconds);
}

/**
 * 兑换一次性 code（`POST /session/exchange`）：这就是拿票的地方，因此**不要求**票据鉴权，只用限流挡刷量。
 * code 未知、已用、过期一律同形返回 400 `invalid_code`，不给「code 是否存在」的探测面。
 */
export function handleSessionExchange(input: { code: unknown; peerKey: string }): CanvasBffResult {
  // 限流先于一切判定：畸形请求（缺 code、非字符串）同样计入配额，否则刷量方只要故意发畸形体即可绕过窗口。
  // 429 不泄漏任何 code 状态，因此把它放在前面对探测面也没有影响。
  const limited = acquire(`session:peer:${input.peerKey}`, rateLimitPolicies().session);
  if (limited !== null) return limited;
  if (typeof input.code !== "string" || input.code.length === 0) return failure(400, MSG_INVALID_CODE);

  const redeemed = redeemCode(input.code);
  if (redeemed === null) return failure(400, MSG_INVALID_CODE);
  return success({ ticket: redeemed.ticket, expiresAt: redeemed.expiresAt, claims: redeemed.claims });
}

/** 续期票据（`POST /session/refresh`）：新票 `exp` ≤ min(原 `exp`, now + TTL)，续期只能缩短会话。 */
export function handleSessionRefresh(input: { ticket: string | null; peerKey: string }): CanvasBffResult {
  // 先验签再限流：有效票据按用户计数（限到该用户自己头上），无效/缺失票据按来源计数——伪造票据因此
  // 打不到任何真实用户的配额，只能刷自己的来源桶。
  const claims = input.ticket === null ? null : verifyTicket(input.ticket);
  const limited = acquire(
    claims === null ? `session:peer:${input.peerKey}` : `session:sub:${claims.sub}`,
    rateLimitPolicies().session,
  );
  if (limited !== null) return limited;

  const refreshed = input.ticket === null ? null : refreshTicket(input.ticket);
  if (refreshed === null) return ticketInvalid();
  return success({ ticket: refreshed.ticket, expiresAt: refreshed.expiresAt, claims: refreshed.claims });
}

/** 撤销票据族（`POST /session/revoke`）：撤销后本族票据立即失效，再出示同样 401。 */
export function handleSessionRevoke(input: { ticket: string | null; peerKey: string }): CanvasBffResult {
  const claims = input.ticket === null ? null : verifyTicket(input.ticket);
  const limited = acquire(
    claims === null ? `session:peer:${input.peerKey}` : `session:sub:${claims.sub}`,
    rateLimitPolicies().session,
  );
  if (limited !== null) return limited;
  if (claims === null) return ticketInvalid();

  revokeSession(claims.sid);
  return success({ revoked: true });
}
