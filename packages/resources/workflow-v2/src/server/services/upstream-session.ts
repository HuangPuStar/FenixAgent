/**
 * 平台上游账号的会话（唯一登录态持有者）。
 *
 * FenixAgent 整体映射上游的**一个**用户（设计 §3.1）：所有 workflow 都由这个账号在它的个人空间里创建，
 * 因此本模块只需要一处登录态。会话是进程内单例——两份会话就是两条登录/重登路径，凭据与失效判定会分叉
 * （同 `@fenix/resource-observer` 的组合根口径）。
 *
 * 会话密钥（`session_key`）只经 `Set-Cookie` 返回，**不落库、不进日志、不进响应**（设计 §4.6）；
 * `workflow_v2_platform_account` 只记账号身份与状态，不存会话材料。登录用凭据来自模块配置
 * （`accountEmail` / `accountPassword`，`secret: true` 声明的部署键），解析响应头而非响应体。
 *
 * 失效与降级：HTTP 401 或响应 `code` 命中鉴权失败码 → `invalidate()` → 下一次 `ensureCookie()` 单飞重登；
 * 重登失败即让调用方拿到 `PLATFORM_SESSION_UNAVAILABLE` 语义的错误，不做无边界重试，也不静默切换账号。
 *
 * 实现约束（冻结 §4 的签名 + 实测结论）：
 * - **惰性登录**：模块加载期不发任何请求，首次 `ensureCookie()` 才登录；
 * - **手工解析 Set-Cookie**：上游 `domain=127.0.0.1:18080` 带端口是非法 domain，cookie jar 会拒收，
 *   因此只从响应头原文里取 `session_key` 值，不引入 cookie 库；
 * - **单飞**：并发 `ensureCookie()` 共享同一个 in-flight Promise，只触发一次登录——上游是单会话账号，
 *   两次并发登录会互相踢键（§9.1 第 3 条），这里的单飞是正确性要求而非性能优化；
 * - **失败不粘住**：登录失败只让本次等待者失败，不缓存失败状态，下一次调用重新尝试。
 *
 * 多副本（4B，2026-09-29）：会话的权威副本在共享存储（`upstream-session-store`：Redis，不可用时降级为进程内
 * 单例并显式告警），本模块只保留一份短 TTL 的本地缓存以避免每个上游请求都走一次 Redis。跨副本的「同时
 * 登录会互相踢键」由**登录租约 + 轮询**收口：只有拿到租约的副本登录，其它副本等它把会话写进共享存储后
 * 直接复用（见 {@link loginWithLease}）。这样水平扩容不再需要粘性会话，也不再出现两个副本互相踢键。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";
import { ensurePlatformAccountLocale } from "./platform-account-locale";
import {
  getUpstreamSessionStore,
  resetUpstreamSessionStoreForTests,
  type UpstreamSessionRecord,
} from "./upstream-session-store";

const logger = createLogger("wf-v2-upstream-session");

/** passport 邮箱登录端点；上游只有这一条建立会话的入口。 */
const LOGIN_PATH = "/api/passport/web/email/login/";

/** 探活端点：`space/list` 无业务参数、无副作用，是判断会话有效性的最低成本请求。 */
const PROBE_PATH = "/api/playground_api/space/list";

/** 会话 cookie 名（上游下发的唯一会话键名）。 */
const SESSION_COOKIE_NAME = "session_key";

/**
 * 到期前的提前重登窗口。
 *
 * `max-age` 只是上游的声明值，实际会话可能提前失效（被踢、上游重启）；提前 60 秒重登是为了避免
 * 「Cookie 刚发出去就过期」这一类可预见失败，真正的失效仍由 `callUpstream` 的鉴权失败分支兜底。
 */
const EXPIRY_SKEW_MS = 60_000;

/** 上游会话失效的唯一业务码。定义在本模块（会话失效判定的主体），由 `upstream-client` 按冻结 §4 转出。 */
export const UPSTREAM_AUTH_FAILED_CODE = 700012006;

/**
 * 时间相关参数（4B）。
 *
 * 做成可注入的一组常量而不是散落的字面量：等待窗口与轮询间隔是**时间行为**，用例必须在毫秒级驱动它们
 * （真等 8 秒会把包级测试拖成分钟级）。生产取这里的默认值，测试经 {@link setUpstreamSessionTimingForTests}
 * 覆盖；不做成 env —— 它们是实现细节，不是部署旋钮（会话 TTL 才是，它由上游 `max-age` 决定）。
 */
