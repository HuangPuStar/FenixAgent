/**
 * 平台账号 PAT（个人访问令牌）的生命周期：换取、缓存、失效与轮换。
 *
 * 上游 `/v1/*`（对外触发面调用的 `POST /v1/workflow/run`）只接受 `Authorization: Bearer pat_*`：会话
 * cookie 在那条路径上会被 OpenAPI 中间件拒绝（`missing authorization in header`），因此平台必须自己持有一枚
 * PAT。上游只在**创建时**返回明文（列表接口只给元数据），所以本模块是它在平台侧的唯一持有者。
 *
 * 换取（走 WebAPI 面，凭平台账号会话 cookie）：
 * `POST /api/permission_api/pat/create_personal_access_token_and_permission { name, duration_day }` →
 * `{ code: 0, data: { token: "pat_…" } }`。`duration_day` 是**字符串天数**（上游 `ParseInt` 后换算到期时间，
 * 取值 1/30/60/90/180/365/permanent）；这里固定 30 天——`permanent` 无法轮换，长寿命凭据不符合密钥卫生。
 *
 * 轮换策略：**到期前主动重建**，剩余不足 {@link DEFAULT_TIMING.renewMarginMs}（30 天的 1/3）即视为需要重建；
 * 换取成功时以「换取时刻 + 30 天」记到期时间（不解析上游回显的 `expire_at`：其单位未经实测，而本地推算只
 * 影响轮换时机，不影响鉴权正确性——令牌是否有效始终由上游判定）。被替换的旧令牌在换取成功后**尽力吊销**
 * （`delete_personal_access_token_and_permission`，失败只告警）：不吊销的话，长期运行会在上游凭据列表里
 * 逐年累积不再使用的长期凭据。
 *
 * 失效与降级：调用方（`callUpstreamOpenApi`）收到 HTTP 401 或鉴权失败业务码时调 {@link UpstreamPat.invalidate}，
 * 下一次 `ensureToken()` 单飞重建并重放一次；重建本身失败（换取被拒、上游不可达、会话不可用）即抛
 * `UpstreamSessionUnavailableError`——对外表现为 503，不做无边界重试，也不静默降级成别的身份。
 *
 * 多副本：权威副本在共享存储（`upstream-pat-store`：Redis，不可用时降级进程内并显式告警），本模块只留短 TTL
 * 本地缓存；换取用**跨副本租约 + 轮询**收口，避免每个副本各换一枚。
 *
 * 为什么自己发这一个请求而不复用 `callUpstream`：换取走的是会话面（`/api/*` + Cookie），而 `callUpstream`
 * 的契约是「鉴权失败即重登 + 重放」，它依赖本模块所属的 `/v1` 通道去调 `invalidate`——互相调用会成环
 * （`upstream-session` 对登录请求出于同样理由自带 `postJsonRequest`）。本请求不是「运行工作流」的那条出口，
 * 不违反「唯一上游出口」约束。
 */

import { createLogger } from "@fenix/logger";
import { getWorkflowV2Config } from "../config";
import { getUpstreamPatStore, type UpstreamPatRecord } from "./upstream-pat-store";
import { getUpstreamSession, UPSTREAM_AUTH_FAILED_CODE, UpstreamSessionUnavailableError } from "./upstream-session";

const logger = createLogger("wf2-upstream-pat");

/** PAT 换取端点（WebAPI 面，需平台账号会话 cookie）。 */
const CREATE_PATH = "/api/permission_api/pat/create_personal_access_token_and_permission";

/** PAT 吊销端点（同一个 WebAPI 面）：轮换后用它清掉被替换的旧令牌。 */
const DELETE_PATH = "/api/permission_api/pat/delete_personal_access_token_and_permission";

/** 令牌名：便于运维在上游的凭据列表里认出它的来源（不含任何平台内部标识）。 */
const PAT_NAME = "fenix-agent-workflow-v2";

/** 申请的有效期（天）：上游允许 1/30/60/90/180/365/permanent，这里取 30 并靠主动轮换维持。 */
const PAT_DURATION_DAYS = 30;

