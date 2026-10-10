/**
 * 上游调用（单次请求，不含业务语义）。
 *
 * 本文件是模块内**唯一**发出上游 HTTP 请求的地方：控制面路由、画布透传面与租户 App 管理都必须经
 * `callUpstream()`，不在各自的位置拼 URL、读 fetch 或复制鉴权头。理由与 `upstream-session` 同源——会话头、超时
 * 预算与「鉴权失败重放一次」这三件事只要有一处旁路，失效判定就会分裂（设计 §4.7）。
 *
 * 两条面各有一个出口：`callUpstream()` 走会话面（`/api/*` + Cookie），`callUpstreamOpenApi()` 走 OpenAPI 面
 * （`/v1/*` + Bearer PAT，对外触发接口用）。两者共用同一份熔断结算与失效判定口径，差别只在凭据来源。
 * 唯二的例外是**取凭据本身的请求**：登录（`upstream-session`）与换取 PAT（`upstream-pat`）各自发一次请求，
 * 否则会与本文件成环且互相触发重放。
 *
 * 契约要点：
 * - `path` 以 `/api/` 开头（OpenAPI 面以 `/v1/` 开头），相对 `upstreamBaseUrl`；带查询串的 GET 用
 *   `query` 传，不写在 `path` 里；
 * - 超时取 `timeoutMs ?? config.upstreamTimeoutMs`；本函数**不做重试**（只读接口的退避预算归调用方，
 *   写接口不重试——设计 §4.7）；
 * - 鉴权失败（401 或鉴权失败码）自动 `invalidate()` + 重登 + **重放一次**，重放仍失败即抛错；
 * - **最小熔断**（3C）：连续 5 次传输/会话级失败进入打开态，冷却 30s 内直接以 503 语义短路（不发请求），
 *   之后半开放行一次探测；判定与状态在 `upstream-health`，本文件只做「取名额 → 调用 → 结算」三步；
 * - 返回 `{ status, body }` 原始结果，不解释业务字段：错误映射与响应形状由调用方按各自协议面决定
 *   （`/web/*` 归一化为 `{success,data}`，`/workflow-canvas/bff/*` 原样回传上游信封）。
 *
 * 鉴权失败判定（§9.1.1 第 1 条，与设计正文旧假设不同）：上游带失效 `session_key` 时返回 **HTTP 200 +
 * `{"code":700012006}`**，HTTP 401 只在完全没有 Cookie 时出现；两者都触发重登。`400`（缺参数）与
 * `777777775`（上游 panic）**不是**鉴权失败，把它们算进去会造成参数错误触发重登风暴。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";
import { getUpstreamHealth, type UpstreamFailureKind } from "./upstream-health";
import { getUpstreamPat } from "./upstream-pat";
import { getUpstreamSession, UPSTREAM_AUTH_FAILED_CODE, UpstreamSessionUnavailableError } from "./upstream-session";

const logger = createLogger("wf-v2-upstream-client");

/** 按冻结 §4 从本模块出口转出（判定主体在 `upstream-session`，两处各存一份会漂移）。 */
export { UPSTREAM_AUTH_FAILED_CODE };

/** 上游 panic 业务码：响应体含 Go 堆栈，**透传前必须剥离**（冻结 §6）。 */
export const UPSTREAM_PANIC_CODE = 777777775;

export interface UpstreamCallInput {
  /** 上游路径，以 `/api/` 开头（透传面的允许前缀见冻结 §6）。 */
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: unknown;
  /** 单次调用超时；缺省取模块配置的 `upstreamTimeoutMs`。 */
  timeoutMs?: number;
}

/**
 * OpenAPI 面（`/v1/*`，Bearer PAT）的调用入参。
 *
 * 与 {@link UpstreamCallInput} 分开声明而不是给 `path` 放宽前缀：两条面的**凭据不同**（会话 Cookie vs PAT），
 * 混用一个入参类型会让「这条路径该带哪种凭据」只能靠运行时字符串判断，而凭据注入正是本文件唯一要收口的事。
 */
export interface UpstreamOpenApiCallInput {
  /** 上游路径，以 `/v1/` 开头（当前唯一消费方是 `POST /v1/workflow/run`）。 */
  path: string;
  method?: "GET" | "POST";
  query?: Record<string, string>;
  body?: unknown;
  /** 单次调用超时；缺省取模块配置的 `upstreamTimeoutMs`。 */
  timeoutMs?: number;
}

