/**
 * 画布票据（iframe 与宿主之间的凭据链）。
 *
 * 链路（冻结 §7）：宿主页 `POST /web/workflow-v2/iframe-code`（会话鉴权）拿到**一次性 code**，经
 * `postMessage` 下发给画布（不放 iframe URL：URL 会进 referrer、历史与代理日志）→ 画布
 * `POST /workflow-canvas/bff/session/exchange` 把 code 换成**短期 ticket** → 后续透传请求以
 * `X-Fenix-Workflow-Ticket` 携带。
 *
 * 不变量：
 * - code 绑定 user + org + workflow，单次消费，TTL 取 `config.codeTtlSeconds`（默认 60s）；重复兑换、过期、
 *   跨实例未知一律返回 null（不区分原因，避免探测）；
 * - ticket 是 HMAC-SHA256 签名载荷（密钥 `config.ticketSecret`），claims 形状即冻结 §4 的 `TicketClaims`；
 * - `jti` 去重表与 `sid` 撤销表都在**进程内存**里：单副本部署自洽，多副本需要共享存储或粘性会话
 *   （设计 §9 待验证清单）；重启即失效，未过期的旧票据不会因此获得第二次生命；
 * - 续期（`/session/refresh`）的新过期时间取「原 `exp`」与「不超过 15 分钟」的较小者，不得凭续期延长会话；
 * - code 与 ticket 都是凭据材料：不进日志、不进错误响应、不进审计表。
 *
 * 实现口径（1C，两处按上文不变量自行收口）：
 * - **`jti` 去重是「jti ↔ 唯一载荷」的绑定，不是「一次性消费」**：画布的每个透传请求都带同一张票据，
 *   若把首次验签当作消费，BFF 的第二个请求就会自锁。签发时登记 `jti` 与载荷指纹，验签时要求二者一致，
 *   于是用同一 `jti` 另签/改写出的第二张票据（重放）一律被拒，而同一张票据的重复出示照常通过；
 * - 同一张登记表兼具**票据白名单**语义：本进程没签发过的 `jti`（重启后、其它副本、手工构造）全部拒绝，
 *   这既让「重启后未过期的旧票据不会复活」成立，也让撤销不依赖任何记录的保留期；代价与 1A 的口径一致
 *   ——多副本必须粘性会话或共享存储。两份内存表都由公开入口惰性回收已过期项，无定时器、无无界增长。
 */

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { getWorkflowV2Config } from "../config";

export interface TicketClaims {
  /** 票据用途标识；固定 `wf-canvas`，防止本包票据被复用到其它协议面。 */
  typ: "wf-canvas";
  /** 会话（票据族）标识；`revokeSession(sid)` 按它整族撤销。 */
  sid: string;
  /** 我方用户 ID（`sub`）。 */
  sub: string;
  /** 我方组织 ID；归属校验以它为准（`claims.org` 与本地注册表都要命中）。 */
  org: string;
  /** 上游 workflow ID；必须与显式 `workflow_id`/路径参数一致（冻结 §6）。 */
  wf: string;
  /** 签发时间（Unix 秒）。 */
  iat: number;
  /** 过期时间（Unix 秒）。 */
  exp: number;
  /** 票据唯一标识；用于重放去重与审计关联（审计只记 jti，不记票据本体）。 */
  jti: string;
}

/** 已签发的一次性 code 的内存记录；`sid` 在签发时定下，兑换出的票据继承它。 */
interface PendingCode {
  readonly userId: string;
  readonly orgId: string;
  readonly workflowId: string;
  readonly sid: string;
  readonly expiresAtMs: number;
}

/** 已登记票据：把 `jti` 绑死到唯一载荷，并给出回收所需的过期时刻。 */
interface IssuedTicket {
  readonly sid: string;
  /** 载荷指纹（SHA-256，base64url）。只存指纹不存载荷，免在内存里多留一份凭据材料。 */
  readonly payloadFingerprint: string;
  readonly expiresAtMs: number;
}

/** 惰性回收的最小间隔（毫秒）：把清理成本摊到正常流量上，不引入常驻定时器。 */
const SWEEP_INTERVAL_MS = 30_000;

/** 时钟偏差容忍（秒）：拒绝「签发时间落在未来」的票据（时钟回拨或跨副本偏差），但不给已过期票据开窗口。 */
const CLOCK_SKEW_SECONDS = 60;

/** 待兑换的一次性 code；`redeemCode` 先删后签，同步执行因而天然单次消费。 */
const pendingCodes = new Map<string, PendingCode>();

/** 已登记票据（key 为 `jti`）：既是 `jti` 去重绑定，也是「本进程签发过」的白名单。 */
const issuedTickets = new Map<string, IssuedTicket>();

/** 已撤销会话（key 为 `sid`）：值是该撤销记录的保留截止（毫秒），不早于本族任何票据可能存在的时刻。 */
const revokedSessions = new Map<string, number>();

let lastSweepAtMs = 0;