/**
 * 时间相关参数。
 *
 * 与 `upstream-session` 同因：等待窗口与轮询间隔是**时间行为**，用例必须在毫秒级驱动它们（真等 8 秒会把包级
 * 用例拖成分钟级）。生产取默认值，测试经 {@link setUpstreamPatTimingForTests} 覆盖；不做成 env——它们是实现
 * 细节而不是部署旋钮。
 */
const DEFAULT_TIMING = {
  /** 进程内缓存存活时长：换取频率远低于调用频率，5 秒的滞后足够小（失效由 invalidate 立刻收敛）。 */
  localCacheTtlMs: 5_000,
  /** 等另一个副本发布令牌的上限；等不到就再抢一次租约自己换（与登录同款的有界重试）。 */
  waitMs: 8_000,
  /** 等待期间的轮询间隔：感知到发布令牌的延迟小于半秒，也不至于把 Redis 打成轮询靶子。 */
  pollIntervalMs: 250,
  /** 剩余有效期低于它即提前重建（30 天的 1/3）。 */
  renewMarginMs: 10 * 24 * 60 * 60 * 1000,
};

type UpstreamPatTiming = typeof DEFAULT_TIMING;
let timing: UpstreamPatTiming = { ...DEFAULT_TIMING };

/** 测试用：覆盖时间参数（未提供的项保持当前值）。 */
export function setUpstreamPatTimingForTests(overrides: Partial<UpstreamPatTiming>): void {
  timing = { ...timing, ...overrides };
}

export interface UpstreamPat {
  /** 返回可用的 PAT 明文；失效或临近到期时单飞重建。 */
  ensureToken(): Promise<string>;
  /** 主动失效（上游判定令牌失效时调用）；下一次 `ensureToken()` 会重建。 */
  invalidate(): void;
}

/** 进程内缓存的当前令牌；`cachedAtMs` 是它的写入时刻（只用于 TTL 判定）。 */
let activePat: UpstreamPatRecord | null = null;
let activePatCachedAtMs = 0;
/**
 * 本进程已判定失效的水位（照抄 `upstream-session` 的同一机制）。
 *
 * 不用「令牌是否已被清掉」表达失效：Redis 只读可用（读得到、删不掉）时，清不掉的旧令牌会在下一次读取时
 * 被重新采纳，形成「采纳 → 上游 401 → 失效 → 再采纳」的死循环。水位把「不晚于它的记录」一律否决，下一次
 * 调用就会去换取新令牌。同一毫秒内由另一副本换出的令牌会被否决一次，实际链路上不可能（换取要一次往返）。
 */
let invalidatedThroughMs = 0;
/** 进行中的换取；并发 `ensureToken()` 共享它，实现单飞（失败时在 finally 里清空，不粘住）。 */
let inFlight: Promise<string> | null = null;

/** 测试用：清空本进程的令牌记忆，**保留共享存储**（用它模拟「另一个副本」或「进程刚重启」）。 */
export function resetUpstreamPatLocalStateForTests(): void {
  activePat = null;
  activePatCachedAtMs = 0;
  invalidatedThroughMs = 0;
  inFlight = null;
}

/** 测试用：连同共享存储一起复位（见 `resetUpstreamPatStoreForTests`）。 */
export function resetUpstreamPatForTests(): void {
  resetUpstreamPatLocalStateForTests();
}

/** 记录是否可用：已失效（不晚于水位）、已过期或剩余不足重建阈值时一律不可用。 */
function isUsable(record: UpstreamPatRecord, nowMs: number): boolean {
  if (record.createdAt <= invalidatedThroughMs) return false;
  return record.expiresAtMs - nowMs > timing.renewMarginMs;
}

/** 固定间隔轮询；只用于等待另一个副本发布令牌，不做无边界重试。 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 换取用的上游请求：固定 POST + JSON，超时覆盖到响应体读完为止。
 *
 * 不走 `upstream-client` 的理由见文件头（会成环，且本请求的失败语义是「凭据拿不到」而不是「业务调用失败」）。
 * 错误信息只含路径与超时预算，不含 Cookie 与令牌。
 */