export interface UpstreamCallResult {
  /** 上游 HTTP 状态码；透传面按它原样回传，不折叠成 200。 */
  status: number;
  /** 上游响应体（通常是 `{ data, code, msg }` 信封）；解析失败时为原始文本或 undefined。 */
  body: unknown;
}

/** 调用侧错误码：路径非法、超时、网络失败；上游的业务错误不在此列（它们经 `{status, body}` 返回）。 */
export type UpstreamRequestErrorCode = "UPSTREAM_INVALID_PATH" | "UPSTREAM_TIMEOUT" | "UPSTREAM_NETWORK_ERROR";

/**
 * 请求未能抵达或未能完成：本地校验失败、超时、网络错误。
 *
 * 与「上游返回了错误响应」区分开：后者是 `{status, body}` 的正常返回（调用方按业务码映射），只有前者
 * 需要异常分支。错误信息只含方法、路径与超时预算，不含 Cookie。
 */
export class UpstreamRequestError extends Error {
  readonly code: UpstreamRequestErrorCode;

  constructor(code: UpstreamRequestErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "UpstreamRequestError";
    this.code = code;
  }
}

/**
 * 熔断打开时的短路错误：本次调用**没有**发出任何上游请求（3C）。
 *
 * 为什么继承 {@link UpstreamSessionUnavailableError}：这是控制台面、画布 BFF 与静态反代三个上游消费面共同
 * 认得的错误基类，三处都按它映射 **503**（画布面 `mapUpstreamFailure`、静态反代 `upstream-proxy`、
 * 控制面 `upstreamFailure`）。新增一个平行类会让三个面各加一个分支——那正是「第二套错误映射」的来源。
 * 继承后熔断打开与「上游可达但会话不可用」在各面同形（都是 503 上游不可用），`reason` 取 `network`
 * （该枚举里最接近「上游不可达」的一档），`name` 与消息保留熔断语义供日志区分。
 */
export class UpstreamCircuitOpenError extends UpstreamSessionUnavailableError {
  constructor(path: string, cooldownRemainingMs: number) {
    super("network", `上游熔断处于打开态（${path}），冷却剩余 ${cooldownRemainingMs}ms，本次不发出请求`);
    this.name = "UpstreamCircuitOpenError";
  }
}

/**
 * 传输/会话级失败的归一标签：从 `upstream-health` 的计数种类里取三档（`upstream_5xx` 由 HTTP 状态判定，
 * 不来自异常），类型上保持同源——那边增删种类时这里会编译失败，而不是静默漂移。
 */
export type UpstreamTransportFailureKind = Extract<UpstreamFailureKind, "timeout" | "network" | "session">;

/**
 * 传输/会话级失败的**唯一判定点**：熔断计数与控制面错误映射共用它，避免「哪里算失败」有两份口径。
 *
 * 业务失败不在此列：它们经 `{status, body}` 正常返回，调用方按业务码映射，不计入上游健康（见
 * `upstream-health` 文件头）。`UPSTREAM_INVALID_PATH` 是我方入参错误，同样不判上游。
 */
