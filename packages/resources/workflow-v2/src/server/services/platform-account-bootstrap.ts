/**
 * 平台上游账号的引导：确保账号存在（不存在则自助注册）、登录一次、取账号身份与个人空间、落进
 * `workflow_v2_platform_account`。
 *
 * 职责边界：本文件只回答「平台账号当前是谁、空间在哪」并把它持久化——会话的持有/单飞重登/探活在
 * `upstream-session`，常规上游请求在 `upstream-client`，注册的报文与业务码判定在 `platform-account-registration`，
 * 本文件不复制其中任何一件。**注册步骤的编排放在本文件**：它是「首启」这一语义的持有者，只有它知道自己代表
 * 「台账无行、要现场确定账号身份」，因此也只有它能保证注册只发生在引导路径（见 {@link bootstrapPlatformAccount}）。
 * 租户 App 的创建（2A 的另一半）需要本文件给出的 `platformSpaceId`，因此在建 App 前调用 {@link ensurePlatformAccount}。
 *
 * 凭据边界（设计 §3.1）：邮箱可入库（身份信息，非密钥材料），**密码与会话值绝不入库**——`session_key`
 * 只存在于 `upstream-session` 的进程内存里。本文件的日志与错误文案只含状态标签与上游业务码，不含邮箱、
 * 密码、会话值或上游响应原文。
 *
 * 单行不变式：平台账号表是单行表。引导**就地更新**已存在的那一行（含账号身份变更：换邮箱重新注册后
 * 用户 ID 会变），只在表为空时插入——不做删旧行的「先删后插」，那会在他方读取的窗口里制造空窗，也会
 * 误伤库里既有的行。并发首次引导由 `platform_user_id` 唯一索引 + `ON CONFLICT DO UPDATE` 收敛，与
 * `findPlatformAccount` / `repositories/tenant-binding-repository.ts` 的「按创建时间取首行」读取口径一致。
 *
 * 持久化直接落在本文件：`repositories/**` 是 2B 的文件域（冻结 §1 的 owner 表），本任务不越界新增仓储
 * 文件；读写用的是同一份行形状，出现第二个消费方时再抽仓储。
 */

import { createLogger } from "@fenix/logger";
import { workflowV2PlatformAccount } from "@fenix/resource-workflow-v2/db";
import { asc, eq } from "drizzle-orm";
import { getWorkflowV2Config } from "../config";
import { getWorkflowV2Database } from "../repositories/database";
import { type PlatformAccountRegistrationOutcome, registerPlatformAccount } from "./platform-account-registration";
import { callUpstream } from "./upstream-client";
import { getUpstreamSession, getUpstreamSessionStatus } from "./upstream-session";

const logger = createLogger("wf2-platform-account");

/** 空间列表端点；实测无业务参数、无副作用（契约快照 §2 第 3 行），也是会话探活用的同一端点。 */
const SPACE_LIST_PATH = "/api/playground_api/space/list";

/**
 * 账号状态：`active` = 最近一次引导成功，`degraded` = 最近一次引导失败。
 *
 * 它是观测信号，不是写路径的短路条件：会话是否可用由 `upstream-client` 的鉴权失败分支（invalidate + 单飞重登）
 * 在每次调用上判定；拿一次引导的陈旧结果去拒绝请求，会把瞬时故障放大成需要人工介入的停机。
 */
export type PlatformAccountStatus = "active" | "degraded";

export interface PlatformAccountSnapshot {
  readonly platformUserId: string;
  /** 平台个人空间 ID；建租户 App 与创建 workflow 时的 `space_id` 注入源。 */
  readonly platformSpaceId: string;
  readonly email: string;
  readonly status: PlatformAccountStatus;
  readonly lastLoginAt: Date | null;
  readonly lastProbeAt: Date | null;
  /** 最后一次降级原因标签；不得含凭据或上游响应原文。 */
  readonly lastError: string | null;
}