/** 惰性清理三张内存表里已过期的项；过期项本就不参与任何判定，回收只影响内存占用。 */
function sweepExpired(nowMs: number): void {
  if (nowMs - lastSweepAtMs < SWEEP_INTERVAL_MS) return;
  lastSweepAtMs = nowMs;
  for (const [code, record] of pendingCodes) {
    if (record.expiresAtMs <= nowMs) pendingCodes.delete(code);
  }
  for (const [jti, record] of issuedTickets) {
    if (record.expiresAtMs <= nowMs) issuedTickets.delete(jti);
  }
  for (const [sid, keepUntilMs] of revokedSessions) {
    if (keepUntilMs <= nowMs) revokedSessions.delete(sid);
  }
}

/**
 * 取签名密钥。
 *
 * 唯一来源是模块配置 `ticketSecret`（声明侧 `WORKFLOW_V2_TICKET_SECRET` 必填）。这里再断言一次：**不得
 * 退化成内置默认密钥**——那会让所有部署共享同一把可推导的密钥，签署方与验证方都会静默接受伪造票据。
 * 密钥材料只在本函数返回值上流转，调用方、日志与错误文案都不得回显它。
 */
function getSigningKey(): string {
  const secret = getWorkflowV2Config().ticketSecret;
  if (!secret) throw new Error("workflow-v2 画布票据缺少签名密钥：模块配置 ticketSecret 为空");
  return secret;
}

/** HMAC-SHA256（base64url）签名载荷。 */
function signPayload(encodedPayload: string, key: string): string {
  return createHmac("sha256", key).update(encodedPayload).digest("base64url");
}

/** 载荷指纹：把 `jti` 绑到唯一载荷，同时避免保存凭据本体。 */
function fingerprintPayload(encodedPayload: string): string {
  return createHash("sha256").update(encodedPayload).digest("base64url");
}

/** 载荷形状校验：字段齐全且类型正确；缺字段、空串或类型漂移一律视为不可信票据。 */
function isTicketClaims(payload: unknown): payload is TicketClaims {
  if (typeof payload !== "object" || payload === null) return false;
  const claims = payload as Record<string, unknown>;
  const isNonEmptyString = (value: unknown): value is string => typeof value === "string" && value.length > 0;
  const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  return (
    claims.typ === "wf-canvas" &&
    isNonEmptyString(claims.sid) &&
    isNonEmptyString(claims.sub) &&
    isNonEmptyString(claims.org) &&
    isNonEmptyString(claims.wf) &&
    isFiniteNumber(claims.iat) &&
    isFiniteNumber(claims.exp) &&
    isNonEmptyString(claims.jti)
  );
}

/**
 * 铸造并登记一张票据。
 *
 * `exp` 由调用方给定（兑换＝now + TTL，续期＝原 `exp` 与 now + TTL 的较小者）。登记与返回必须同属一次
 * 同步执行：`verifyTicket` 以登记表为准，拆成异步步骤会留出「票据已返回但尚不可验」的窗口。
 */
function mintTicket(
  bound: { sid: string; userId: string; orgId: string; workflowId: string },
  expSeconds: number,
  nowMs: number,
): { ticket: string; expiresAt: number; claims: TicketClaims } {
  const key = getSigningKey();
  const claims: TicketClaims = {
    typ: "wf-canvas",
    sid: bound.sid,
    sub: bound.userId,
    org: bound.orgId,
    wf: bound.workflowId,
    iat: Math.floor(nowMs / 1000),
    exp: expSeconds,
    jti: randomUUID(),
  };
  const encodedPayload = Buffer.from(JSON.stringify(claims), "utf-8").toString("base64url");
  issuedTickets.set(claims.jti, {
    sid: claims.sid,
    payloadFingerprint: fingerprintPayload(encodedPayload),
    expiresAtMs: claims.exp * 1000,
  });
  return { ticket: `${encodedPayload}.${signPayload(encodedPayload, key)}`, expiresAt: claims.exp, claims };
}

/** 签发一次性 code（绑定当前用户、组织与 workflow）；TTL 取模块配置的 `codeTtlSeconds`。 */
export function issueCode(input: { userId: string; orgId: string; workflowId: string }): {
  code: string;
  expiresIn: number;
} {
  const nowMs = Date.now();
  sweepExpired(nowMs);
  // 身份必须来自已鉴权的上下文：空值意味着调用方把未认证输入当成身份用了，宁可抛错也不能签发绑定空身份的凭据。
  for (const [field, value] of [
    ["userId", input.userId],
    ["orgId", input.orgId],
    ["workflowId", input.workflowId],
  ] as const) {
    if (!value) throw new Error(`workflow-v2 签发画布 code 需要非空 ${field}`);
  }

  const { codeTtlSeconds } = getWorkflowV2Config();
  const code = randomBytes(32).toString("base64url");
  pendingCodes.set(code, {
    userId: input.userId,
    orgId: input.orgId,
    workflowId: input.workflowId,
    sid: randomUUID(),
    expiresAtMs: nowMs + codeTtlSeconds * 1000,
  });
  return { code, expiresIn: codeTtlSeconds };
}