const DEFAULT_TIMING = {
  /**
   * 进程内缓存存活时长。
   *
   * 取 5 秒：上游请求的频率远高于会话变化的频率（会话变化只在重登与失效时发生），按请求读 Redis 会把一次
   * 画布操作放大成十几次往返；5 秒的滞后仍远小于会话 TTL（默认 30 天），且 `invalidate()` 会立刻清掉本地
   * 副本——「刚被踢掉的键还在本进程手里」这一窗口因此只由**其它副本**引起，而它们最多滞后 5 秒。
   */
  localCacheTtlMs: 5_000,
  /**
   * 等另一个副本发布会话的上限。
   *
   * 取 8 秒：略短于登录自身的超时预算（`upstreamTimeoutMs`，默认 10s），让「登录失败」与「登录还没回来」
   * 都能在同一个请求内收敛——等不到就再抢一次租约自己登录（见 `loginWithLease`），不无限等下去。
   */
  loginWaitMs: 8_000,
  /** 等待期间的轮询间隔：够密（感知到发布会话的延迟 < 半秒），又不至于把 Redis 打成轮询靶子。 */
  loginWaitPollIntervalMs: 250,
};

type UpstreamSessionTiming = typeof DEFAULT_TIMING;
let timing: UpstreamSessionTiming = { ...DEFAULT_TIMING };

/** 测试用：覆盖时间参数（未提供的项保持当前值）。 */
export function setUpstreamSessionTimingForTests(overrides: Partial<UpstreamSessionTiming>): void {
  timing = { ...timing, ...overrides };
}

export interface UpstreamSession {
  /** 返回可用的上游 Cookie 头（`session_key=...`）；失效时单飞重登。 */
  ensureCookie(): Promise<string>;
  /** 主动失效（收到上游鉴权失败时调用）。 */
  invalidate(): void;
  /** 轻量探活；false 表示会话不可用（不重登）。 */
  probe(): Promise<boolean>;
}

/** 会话不可用的原因标签；只由 HTTP 状态与上游业务码构成，绝不含凭据。 */
export type UpstreamSessionUnavailableReason =
  | "timeout"
  | "network"
  | "rejected"
  | "missing_session_key"
  /** 另一个副本正在登录且等待窗口内没有发布会话（上游单会话，抢登会互相踢键，故如实失败而不是并发登录）。 */
  | "busy";

/**
 * 会话不可用：登录被拒、响应缺会话、上游不可达等。
 *
 * `reason` 是给控制台与日志用的稳定标签（不含凭据），`message` 只补 HTTP 状态与业务码等诊断上下文；
 * 凭据、Cookie 值、账号邮箱一律不得进入这两者。
 */
export class UpstreamSessionUnavailableError extends Error {
  readonly code = "PLATFORM_SESSION_UNAVAILABLE";
  readonly reason: UpstreamSessionUnavailableReason;

  constructor(reason: UpstreamSessionUnavailableReason, detail: string, cause?: unknown) {
    super(`上游平台会话不可用：${detail}`, cause === undefined ? undefined : { cause });
    this.name = "UpstreamSessionUnavailableError";
    this.reason = reason;
  }
}

/**
 * 会话的运行期快照（供控制台 `/web/workflow-v2/platform-account` 与健康检查读取）。
 *
 * 刻意不含会话值、邮箱与任何凭据字段：这张快照会直接进面向控制台的响应。
 */
export interface UpstreamSessionStatus {
  /** 当前进程是否持有未过期的会话。 */
  ready: boolean;
  /** 上次登录成功时间（ISO 8601）；仅进程内记忆，重启后为 null（权威值在 `workflow_v2_platform_account` 行）。 */
  lastLoginAt: string | null;
  /** 上游声明的到期时间（ISO 8601，按 `Set-Cookie` 的 `max-age` 推算）；未声明时为 null。 */
  expiresAt: string | null;
  /** 上次探活时间（ISO 8601）；从未探活为 null。 */
  lastProbeAt: string | null;
  /** 上次探活结果；从未探活为 null。 */
  lastProbeOk: boolean | null;
  /** 最近一次失败的原因标签（`code=...` / `http=...` / `timeout` / `network` 等）；登录或探活成功后清空。 */
  lastErrorCode: string | null;
  /** 登录响应回显的上游用户 ID（非凭据）；进程重启后为 null。 */
  platformUserId: string | null;
}