/** 引导失败的原因标签；只由固定的几类失败构成，可安全进日志与错误文案。 */
export type PlatformAccountBootstrapReason =
  /** 登录被拒或请求未能完成（会话模块的 reason 标签已归入 cause）。 */
  | "session_unavailable"
  /**
   * 上游禁止自助注册，且账号也登录不上。
   *
   * 与 `session_unavailable` 分开是因为运维动作不同：这一档要么人工建号，要么打开上游的注册开关；而「登录失败」
   * 通常只是凭据或会话问题。注意注册被禁**不必然**导致失败——账号本来就存在时登录照常成功（见
   * {@link bootstrapPlatformAccount}），这一档只在登录也失败时才给。
   */
  | "registration_disabled"
  /** 自助注册未成功（未知业务码 / 超时 / 网络），且账号也登录不上；具体类别在错误 cause 与日志里。 */
  | "registration_failed"
  /** 登录响应没有回显上游用户 ID，无法确定账号身份（不臆造，宁可失败）。 */
  | "missing_user_id"
  /** 空间列表请求失败，或响应里没有可用的个人空间。 */
  | "space_unavailable"
  /** 账号行写入失败。 */
  | "persist_failed";

export class PlatformAccountBootstrapError extends Error {
  readonly code = "PLATFORM_ACCOUNT_BOOTSTRAP_FAILED";

  constructor(
    readonly reason: PlatformAccountBootstrapReason,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PlatformAccountBootstrapError";
  }
}