/** 兑换一次性 code：成功返回新票据与 `expiresAt`（Unix 秒，与 `claims.exp` 同值），失败（未知、已用、过期）返回 null。 */
export function redeemCode(code: string): { ticket: string; expiresAt: number; claims: TicketClaims } | null {
  const nowMs = Date.now();
  sweepExpired(nowMs);
  const record = pendingCodes.get(code);
  // 未知、已消费与已过期同形返回：不给调用方按错误区分「code 是否存在」的探测面。
  if (!record) return null;
  // 先删后签：本函数全程同步，删除即完成单次消费，不存在两个并发请求都兑换成功的窗口。
  pendingCodes.delete(code);
  if (record.expiresAtMs <= nowMs) return null;

  const expSeconds = Math.floor(nowMs / 1000) + getWorkflowV2Config().ticketTtlSeconds;
  return mintTicket(
    { sid: record.sid, userId: record.userId, orgId: record.orgId, workflowId: record.workflowId },
    expSeconds,
    nowMs,
  );
}

/** 校验票据签名、`typ`、有效期、撤销状态与 `jti` 绑定；任一不满足返回 null。 */
export function verifyTicket(ticket: string): TicketClaims | null {
  const nowMs = Date.now();
  sweepExpired(nowMs);
  // 不做「缺密钥即返回 null」的降级：缺密钥是部署事故，抛错才能让它暴露，静默返回 null 会把所有票据
  // 判成无效并让调用方误以为只是凭据过期。
  const key = getSigningKey();

  const [encodedPayload, signature, extra] = ticket.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return null;

  // 固定时间比较；长度不等直接判否（timingSafeEqual 对不等长输入会抛错）。
  const expected = Buffer.from(signPayload(encodedPayload, key));
  const provided = Buffer.from(signature);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (!isTicketClaims(payload)) return null;

  const nowSeconds = Math.floor(nowMs / 1000);
  if (payload.exp <= nowSeconds) return null;
  // 容忍 ±60s 时钟偏差：只拦「签发时间落在未来」的票据（时钟回拨或跨副本偏差），不给已过期票据开窗口。
  if (payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return null;

  const revokedUntilMs = revokedSessions.get(payload.sid);
  if (revokedUntilMs !== undefined && revokedUntilMs > nowMs) return null;

  const issued = issuedTickets.get(payload.jti);
  // `jti` 未登记（重启后、其它副本、手工构造的票据）或与登记载荷不符（同一 jti 的第二张票据）一律拒绝。
  // 同一张票据的多请求鉴权命中的是同一条登记项，因此照常通过——这是 BFF 每请求验签能够工作的前提。
  if (!issued) return null;
  if (issued.payloadFingerprint !== fingerprintPayload(encodedPayload)) return null;

  return payload;
}

/** 按会话标识撤销整族票据（登出、切组织时由宿主调用）。 */
export function revokeSession(sid: string): void {
  const nowMs = Date.now();
  sweepExpired(nowMs);
  if (!sid) return;

  const { ticketTtlSeconds } = getWorkflowV2Config();
  // 记录保留到「本族最晚可能存在的票据过期」之后：签发时 exp ≤ now + ttl，加上时钟偏差即上界，
  // 因此没有「撤销记录先被回收、票据随后复活」的窗口。
  const keepUntilMs = nowMs + (ticketTtlSeconds + CLOCK_SKEW_SECONDS) * 1000;
  revokedSessions.set(sid, Math.max(revokedSessions.get(sid) ?? 0, keepUntilMs));
  // 同时摘掉本族已登记的 jti：撤销立即生效，不依赖上面那条记录的保留期。
  for (const [jti, record] of issuedTickets) {
    if (record.sid === sid) issuedTickets.delete(jti);
  }
}

/**
 * 续签票据（`POST /workflow-canvas/bff/session/refresh` 的实现面，冻结 §7；1D 消费本函数）。
 *
 * 原票据验签通过后重签一张同 `sid`、新 `jti` 的票据，`exp` 取「原 `exp`」与「now + ticketTtlSeconds」的
 * 较小者——续期只能缩短、不能延长会话。已撤销或未登记的票据连验签都过不了，因此不能借续签绕过撤销。
 *
 * 旧票据按其原 `exp` 自然过期，这里不主动作废：画布的续期发生在过期前 2 分钟，同一时刻可能还有在途
 * 请求带着旧票据，立刻作废会把它们打成 401，触发一轮无谓的重新握手。
 */
export function refreshTicket(ticket: string): { ticket: string; expiresAt: number; claims: TicketClaims } | null {
  const claims = verifyTicket(ticket);
  if (!claims) return null;

  const nowMs = Date.now();
  const expSeconds = Math.min(claims.exp, Math.floor(nowMs / 1000) + getWorkflowV2Config().ticketTtlSeconds);
  return mintTicket(
    { sid: claims.sid, userId: claims.sub, orgId: claims.org, workflowId: claims.wf },
    expSeconds,
    nowMs,
  );
}