/**
 * 进程内**最近一次**使用的会话（短 TTL 缓存）。
 *
 * 4B 起会话的权威副本在共享存储（`upstream-session-store`），本地这份只为了避免每个上游请求都走一次 Redis：
 * 命中条件同时要求「未过期」与「缓存不超过 {@link DEFAULT_TIMING.localCacheTtlMs}」。`cookieHeader` 是凭据材料，
 * 只在本模块与出站请求头之间流动。
 */
interface ActiveSession {
  /** 出站 `Cookie` 头全文（`session_key=<值>`）；调用方直接把它放进请求头，不自己拼名字。 */
  cookieHeader: string;
  /** 到期时间戳（毫秒）；上游未声明 `max-age` 时为 null（此时不主动判过期）。 */
  expiresAtMs: number | null;
  loggedInAt: number;
  platformUserId: string | null;
}

let activeSession: ActiveSession | null = null;
let activeSessionCachedAtMs = 0;
/**
 * 已被本进程判定失效的会话登录时刻水位：**不晚于**它的记录一律不采纳。
 *
 * 为什么按登录时刻而不是「删键就完事」：删除可能失败（Redis 抖动或只允许读），而另一副本可能刚好在删除
 * 之后写入一份**更新**的会话——那一份必须能采纳。以 `loggedInAt` 单调比较同时满足两件事：不复活自己刚判定
 * 失效的那一份，也不拒绝别人随后登录出来的新会话。
 */
let invalidatedThroughMs = 0;
/** 进行中的登录；并发 `ensureCookie()` 共享它，实现单飞（失败时在 finally 里清空，不粘住）。 */
let loginInFlight: Promise<string> | null = null;
let lastProbeAtMs: number | null = null;
let lastProbeOk: boolean | null = null;
let lastErrorCode: string | null = null;

/** 上游基址归一：去掉尾部斜杠，避免拼出 `//api/...`。 */
function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** JSON 解析失败返回 null：登录与探活都只关心业务码，响应不是 JSON 时按「未通过」处理。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 业务码读取：只认数字，`"0"` 之类的字符串不算（上游返回 number）。 */
function readBusinessCode(payload: unknown): number | undefined {
  if (!isRecord(payload)) return;
  return typeof payload.code === "number" ? payload.code : undefined;
}

/**
 * 从单条 `Set-Cookie` 原文里取 `session_key` 值；只解析第一个 `name=value` 对。
 *
 * 不用 cookie jar：上游下发的 `domain=127.0.0.1:18080` 带端口属非法 domain，标准实现会整条拒收。
 */
function parseSessionKey(setCookie: string): string | null {
  const firstPair = setCookie.split(";", 1)[0] ?? "";
  const separator = firstPair.indexOf("=");
  if (separator <= 0) return null;
  if (firstPair.slice(0, separator).trim() !== SESSION_COOKIE_NAME) return null;
  const value = firstPair.slice(separator + 1).trim();
  return value.length > 0 ? value : null;
}

/** 取响应头里的会话值；`getSetCookie()` 不可用（多条被中间层合并）时退回原文扫描。 */
function extractSessionKey(headers: Headers): string | null {
  for (const setCookie of headers.getSetCookie()) {
    const value = parseSessionKey(setCookie);
    if (value) return value;
  }
  const merged = headers.get("set-cookie") ?? "";
  const matched = /(?:^|[;,])\s*session_key=([^;,\s]+)/.exec(merged);
  return matched?.[1] ?? null;
}

/** 声明有效期（秒）；缺失或非法时为 null，此时不主动判过期。 */
function parseMaxAgeSeconds(headers: Headers): number | null {
  for (const setCookie of headers.getSetCookie()) {
    const matched = /(?:^|;)\s*max-age=(\d+)/i.exec(setCookie);
    if (matched?.[1]) return Number(matched[1]);
  }
  return null;
}