/** 表行 → 快照；`status` 列是自由文本，按契约收窄成两态（未知值视为 degraded，最小信任）。 */
function toSnapshot(row: typeof workflowV2PlatformAccount.$inferSelect): PlatformAccountSnapshot {
  return {
    platformUserId: row.platformUserId,
    platformSpaceId: row.platformSpaceId,
    email: row.email,
    status: row.status === "active" ? "active" : "degraded",
    lastLoginAt: row.lastLoginAt,
    lastProbeAt: row.lastProbeAt,
    lastError: row.lastError,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 业务码读取：上游返回 number；字符串形式的 `"0"` 不算成功（与 `upstream-session` 同一口径）。 */
function readBusinessCode(body: unknown): number | undefined {
  if (!isRecord(body)) return;
  return typeof body.code === "number" ? body.code : undefined;
}

/** 上游的 ID 在 JSON 里按 `,string` 序列化，但个别端点回数字；两种形态都接受，其余一律不算。 */
function readId(value: unknown): string | null {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * 取个人空间 ID。
 *
 * 任务给的口径是 `data.bot_space_list[0].id`（单账号只属于个人空间时成立）。这里按 IDL 的
 * `space_type === 1`（Personal，见上游 `backend/api/model/playground/playground.go`）优先挑个人空间，
 * 挑不到再回退首个条目：账号一旦被拉进团队空间，`[0]` 可能不再是个人空间，而设计 §3.1 要求所有租户
 * App 都落在个人空间里，选错会让租户资源散进团队空间。
 */
function pickPersonalSpaceId(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const data = isRecord(body.data) ? body.data : null;
  if (data === null || !Array.isArray(data.bot_space_list)) return null;
  const entries = data.bot_space_list.filter(isRecord);
  const personal = entries.find((entry) => entry.space_type === 1);
  return readId((personal ?? entries[0])?.id ?? null);
}

/** 取「按创建时间最早的一行」；与 `tenant-binding-repository` 的单行读取口径一致（表本应只有一行）。 */
async function findPlatformAccountRow(): Promise<typeof workflowV2PlatformAccount.$inferSelect | null> {
  const [row] = await getWorkflowV2Database()
    .select()
    .from(workflowV2PlatformAccount)
    .orderBy(asc(workflowV2PlatformAccount.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * 读取平台账号快照；表为空时返回 null（尚无账号身份，调用方应引导一次）。
 *
 * 只读、不出站：控制面读接口不得因为「顺便」而登录或探活（冻结 §4.3 的只读语义）。
 */
export async function findPlatformAccount(): Promise<PlatformAccountSnapshot | null> {
  const row = await findPlatformAccountRow();
  return row ? toSnapshot(row) : null;
}

/**
 * 标记账号为 degraded 并记下降级原因（表里没有原因列，原因只进日志）。
 *
 * 只在引导失败的路径上调用，且**永不抛错**：调用方此时已在处理原始失败，降级标记再失败只会掩盖它；
 * 写失败进 error 日志，由运维从日志侧发现。
 */
async function markPlatformAccountDegraded(reason: string): Promise<void> {
  try {
    await getWorkflowV2Database()
      .update(workflowV2PlatformAccount)
      .set({ status: "degraded", lastError: reason, updatedAt: new Date() });
    logger.warn("workflow-v2 平台账号置为 degraded", { reason });
  } catch (error) {
    logger.error("workflow-v2 平台账号降级标记写入失败", {
      reason,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * 登录失败时的最终原因与文案：注册侧有异常（被禁 / 未完成）就由它定性，否则按原有的 `session_unavailable`。
 *
 * 为什么注册侧优先：登录被拒的唯一码 `700000003` 把「邮箱不存在」与「密码错误」糊在同一档（上游
 * `ErrUserInfoInvalidateCode`），而引导路径上注册侧的结果能把这个歧义拆开——账号很可能根本不存在，而它没被建出来
 * 是因为注册被禁或注册请求没成功。两种文案都只含固定标签与业务码 / 传输类别，不含邮箱、密码与会话值。
 *
 * `created` 仍归 `session_unavailable`（不新增原因档：原因是导出类型，另一条泳道的文档在逐项列举它），但在文案里
 * 写明「本次引导刚建号」——它和「已有账号凭据不符」的运维动作不同（前者要查上游注册/登录的密码口径，后者要改
 * env 凭据），而这一差异只出现在错误文案里，不外扩到原因枚举。
 */
function describeLoginFailure(registration: PlatformAccountRegistrationOutcome): {
  reason: PlatformAccountBootstrapReason;
  message: string;
} {
  if (registration.kind === "registration_disabled") {
    return {
      reason: "registration_disabled",
      message: `上游禁止注册（code=${registration.upstreamCode}，DISABLE_USER_REGISTRATION 已开启），且账号登录失败`,
    };
  }
  if (registration.kind === "failed") {
    return {
      reason: "registration_failed",
      message: `自助注册未完成（${registration.detail}），且账号登录失败`,
    };
  }
  if (registration.kind === "created") {
    return { reason: "session_unavailable", message: "本次引导刚自助注册成功，但用同一对凭据登录仍失败" };
  }
  return { reason: "session_unavailable", message: "平台上游账号登录失败" };
}

/**
 * 引导平台账号：确保账号存在、登录、取用户 ID 与个人空间 ID、写入账号行。
 *
 * 「确保账号存在」= 先调注册接口（邮箱已存在按成功处理），再走原有登录链路。幂等：**顺次**重复执行时注册侧只会
 * 拿到 `700000001`，账号行则就地更新（账号身份变更时一并改写 `platform_user_id`），都不会写出第二份。
 *
 * **注册只在本文件发生**：调用方是「台账无行」的首次使用路径（{@link ensurePlatformAccount} 与租户 App 创建），
 * 常规登录失败路径（`upstream-client` 的鉴权失败分支、`upstream-session.login()`）不触达注册——否则 env 里邮箱写错会凭空
 * 建出垃圾账号。多副本同时首启时两个副本各注册一次：顺次时后者拿到 `already_exists`，真正并发时后者撞上游
 * `user.uniq_email` 唯一索引、只拿到 HTTP 500 而落进 `failed`——两种情形下账号都已由另一方建出，随后的登录照常
 * 成功，引导不因此失败（只多一条告警日志）。登录自身由 `upstream-session` 的登录租约收敛（上游单会话，两个副本同时
 * 登录会互相踢键，见设计 §9.1.1 第 3 条）。
 *
 * 注册结果不单独决定成败：账号可能是人工建的，注册被禁或注册请求失败都不影响登录。这两档先记告警，只有登录也
 * 失败时才升格为最终原因（见 {@link describeLoginFailure}）——「人工建号 + 上游关注册」的既有部署因此照常工作。
 */
export async function bootstrapPlatformAccount(): Promise<PlatformAccountSnapshot> {
  const config = getWorkflowV2Config();

  const registration = await registerPlatformAccount();
  // 四种结果都在这里留痕（日志只含结果标签与业务码 / 传输类别，不含邮箱与密码）；被禁与未完成按告警记，
  // 因为它们是「账号可能压根没建出来」的早期信号，即便随后登录成功也值得运维看见。
  switch (registration.kind) {
    case "created":
      logger.info("workflow-v2 平台账号自助注册成功");
      break;
    case "already_exists":
      logger.info("workflow-v2 平台账号已存在，无需建号");
      break;
    case "registration_disabled":
      logger.warn("workflow-v2 上游禁止自助注册，继续尝试登录", { upstreamCode: registration.upstreamCode });
      break;
    case "failed":
      logger.warn("workflow-v2 自助注册未完成，继续尝试登录", {
        detail: registration.detail,
        // 传输类失败的底层消息（连接被拒 / DNS 失败等）是排障的关键上下文，且不含 URL、请求体与密码；
        // 业务码类失败没有 cause，留空即可。
        error: registration.cause instanceof Error ? registration.cause.message : undefined,
      });
      break;
  }

  try {
    await getUpstreamSession().ensureCookie();
  } catch (error) {
    const failure = describeLoginFailure(registration);
    await markPlatformAccountDegraded(failure.reason);
    throw new PlatformAccountBootstrapError(failure.reason, failure.message, { cause: error });
  }

  // 用户 ID 取登录响应回显的 `data.user_id_str`（经会话模块投影）；缺失即无法确定账号身份。
  const platformUserId = getUpstreamSessionStatus().platformUserId;
  if (platformUserId === null) {
    await markPlatformAccountDegraded("missing_user_id");
    throw new PlatformAccountBootstrapError("missing_user_id", "登录响应未回显上游用户 ID，无法确定账号身份");
  }

  let spaceResult: Awaited<ReturnType<typeof callUpstream>>;
  try {
    spaceResult = await callUpstream({ path: SPACE_LIST_PATH, body: {} });
  } catch (error) {
    await markPlatformAccountDegraded("space_unavailable");
    throw new PlatformAccountBootstrapError("space_unavailable", "读取上游空间列表失败", { cause: error });
  }
  const platformSpaceId = readBusinessCode(spaceResult.body) === 0 ? pickPersonalSpaceId(spaceResult.body) : null;
  if (platformSpaceId === null) {
    logger.error("workflow-v2 未取到平台个人空间", {
      upstreamStatus: spaceResult.status,
      upstreamCode: readBusinessCode(spaceResult.body),
    });
    await markPlatformAccountDegraded("space_unavailable");
    throw new PlatformAccountBootstrapError("space_unavailable", "上游空间列表里没有可用的个人空间");
  }

  const now = new Date();
  const values = {
    platformUserId,
    platformSpaceId,
    email: config.accountEmail,
    status: "active" as const,
    lastLoginAt: now,
    lastError: null,
    updatedAt: now,
  };
  try {
    const existing = await findPlatformAccountRow();
    const db = getWorkflowV2Database();
    if (existing) {
      await db.update(workflowV2PlatformAccount).set(values).where(eq(workflowV2PlatformAccount.id, existing.id));
    } else {
      // 并发首次引导同时候选：唯一索引兜底，冲突后按同一份值更新（两边算出的身份一致）。
      await db
        .insert(workflowV2PlatformAccount)
        .values(values)
        .onConflictDoUpdate({ target: workflowV2PlatformAccount.platformUserId, set: values });
    }
  } catch (error) {
    throw new PlatformAccountBootstrapError("persist_failed", "平台账号行写入失败", { cause: error });
  }

  const persisted = await findPlatformAccount();
  if (persisted === null) {
    throw new PlatformAccountBootstrapError("persist_failed", "平台账号行写入后读不到");
  }
  logger.info("workflow-v2 平台账号引导完成", { platformUserId, platformSpaceId });
  return persisted;
}

/**
 * 取平台账号；缺失时现场引导一次（租户 App 创建等「首次使用」路径的入口）。
 *
 * 已有账号行时不重复登录：会话有效性由 `upstream-client` 的鉴权失败分支与 `upstream-session.probe()` 收敛，
 * 引导不是每次调用的前置动作。
 */
export async function ensurePlatformAccount(): Promise<PlatformAccountSnapshot> {
  const stored = await findPlatformAccount();
  return stored ?? bootstrapPlatformAccount();
}

/**
 * 就绪读路径的引导预算（毫秒）：超时即返回「仍未就绪」，不取消在途引导。
 *
 * 取值低于前端请求层的默认超时（`@fenix/web-runtime/api/request` 的 30s），把「等多久」的决定权留在
 * 服务端：读接口超时前必须给出确定答复，而不是让浏览器先断开。
 */
export const PROVISION_BUDGET_MS = 8_000;

/** 在途引导（单飞）：并发读请求共享同一次引导，不放大登录与注册（上游单会话，重复登录会互相踢键）。 */
let inFlightProvision: Promise<PlatformAccountSnapshot> | null = null;

/** 起一次引导并登记单飞句柄；无论成败都释放（只清自己这一轮，避免清掉后来者的句柄）。 */
function startProvision(): Promise<PlatformAccountSnapshot> {
  const attempt = bootstrapPlatformAccount().finally(() => {
    if (inFlightProvision === attempt) inFlightProvision = null;
  });
  inFlightProvision = attempt;
  return attempt;
}

/**
 * 台账缺行时**按需**引导平台账号，并给这次引导一个有界预算；失败与超时都只返回 null（降级，不抛错）。
 *
 * 为什么读路径也要能触发引导：台账行是「平台账号已就绪」的唯一持久化事实，而此前它**只**在建租户 App
 * 的路径上被写入。于是行一旦丢失（历史库被清理、库重建、脏测试、迁移演练等），所有已绑定租户会永久停在
 * `space-missing`：绑定还在、App 还在，但拼不出带真实 `space_id` 的画布地址，且**没有任何自愈入口**——
 * 「重试」只是把同一个 null 再读一遍（实测：重试不恢复）。
 *
 * 边界：只有在台账**缺行**时才触发出站；已有行时是一次本地读，零额外成本。单飞 + 预算 + 「失败即 null」
 * 三条共同保证读路径不被拖垮，也不引入无界重试或跨请求的错误状态。超时不取消在途引导——发起方可能已经
 * 在上游建出身份，取消只会让下一次调用重复一遍。
 */
export async function ensurePlatformAccountWithinBudget(
  timeoutMs: number = PROVISION_BUDGET_MS,
): Promise<PlatformAccountSnapshot | null> {
  const stored = await findPlatformAccount();
  if (stored !== null) return stored;

  const attempt = inFlightProvision ?? startProvision();
  // 引导失败必须有人接住：调用方此刻只关心「有没有就绪」，失败会被 bootstrap 自己记日志并标 degraded。
  const guarded = attempt.catch((error: unknown) => {
    logger.warn("workflow-v2 平台账号按需引导失败", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([guarded, budget]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