async function postJsonRequest(input: {
  path: string;
  cookieHeader: string;
  body: unknown;
  timeoutMs: number;
}): Promise<{ status: number; text: string }> {
  const baseUrl = getWorkflowV2Config().upstreamBaseUrl;
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, input.timeoutMs);
  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}${input.path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: input.cookieHeader },
      body: JSON.stringify(input.body ?? {}),
      signal: controller.signal,
    });
    return { status: response.status, text: await response.text() };
  } catch (error) {
    if (timedOut) {
      throw new UpstreamSessionUnavailableError("timeout", `上游请求超时（${input.timeoutMs}ms，${input.path}）`);
    }
    throw new UpstreamSessionUnavailableError("network", `上游请求失败（${input.path}）`, error);
  } finally {
    clearTimeout(timer);
  }
}

/** 宽松 JSON 解析：上游的 panic 分支会返回纯文本，解析失败按「无业务码」处理。 */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 会话失效判定：HTTP 401（完全没带 Cookie）或业务码 700012006（键非法/被踢/过期）。
 *
 * 与 `upstream-client` 的同名判定同源同口径（那边判的是业务调用，这边判的是换取请求）；两处都不能放宽到
 * 「任何非 0 码」——参数错误触发重登会把会话搅成登录风暴。
 */
function isSessionFailure(response: { status: number; text: string }): boolean {
  return response.status === 401 || readBusinessCode(safeJson(response.text)) === UPSTREAM_AUTH_FAILED_CODE;
}

/** 读信封里的业务码（`{ code: 0 }` 是成功判定）。 */
function readBusinessCode(payload: unknown): number | undefined {
  if (typeof payload !== "object" || payload === null) return;
  const code = (payload as Record<string, unknown>).code;
  return typeof code === "number" ? code : undefined;
}

/** 读 `data.token`；形状不符或为空串时返回 null（缺失不是「空令牌」，而是失败）。 */
function readToken(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  const token = (data as Record<string, unknown>).token;
  return typeof token === "string" && token.length > 0 ? token : null;
}

/** 读 `data.personal_access_token.id`；缺失时为 null（没有它就只是没法吊销旧的，不影响这次换取）。 */
function readTokenId(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (typeof data !== "object" || data === null) return null;
  const pat = (data as Record<string, unknown>).personal_access_token;
  if (typeof pat !== "object" || pat === null) return null;
  const id = (pat as Record<string, unknown>).id;
  // 上游用字符串承载雪花 ID，但数值形态也能出现（Go 的 json 编码差异）：两种都接受，统一按字符串传回。
  if (typeof id === "string" && id.length > 0) return id;
  return typeof id === "number" ? String(id) : null;
}

/** 写本地缓存（含写入时刻）。 */
function cachePat(record: UpstreamPatRecord, nowMs: number): void {
  activePat = record;
  activePatCachedAtMs = nowMs;
}

/**
 * 从共享存储读一枚**可采纳**的令牌；没有就返回 null。
 *
 * 读失败由存储实现自己降级并告警，这里拿到的是「降级后的结果」，不重复记日志。
 */
async function readSharedPat(nowMs: number): Promise<UpstreamPatRecord | null> {
  const record = await getUpstreamPatStore().read();
  if (record === null) return null;
  return isUsable(record, nowMs) ? record : null;
}

/** 取当前可用令牌记录：本地缓存优先（未失效且在 TTL 内），否则读共享存储；**不触发换取**。 */
async function currentPat(): Promise<UpstreamPatRecord | null> {
  const now = Date.now();
  const cached = activePat;
  if (cached !== null && now - activePatCachedAtMs < timing.localCacheTtlMs && isUsable(cached, now)) return cached;
  return await readSharedPat(now);
}

/**
 * 尽力吊销一枚旧令牌。
 *
 * 轮换会产生新令牌，旧的那枚在上游仍然有效直到自然过期——留着它等于让「已不再使用的长期凭据」在对方的凭据
 * 列表里逐年累积（本平台一年会轮换十余次）。因此换取成功后顺手吊销被替换的那一枚。
 *
 * **永不抛错**：吊销失败不影响本次换取的结果（本副本已经拿到可用令牌），且旧令牌仍会按有效期自行过期；
 * 失败只留一行告警供运维兜底。
 */