export function transportFailureKind(error: unknown): UpstreamTransportFailureKind | null {
  // 短路本身不是新的失败：它没有触达上游，不再计入。
  if (error instanceof UpstreamCircuitOpenError) return null;
  if (error instanceof UpstreamSessionUnavailableError) return "session";
  if (error instanceof UpstreamRequestError) {
    if (error.code === "UPSTREAM_TIMEOUT") return "timeout";
    if (error.code === "UPSTREAM_NETWORK_ERROR") return "network";
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBusinessCode(body: unknown): number | undefined {
  if (!isRecord(body)) return;
  return typeof body.code === "number" ? body.code : undefined;
}

/**
 * 会话失效判定：仅 HTTP 401（完全没带 Cookie）或业务码 700012006（键非法/被踢/过期）。
 *
 * 这里是唯一的判定点——把它放宽到「任何非 0 业务码」或任何 4xx，参数错误就会触发重登 + 重放，
 * 既污染会话又放大上游压力。
 */
function isAuthFailure(result: UpstreamCallResult): boolean {
  return result.status === 401 || readBusinessCode(result.body) === UPSTREAM_AUTH_FAILED_CODE;
}

/** 出站路径校验：必须以 `/api/` 开头，且不得含 `..` 段（避免 URL 归一化把请求带出上游 API 面）。 */
function assertUpstreamPath(path: string): void {
  if (!path.startsWith("/api/") || path.includes("..")) {
    throw new UpstreamRequestError("UPSTREAM_INVALID_PATH", `上游路径必须以 /api/ 开头且不得包含 ..（收到：${path}）`);
  }
}

/** OpenAPI 面的出站路径校验：必须以 `/v1/` 开头（`/api/*` 面不接受 PAT，混用会静默拿不到鉴权）。 */
function assertOpenApiPath(path: string): void {
  if (!path.startsWith("/v1/") || path.includes("..")) {
    throw new UpstreamRequestError(
      "UPSTREAM_INVALID_PATH",
      `OpenAPI 路径必须以 /v1/ 开头且不得包含 ..（收到：${path}）`,
    );
  }
}

/** 拼接上游 URL：基址去尾斜杠，query 一律经 `URLSearchParams` 编码（调用方不要把查询串写进 path）。 */
function buildUpstreamUrl(baseUrl: string, path: string, query: Record<string, string> | undefined): string {
  const url = `${baseUrl.replace(/\/+$/, "")}${path}`;
  if (query === undefined) return url;
  const search = new URLSearchParams(query).toString();
  if (search.length === 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}${search}`;
}

/**
 * 响应体解析：JSON 优先，失败时返回原始文本（上游 panic 分支会返回纯文本，调用方需要看到它）。
 * 空响应体返回 undefined。
 */
function parseResponseBody(text: string): unknown {
  if (text.length === 0) return;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * 发送一次请求。
 *
 * 超时经 `AbortController` 实现并覆盖到响应体读完为止；`timedOut` 标志用于把「我方超时」与「上游连接
 * 失败」区分开（两者的调用方处置不同：前者可重试，后者要判上游可用性）。
 *
 * `headers` 由两条面各自给足**凭据头**（`/api/*` 面是 `Cookie`，`/v1/*` 面是 `Authorization`）：凭据只在此处
 * 进入请求，调用方不各自拼头，失效判定也就不会分裂；两种凭据永不混发（`/v1/*` 上带 Cookie 没有意义，
 * 而 `/api/*` 上带 Bearer 会被会话中间件忽略）。
 */
async function sendUpstreamRequest(
  input: { path: string; method?: "GET" | "POST"; query?: Record<string, string>; body?: unknown },
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<UpstreamCallResult> {
  const config = getWorkflowV2Config();
  const method = input.method ?? "POST";
  const url = buildUpstreamUrl(config.upstreamBaseUrl, input.path, input.query);

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        ...headers,
        // 上游只在 POST + application/json 下绑定请求体，其它 Content-Type 会得到「参数缺失」类错误。
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
      },
      body: method === "POST" ? JSON.stringify(input.body ?? {}) : undefined,
      signal: controller.signal,
    });
    return { status: response.status, body: parseResponseBody(await response.text()) };
  } catch (error) {
    if (timedOut) {
      throw new UpstreamRequestError(
        "UPSTREAM_TIMEOUT",
        `上游调用超时（${timeoutMs}ms，${method} ${input.path}）`,
        error,
      );
    }
    throw new UpstreamRequestError("UPSTREAM_NETWORK_ERROR", `上游请求失败（${method} ${input.path}）`, error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 熔断结算（3C）：请求前取名额（打开态直接短路、不发请求），请求后按下表结算——5xx 与传输/会话级异常计入
 * 失败，其余（含 400/720701011 等业务失败码）视为**上游可达**并清零计数。
 *
 * 抽取成函数而不是在两条面各写一遍：结算必须恰好一次（`try/catch` 覆盖到返回路径，别让半开探测名额悬空，
 * 见 `upstream-health`），两份实现迟早在某个出口漏掉一次结算。
 */
async function runWithCircuitBreaker(
  path: string,
  run: () => Promise<UpstreamCallResult>,
): Promise<UpstreamCallResult> {
  const health = getUpstreamHealth();
  if (!health.tryAcquire()) {
    const { state, consecutiveFailures, cooldownRemainingMs } = health.snapshot();
    logger.warn("上游熔断打开，本次调用直接短路", {
      path,
      circuitState: state,
      consecutiveFailures,
      cooldownRemainingMs,
    });
    throw new UpstreamCircuitOpenError(path, cooldownRemainingMs);
  }

  try {
    const result = await run();
    if (result.status >= 500) {
      // 5xx 是上游自身故障（含 panic 兜底的纯文本 500）：上游活着但没有正确服务，计入熔断。
      logger.warn("上游返回 5xx，计入熔断", { path, upstreamStatus: result.status });
      health.recordUpstreamFailure("upstream_5xx");
    } else {
      health.recordUpstreamSuccess();
    }
    return result;
  } catch (error) {
    const kind = transportFailureKind(error);
    if (kind === null) {
      health.recordLocalError();
    } else {
      logger.warn("上游传输/会话级失败，计入熔断", { path, failureKind: kind });
      health.recordUpstreamFailure(kind);
    }
    throw error;
  }
}

/**
 * 单次上游调用（不含业务重试）；鉴权失败自动 invalidate + 重登 + 重放一次，外层套最小熔断（3C）。
 *
 * 重放只发生一次：重登后的请求仍被判失效，说明问题不在会话（上游异常或账号被外部踢键），此时抛
 * `UpstreamSessionUnavailableError` 让调用方按「平台账号不可用」降级，绝不循环重登。
 */
export async function callUpstream(input: UpstreamCallInput): Promise<UpstreamCallResult> {
  assertUpstreamPath(input.path);
  return await runWithCircuitBreaker(input.path, () => callUpstreamWithSession(input));
}

/**
 * OpenAPI 面（`/v1/*`）的单次调用：Bearer PAT，令牌失效自动重建 + 重放一次，外层共用同一份熔断。
 *
 * 为什么共用熔断：`/api/*` 与 `/v1/*` 是同一个上游进程的两个协议面，一边不可达时另一边的失败也会
 * 连续计满阈值——两份计数器只会让短路判定变慢。
 *
 * 失效判定与 `/api/*` 面同源（HTTP 401 或业务码 `700012006`）：PAT 无效时上游在**中间件**阶段就返回 401，
 * 因此这两条判据已经覆盖「令牌被删/过期/账号异常」。重建走 `upstream-pat`（凭平台账号会话），重建后仍被判
 * 失效即抛 `UpstreamSessionUnavailableError`——那是平台凭据链的问题，重放第三次不会变好。
 */
export async function callUpstreamOpenApi(input: UpstreamOpenApiCallInput): Promise<UpstreamCallResult> {
  assertOpenApiPath(input.path);
  return await runWithCircuitBreaker(input.path, () => callUpstreamWithPat(input));
}

/** 单次 OpenAPI 调用（含令牌失效重建一次）；熔断的状态与计数全部由 {@link runWithCircuitBreaker} 负责。 */
async function callUpstreamWithPat(input: UpstreamOpenApiCallInput): Promise<UpstreamCallResult> {
  const config = getWorkflowV2Config();
  const timeoutMs = input.timeoutMs ?? config.upstreamTimeoutMs;
  const pat = getUpstreamPat();

  const first = await sendUpstreamRequest(input, bearerHeader(await pat.ensureToken()), timeoutMs);
  if (!isAuthFailure(first)) return first;

  logger.warn("上游判定平台令牌失效，重建后重放一次", {
    status: first.status,
    code: readBusinessCode(first.body),
    path: input.path,
  });
  pat.invalidate();
  const replayed = await sendUpstreamRequest(input, bearerHeader(await pat.ensureToken()), timeoutMs);
  if (isAuthFailure(replayed)) {
    const code = readBusinessCode(replayed.body);
    throw new UpstreamSessionUnavailableError(
      "rejected",
      `重建令牌后仍被上游拒绝（HTTP ${replayed.status}${code === undefined ? "" : `，code=${code}`}）`,
    );
  }
  return replayed;
}

/** 出站鉴权头；令牌只在这一次拼接里出现，不进入日志、错误与返回值。 */
function bearerHeader(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** 单次上游调用（含鉴权失败重放一次）；熔断的状态与计数全部由 {@link runWithCircuitBreaker} 负责。 */
async function callUpstreamWithSession(input: UpstreamCallInput): Promise<UpstreamCallResult> {
  const config = getWorkflowV2Config();
  const timeoutMs = input.timeoutMs ?? config.upstreamTimeoutMs;
  const session = getUpstreamSession();

  const first = await sendUpstreamRequest(input, { Cookie: await session.ensureCookie() }, timeoutMs);
  if (!isAuthFailure(first)) return first;

  logger.warn("上游判定会话失效，重登后重放一次", {
    status: first.status,
    code: readBusinessCode(first.body),
    path: input.path,
  });
  session.invalidate();
  const replayed = await sendUpstreamRequest(input, { Cookie: await session.ensureCookie() }, timeoutMs);
  if (isAuthFailure(replayed)) {
    const code = readBusinessCode(replayed.body);
    throw new UpstreamSessionUnavailableError(
      "rejected",
      `重登后仍被上游判定会话失效（HTTP ${replayed.status}${code === undefined ? "" : `，code=${code}`}）`,
    );
  }
  return replayed;
}