function isExpired(session: UpstreamSessionRecord, now: number): boolean {
  return session.expiresAtMs !== null && now >= session.expiresAtMs - EXPIRY_SKEW_MS;
}

function toIso(value: number | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

/** 写入进程内短 TTL 缓存。 */
function cacheSession(record: UpstreamSessionRecord, nowMs: number): void {
  activeSession = {
    cookieHeader: record.cookieHeader,
    expiresAtMs: record.expiresAtMs,
    loggedInAt: record.loggedInAt,
    platformUserId: record.platformUserId,
  };
  activeSessionCachedAtMs = nowMs;
}

/**
 * 从共享存储读一份**可采纳**的会话；没有就返回 null。
 *
 * 两条否决条件：本进程已判定失效（`invalidatedThroughMs`，见其注释）与已过期（含提前窗口）。读失败由
 * 存储实现自己降级并告警，这里拿到的是「降级后的结果」，不重复记日志。
 */
async function readSharedSession(nowMs: number): Promise<UpstreamSessionRecord | null> {
  const record = await getUpstreamSessionStore().read();
  if (record === null) return null;
  // 不晚于水位的一律否决（含「同一毫秒」）：水位是本进程**已判定失效**的那一份，再采纳它就会在
  // 「读得到、删不掉」（Redis 只读可用）时陷入「采纳 → 上游 401 → 失效 → 再采纳」的死循环；把它挡掉，
  // 下一次调用就会去登录并拿到新会话。代价是另一副本在同一毫秒内登录出来的会话会被否决一次——两次登录
  // 落在同一毫秒在实际链路上不可能（登录本身要一次 HTTP 往返）。
  if (record.loggedInAt <= invalidatedThroughMs) return null;
  if (isExpired(record, nowMs)) return null;
  return record;
}

/** 取当前可用会话记录：本地缓存优先（未过期且在 TTL 内），否则读共享存储；**不触发登录**。 */
async function currentSession(): Promise<UpstreamSessionRecord | null> {
  const now = Date.now();
  const cached = activeSession;
  if (cached !== null && now - activeSessionCachedAtMs < timing.localCacheTtlMs && !isExpired(cached, now))
    return cached;
  return await readSharedSession(now);
}

/** 固定间隔轮询；只用于等待另一个副本发布会话，不做无边界重试。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 会话自用的上游请求：固定 POST + JSON（上游只在「POST + application/json」下绑定请求体），
 * 超时覆盖到响应体读完为止。
 *
 * 为什么不复用 `upstream-client`：那个模块的契约规定「鉴权失败即重登 + 重放」，而登录本身必须跳开该行为
 * （否则递归登录），探活也不能触发重登；同时 `upstream-client` 依赖本模块取会话，反向调用会成环。
 */
async function postJsonRequest(input: {
  path: string;
  baseUrl: string;
  /** 出站 `Cookie` 头全文；登录时为 null（登录本身不带会话）。 */
  cookieHeader: string | null;
  body: unknown;
  timeoutMs: number;
}): Promise<{ status: number; headers: Headers; text: string }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const response = await fetch(joinUrl(input.baseUrl, input.path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(input.cookieHeader === null ? {} : { Cookie: input.cookieHeader }),
      },
      body: JSON.stringify(input.body ?? {}),
      signal: controller.signal,
    });
    return { status: response.status, headers: response.headers, text: await response.text() };
  } catch (error) {
    if (timedOut) {
      throw new UpstreamSessionUnavailableError("timeout", `上游请求超时（${input.timeoutMs}ms，${input.path}）`);
    }
    throw new UpstreamSessionUnavailableError("network", `上游请求失败（${input.path}）`, error);
  } finally {
    clearTimeout(timer);
  }
}

/** 登录失败的诊断描述：只含 HTTP 状态与业务码，不回显响应正文（正文含账号信息）。 */
function describeLoginFailure(status: number, code: number | undefined): string {
  return `登录被上游拒绝（HTTP ${status}${code === undefined ? "" : `，code=${code}`}）`;
}

/** 登录响应回显的上游用户 ID（`data.user_id_str`）；缺失或形状不符时为 null（不是失败原因）。 */
function readPlatformUserId(payload: unknown): string | null {
  if (!isRecord(payload) || !isRecord(payload.data)) return null;
  const userId = payload.data.user_id_str;
  return typeof userId === "string" && userId.length > 0 ? userId : null;
}