async function revokePat(tokenId: string, cookieHeader: string): Promise<void> {
  try {
    const response = await postJsonRequest({
      path: DELETE_PATH,
      cookieHeader,
      body: { id: tokenId },
      timeoutMs: getWorkflowV2Config().upstreamTimeoutMs,
    });
    const code = readBusinessCode(safeJson(response.text));
    if (response.status !== 200 || code !== 0) {
      logger.warn("平台 PAT 旧令牌吊销被拒", { status: response.status, code });
    }
  } catch (error) {
    logger.warn("平台 PAT 旧令牌吊销失败，旧令牌将在上游自然过期", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 换取一枚新 PAT：以平台账号会话调上游，成功时写共享存储与本地缓存，并尽力吊销被替换的旧令牌。
 *
 * 到期时间按「换取时刻 + 申请天数」本地推算（理由见文件头）；`createdAt` 同时是失效水位的比较基准。
 */
async function createPat(): Promise<string> {
  const config = getWorkflowV2Config();
  const session = getUpstreamSession();
  // 被替换的那一枚：优先用本地缓存，其次读共享存储（另一个副本可能刚换过）；**不做可用性筛选**——
  // 只要上游还有这么一枚，就该在换成新的之后把它吊销掉。
  const previous = activePat ?? (await getUpstreamPatStore().read());

  const exchange = async (): Promise<{ status: number; text: string }> => {
    try {
      return await postJsonRequest({
        path: CREATE_PATH,
        cookieHeader: await session.ensureCookie(),
        body: { name: PAT_NAME, duration_day: String(PAT_DURATION_DAYS) },
        timeoutMs: config.upstreamTimeoutMs,
      });
    } catch (error) {
      const failure =
        error instanceof UpstreamSessionUnavailableError
          ? error
          : new UpstreamSessionUnavailableError("network", `PAT 换取请求失败（${CREATE_PATH}）`, error);
      logger.warn("平台 PAT 换取失败", { reason: failure.reason });
      throw failure;
    }
  };

  let response = await exchange();
  if (isSessionFailure(response)) {
    // 会话被上游判定失效（另一处登录踢键、会话过期）时重登一次再换取。
    //
    // 为什么必须在这里补这一步：换取走的是**会话面**，而会话面的「失效 → 重登」判定只发生在 `callUpstream`
    // 里（`sendAuthenticatedRequest`）。不补的话，一旦会话被踢，整条对外触发会持续 503（`PLATFORM_SESSION_
    // UNAVAILABLE`），直到某次控制面请求顺手把它重登回来——对外接口的可用性不该依赖另一个面是否有流量。
    logger.warn("平台 PAT 换取遇到失效会话，重登后重试一次", { status: response.status });
    session.invalidate();
    response = await exchange();
  }

  const parsed = safeJson(response.text);
  const code = readBusinessCode(parsed);
  if (response.status !== 200 || code !== 0) {
    // 不回显响应正文（可能含账号信息），只报状态与业务码。
    logger.warn("平台 PAT 换取被上游拒绝", { status: response.status, code });
    throw new UpstreamSessionUnavailableError(
      "rejected",
      `PAT 换取被上游拒绝（HTTP ${response.status}${code === undefined ? "" : `，code=${code}`}）`,
    );
  }

  const token = readToken(parsed);
  if (token === null) {
    logger.warn("平台 PAT 换取响应缺少令牌", { status: response.status });
    throw new UpstreamSessionUnavailableError("rejected", `PAT 换取响应缺少令牌（HTTP ${response.status}）`);
  }

  const createdAt = Date.now();
  const tokenId = readTokenId(parsed);
  const record: UpstreamPatRecord = {
    token,
    tokenId,
    createdAt,
    expiresAtMs: createdAt + PAT_DURATION_DAYS * 24 * 60 * 60 * 1000,
  };
  cachePat(record, createdAt);
  try {
    await getUpstreamPatStore().write(record);
  } catch (error) {
    // 存储实现内部已降级并告警；这里兜底的是「它自己抛了」的意外路径——共享存储失败不该让换取结果作废
    // （本副本已经拿到可用令牌），但必须留下诊断上下文。
    logger.warn("平台 PAT 写入共享存储失败，仅本副本可用", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  // 只记事实，不记令牌值与令牌 ID。
  logger.info("平台 PAT 换取成功", { durationDays: PAT_DURATION_DAYS });
  if (previous !== null && previous.tokenId !== null && previous.tokenId !== tokenId) {
    await revokePat(previous.tokenId, await session.ensureCookie());
  }
  return token;
}

/**
 * 等待另一个副本把令牌写进共享存储（租约 + 轮询，避免多副本各换一枚）。
 *
 * 拿不到就返回 null：调用方据此决定「抢一次租约自己换」还是如实失败，不在本函数里做无边界重试。
 */
async function waitForPublishedPat(): Promise<UpstreamPatRecord | null> {
  const deadline = Date.now() + timing.waitMs;
  while (Date.now() < deadline) {
    await sleep(timing.pollIntervalMs);
    const record = await readSharedPat(Date.now());
    if (record !== null) {
      cachePat(record, Date.now());
      logger.info("平台 PAT 由其它副本发布，本副本直接复用", { createdAt: record.createdAt });
      return record;
    }
  }
  return null;
}

/**
 * 单飞换取（含跨副本租约）：
 * 1. **进程内单飞**：并发 `ensureToken()` 共享同一个 in-flight Promise；
 * 2. **跨副本租约**：只有拿到租约的副本换取，其它副本在 `timing.waitMs` 内轮询共享存储；
 * 3. **有界重试**：等不到就再抢一次租约自己换，仍抢不到才如实抛 `busy`——不做第三次尝试。
 */
async function acquirePatWithLease(): Promise<string> {
  const store = getUpstreamPatStore();
  if (!(await store.acquireLease())) {
    const adopted = await waitForPublishedPat();
    if (adopted !== null) return adopted.token;
    // 租约持有者可能已失败或崩溃：再抢一次自己换，仍抢不到才如实失败。
    if (!(await store.acquireLease())) {
      throw new UpstreamSessionUnavailableError(
        "busy",
        `另一个副本正在换取平台令牌，等待窗口（${timing.waitMs}ms）内未发布`,
      );
    }
  }

  try {
    return await createPat();
  } finally {
    await store.releaseLease();
  }
}

/** 单飞包装：并发调用共享同一次换取（见 `acquirePatWithLease` 的三层收口）。 */
async function acquirePat(): Promise<string> {
  if (inFlight !== null) return await inFlight;
  const attempt: Promise<string> = acquirePatWithLease().finally(() => {
    // 只清自己这一轮：换取期间若又发生 invalidate + 新一轮换取，不能把新句柄误清掉。
    if (inFlight === attempt) inFlight = null;
  });
  inFlight = attempt;
  return await attempt;
}

/** 取可用 PAT；没有可用记录即单飞换取。 */
async function ensureToken(): Promise<string> {
  const current = await currentPat();
  if (current !== null) return current.token;
  return await acquirePat();
}

/**
 * 丢弃当前令牌，使下一次 `ensureToken()` 重新换取。
 *
 * 水位取「当前记录（含本地缓存与共享记录）的创建时刻」：即使 Redis 里的旧值删不掉，也不会被再次采纳。
 */
function invalidate(): void {
  const current = activePat;
  if (current !== null) invalidatedThroughMs = Math.max(invalidatedThroughMs, current.createdAt);
  activePat = null;
  activePatCachedAtMs = 0;
  void getUpstreamPatStore()
    .clear()
    .catch((error: unknown) => {
      // 清不掉不影响正确性（水位仍会否决旧值），但必须留下诊断上下文。
      logger.warn("平台 PAT 共享记录清理失败", { error: error instanceof Error ? error.message : String(error) });
    });
}

const pat: UpstreamPat = { ensureToken, invalidate };

/** 取平台 PAT 单例（进程内唯一持有者；模块加载期不发请求）。 */
export function getUpstreamPat(): UpstreamPat {
  return pat;
}