/** 执行一次真实登录，成功时写入共享存储与本地缓存并返回 Cookie 头。 */
async function login(): Promise<string> {
  const config = getWorkflowV2Config();
  const startedAt = Date.now();

  let response: { status: number; headers: Headers; text: string };
  try {
    response = await postJsonRequest({
      path: LOGIN_PATH,
      baseUrl: config.upstreamBaseUrl,
      cookieHeader: null,
      body: { email: config.accountEmail, password: config.accountPassword },
      timeoutMs: config.upstreamTimeoutMs,
    });
  } catch (error) {
    const failure =
      error instanceof UpstreamSessionUnavailableError
        ? error
        : new UpstreamSessionUnavailableError("network", `登录请求失败（${LOGIN_PATH}）`, error);
    lastErrorCode = failure.reason;
    logger.warn("上游平台账号登录失败", { reason: failure.reason });
    throw failure;
  }

  const parsed = safeJson(response.text);
  const code = readBusinessCode(parsed);
  if (response.status !== 200 || code !== 0) {
    lastErrorCode = code === undefined ? `http=${response.status}` : `code=${code}`;
    logger.warn("上游平台账号登录被拒", { status: response.status, code });
    throw new UpstreamSessionUnavailableError("rejected", describeLoginFailure(response.status, code));
  }

  const sessionKey = extractSessionKey(response.headers);
  if (sessionKey === null) {
    lastErrorCode = "missing_session_key";
    logger.warn("上游平台账号登录响应缺少会话", { status: response.status });
    throw new UpstreamSessionUnavailableError(
      "missing_session_key",
      `登录响应缺少 session_key（HTTP ${response.status}）`,
    );
  }

  const cookieHeader = `${SESSION_COOKIE_NAME}=${sessionKey}`;
  const maxAgeSeconds = parseMaxAgeSeconds(response.headers);
  const record: UpstreamSessionRecord = {
    cookieHeader,
    expiresAtMs: maxAgeSeconds === null ? null : startedAt + maxAgeSeconds * 1000,
    loggedInAt: Date.now(),
    platformUserId: readPlatformUserId(parsed),
  };
  cacheSession(record, Date.now());
  try {
    await getUpstreamSessionStore().write(record);
  } catch (error) {
    // 存储实现内部已降级并告警；这里兜底的是「它自己抛了」的意外路径——共享存储失败不该让登录结果作废
    // （本副本已经拿到可用会话），但必须留下诊断上下文。
    logger.warn("上游平台会话写入共享存储失败，仅本副本可用", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  lastErrorCode = null;
  logger.info("上游平台账号登录成功", { expiresInSeconds: maxAgeSeconds });
  return cookieHeader;
}

/**
 * 等待另一个副本把登录出来的会话写进共享存储（租约 + 轮询，避免多副本同时登录）。
 *
 * 拿不到就返回 null：调用方据此决定「抢一次租约自己登录」还是如实失败，不在本函数里做无边界重试。
 */
async function waitForPublishedSession(): Promise<UpstreamSessionRecord | null> {
  const deadline = Date.now() + timing.loginWaitMs;
  while (Date.now() < deadline) {
    await sleep(timing.loginWaitPollIntervalMs);
    const record = await readSharedSession(Date.now());
    if (record !== null) {
      cacheSession(record, Date.now());
      logger.info("上游平台会话由其它副本发布，本副本直接复用", { loggedInAt: record.loggedInAt });
      return record;
    }
  }
  return null;
}

/**
 * 单飞登录（含跨副本租约）。
 *
 * 三层收口，缺一不可：
 * 1. **进程内单飞**：并发 `ensureCookie()` 共享同一个 in-flight Promise；
 * 2. **跨副本租约**：只有拿到租约的副本才登录，其它副本在 `timing.loginWaitMs` 内轮询共享存储等它发布会话
 *    （上游单会话，两个副本同时登录会互相踢键，见设计 §9.1.1 第 3 条）；
 * 3. **有界重试**：等不到就**再抢一次**租约自己登录（租约持有者可能已失败或崩溃），仍抢不到才如实抛
 *    `busy`——不做第三次尝试，也不排队等下去。
 */
async function loginWithLease(): Promise<string> {
  const store = getUpstreamSessionStore();
  if (!(await store.acquireLoginLease())) {
    const adopted = await waitForPublishedSession();
    if (adopted !== null) return adopted.cookieHeader;
    if (!(await store.acquireLoginLease())) {
      throw new UpstreamSessionUnavailableError(
        "busy",
        `另一副本正在登录且未在 ${timing.loginWaitMs}ms 内发布会话（多次调用仍失败需检查上游账号状态）`,
      );
    }
  }
  try {
    return await login();
  } finally {
    await store.releaseLoginLease();
  }
}

/**
 * 取一个可用会话（不含 locale 校正）：本地缓存 → 共享存储 → 单飞登录。
 *
 * 单飞的失败语义：等待者共享同一次尝试的失败，但 in-flight 句柄在 `finally` 里立即清空——失败不会被
 * 记忆成「本进程不可登录」，下一次调用会发起新的登录请求（上游不锁账号、不限流，可安全重试）。
 */
async function acquireCookie(): Promise<string> {
  const now = Date.now();
  const cached = activeSession;
  if (cached !== null && now - activeSessionCachedAtMs < timing.localCacheTtlMs && !isExpired(cached, now)) {
    return cached.cookieHeader;
  }
  if (cached !== null && isExpired(cached, now)) activeSession = null;

  const shared = await readSharedSession(now);
  if (shared !== null) {
    cacheSession(shared, now);
    return shared.cookieHeader;
  }

  if (loginInFlight === null) {
    const attempt: Promise<string> = loginWithLease().finally(() => {
      // 只清自己这一轮：登录期间若又发生 invalidate + 新一轮登录，不能把新句柄误清掉。
      if (loginInFlight === attempt) loginInFlight = null;
    });
    loginInFlight = attempt;
  }
  return loginInFlight;
}

/**
 * 丢弃当前会话，使下一次 `ensureCookie()` 重新登录（保留登录时间等历史状态供控制台展示）。
 *
 * 共享存储的删除是**尽力而为**：删失败只会让其它副本多试一次（它们下一次调用会命中鉴权失败并各自失效），
 * 但失败必须留日志；本地缓存与「失效水位」则同步生效，本副本不会把刚判定失效的会话再捡回来。
 */
function invalidate(): void {
  const current = activeSession;
  activeSession = null;
  if (current !== null) {
    invalidatedThroughMs = Math.max(invalidatedThroughMs, current.loggedInAt);
    logger.info("上游平台会话已失效，等待下次调用重登");
  }
  void getUpstreamSessionStore()
    .clear()
    .catch((error: unknown) => {
      logger.warn("上游平台会话的共享存储删除失败，其它副本可能短暂复用旧会话", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

/** 是否命中会话失效：HTTP 401（完全无 Cookie）或业务码 700012006（键非法/被踢/过期）。 */
function isSessionInvalid(status: number, code: number | undefined): boolean {
  return status === 401 || code === UPSTREAM_AUTH_FAILED_CODE;
}

/** 探活失败的原因标签：与登录路径同一套写法（`http=...` / `code=...` / 网络类 reason）。 */
function describeProbeFailure(status: number, code: number | undefined): string {
  return code === undefined ? `http=${status}` : `code=${code}`;
}

/**
 * 轻量探活：用一次 `space/list` 判断会话是否仍可用。
 *
 * 三条边界：
 * - **不重登**：没有会话时直接返回 false（不发起请求），因为「探活」不该产生登录副作用；
 * - **确认失效即作废**：命中 401/700012006 时 `invalidate()`，让下一次 `ensureCookie()` 走单飞重登；
 * - **不抛错**：超时、网络错误、上游 panic 一律 false——探活结果只有「可用/不可用」两态，调用方
 *   （控制台状态、健康检查）据此降级，不承担异常分支。
 *
 * 探活结果同时写进 `lastErrorCode`：会话被外部踢键时 `invalidate()` 只清掉会话，若不写标签，控制台会看到
 * 「已降级但无原因」；探活成功则清空，因为那一刻会话刚被验证过。没有会话时不覆盖已有标签——那通常由登录
 * 失败写下（如 `code=700000003`），比「无会话」更有诊断价值。
 */
async function probe(): Promise<boolean> {
  lastProbeAtMs = Date.now();
  // 本地缓存 → 共享存储：多副本下本进程重启后没有本地副本，但共享存储里可能有别的副本刚登录出来的会话，
  // 探活应当能看到它（否则控制台会把「刚部署完的一个副本」显示成 degraded）。
  const current = await currentSession();
  if (current === null) {
    lastProbeOk = false;
    return false;
  }

  const config = getWorkflowV2Config();
  try {
    const response = await postJsonRequest({
      path: PROBE_PATH,
      baseUrl: config.upstreamBaseUrl,
      cookieHeader: current.cookieHeader,
      body: {},
      timeoutMs: config.upstreamTimeoutMs,
    });
    const code = readBusinessCode(safeJson(response.text));
    const ok = response.status === 200 && code === 0;
    lastProbeOk = ok;
    lastErrorCode = ok ? null : describeProbeFailure(response.status, code);
    if (!ok && isSessionInvalid(response.status, code)) invalidate();
    return ok;
  } catch (error) {
    lastProbeOk = false;
    const reason = error instanceof UpstreamSessionUnavailableError ? error.reason : "unknown";
    lastErrorCode = reason;
    logger.warn("上游平台会话探活失败", { reason });
    return false;
  }
}

/**
 * 取可用会话（对外语义），并在拿到会话后顺带**校正平台账号的 locale**。
 *
 * 为什么 locale 校正挂在这里：内嵌画布的节点名与 UI 文案由上游按账号 `locale` 选择，账号一旦以 `en-US`
 * 建出就永远是英文（成因与链路见 `platform-account-locale` 的文件头）。校正必须覆盖**存量部署**——账号
 * 台账已有行时 `platform-account-bootstrap` 根本不会运行，而每一次上游调用都要经过本函数，它是我方
 * 「已持有平台账号凭据」的唯一必经点。
 *
 * 代价与降级：校正只在每个进程的首次调用时出站（结论按进程记忆、单飞），失败不抛错也不阻塞会话获取，
 * 因此这里的 await 不改变 `ensureCookie` 的失败语义——最坏情况是画布继续显示英文，而不是画布打不开。
 */
async function ensureCookie(): Promise<string> {
  const cookieHeader = await acquireCookie();
  await ensurePlatformAccountLocale(cookieHeader);
  return cookieHeader;
}

const session: UpstreamSession = { ensureCookie, invalidate, probe };

/** 取平台上游会话单例（进程内唯一登录态；模块加载期不发请求）。 */
export function getUpstreamSession(): UpstreamSession {
  return session;
}

/**
 * 读取会话运行期快照（同步、无副作用、不出站）。
 *
 * `ready` 只表示「本进程此刻持有未过期会话」，不代表上游一定接受它——上游可能已把该键踢掉而本进程
 * 尚未察觉，那要靠 `probe()` 或下一次调用的鉴权失败分支收敛。
 */
export function getUpstreamSessionStatus(): UpstreamSessionStatus {
  const current = activeSession;
  return {
    ready: current !== null && !isExpired(current, Date.now()),
    lastLoginAt: toIso(current?.loggedInAt ?? null),
    expiresAt: toIso(current?.expiresAtMs ?? null),
    lastProbeAt: toIso(lastProbeAtMs),
    lastProbeOk,
    lastErrorCode,
    platformUserId: current?.platformUserId ?? null,
  };
}

/**
 * 测试用：只清空本进程的会话记忆（本地缓存、失效水位、进行中的登录、探活状态），**保留共享存储**。
 *
 * 用它模拟「另一个副本」或「进程刚重启」：本进程没有任何会话记忆，但共享存储里可能有别的副本写下的会话。
 */
export function resetUpstreamSessionLocalStateForTests(): void {
  activeSession = null;
  activeSessionCachedAtMs = 0;
  invalidatedThroughMs = 0;
  loginInFlight = null;
  lastProbeAtMs = null;
  lastProbeOk = null;
  lastErrorCode = null;
  timing = { ...DEFAULT_TIMING };
}

/** 测试用：清空本进程的会话记忆**与**共享存储替身（回到「全新建库、全新建进程」的起点）。 */
export function resetUpstreamSessionForTests(): void {
  resetUpstreamSessionLocalStateForTests();
  resetUpstreamSessionStoreForTests();
}
