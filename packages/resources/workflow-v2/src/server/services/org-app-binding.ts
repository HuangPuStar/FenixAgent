/**
 * 租户（organization）↔ 上游应用绑定的**唯一写侧**（设计 §3.2：一个 organization 一个 App）。
 *
 * ## 载体是「应用（Project）」而不是「bot」（2026-10-09 实测，理由见
 * `docs/design/2026-10-09-workflow-v2-api-channel-release.md`）
 *
 * workflow 的 `project_id` 指向应用，而「把应用发布到 API 渠道」是 `connector_workflow_version` 唯一的写入
 * 路径——对外触发接口能跑起来的前提；bot 载体没有这条链路（bot 发布实测不写登记表）。
 *
 * 兼容旧载体：上游构建没有应用接口（HTTP 404）时退回 bot 载体，绑定与控制台照常可用（对外触发会明确报出
 * 缺少渠道登记）。移除条件：固定镜像的上游构建确定提供应用接口后，删除 {@link LEGACY_BOT_CARRIER} 分支。
 *
 * 为什么绑定关系必须落本地：上游只校验「平台账号属于该 space」（`checkUserSpace`），没有「按空间列 App」
 * 的接口（契约快照 §3 F9），App 一旦在本地丢失就再也找不回来。`workflow_v2_org_app` 的两个唯一索引
 * （`organization_id`、`app_id`）是一对一关系的存储层保证，读侧由 2B 的
 * `repositories/tenant-binding-repository.ts` 承担。
 *
 * 并发收敛（不靠进程内锁）：同一组织的并发首次调用可能各自在上游建出一个 App，本地只有一个能落库——
 * - 进程内：按组织单飞，让并发的首次调用共享同一次创建（多数形态下的第一道防线）；
 * - 存储层：`organization_id` 唯一索引 + `ON CONFLICT DO NOTHING` 后重读，跨进程/跨副本仍然收敛到同一行；
 * - 落败的那个 App 在上游侧没有任何本地绑定，且没有接口能列出它，因此尽力删除并留日志（对账兜底）。
 *
 * 降级语义（冻结 §4.3 的 `status`）：上游**明确**说绑定目标不存在时置 `degraded`，让上层（2B 的
 * `findTenantBinding` → 工作流写接口 503）快速失败；「上游不可达」不改变状态——那是暂时故障，把绑定
 * 永久标成 degraded 会让一次超时变成需要人工重绑的事故。读接口（`GET /org-app`）不打上游，状态收敛靠
 * {@link probeOrgAppBinding} 或上层探测到不存在类错误时的 {@link markOrgAppDegraded}。
 *
 * 持久化直接落在本文件：`repositories/**` 是 2B 的文件域（冻结 §1 的 owner 表），本任务不越界新增仓储。
 */

import { createLogger } from "@fenix/logger";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { workflowV2OrgApp } from "@fenix/resource-workflow-v2/db";
import { eq } from "drizzle-orm";
import { getWorkflowV2Database } from "../repositories/database";
import { APP_CARRIER, type AppCarrier, type AppExistence, LEGACY_BOT_CARRIER } from "./app-carrier";
import { ensurePlatformAccount } from "./platform-account-bootstrap";
import type { UpstreamCallResult } from "./upstream-client";
import { callUpstream, UPSTREAM_PANIC_CODE } from "./upstream-client";

const logger = createLogger("wf2-org-app");

/** `icon_uri` 必填，用上游自带的默认 App 图标（契约快照 §2 第 5 行）。 */
const DEFAULT_APP_ICON_URI = "default_icon/default_app_icon.png";

/**
 * 建 App 的固定描述：App 名取自组织名称，描述不回填租户信息——上游侧的展示字段不是我方元数据的面板，
 * 把组织 id / 用户名写进去等于把内部标识暴露给上游与任何能看到该 App 的人。
 */
const APP_DESCRIPTION = "FenixAgent workflow-v2 tenant app";

/**
 * 载体协议（端点、请求体、响应读取、不存在判定）在 `app-carrier.ts`；这里只做绑定生命周期。
 *
 * `UPSTREAM_APP_NOT_FOUND_CODE` 继续从本模块转出：它是对外可见的常量（契约快照 §2 第 4 行），
 * 消费方按模块边界引用它，不跟着内部文件拆分走。
 */
export { UPSTREAM_APP_NOT_FOUND_CODE } from "./app-carrier";

/**
 * 组织名不可用时的展示名回退值。
 *
 * 组织名录读不到（目录故障）或组织名称为空/纯空白时用**固定常量**而不是组织 id、用户 id 之类的内部标识：
 * 展示名会随 App 一起出现在上游与任何能看到它的人面前，把内部标识写进去等于把租户坐标送出去
 * （同 {@link APP_DESCRIPTION} 的口径）。常量是确定的，因此「名称为空」不会变成一次随机失败。
 */
export const DEFAULT_ORG_APP_NAME = "工作流空间";

export type OrgAppStatus = "active" | "degraded";

export interface OrgAppBinding {
  readonly organizationId: string;
  /** 上游应用（bot）ID；创建 workflow 时注入为 `project_id`。 */
  readonly appId: string;
  readonly name: string;
  readonly status: OrgAppStatus;
}

/** 绑定操作的失败分类；路由据此映射 `/web` 错误码与状态码（对外文案由路由给）。 */
export type OrgAppBindingFailure =
  /** 上游不可达：超时、网络失败、重登后仍被判定会话失效。 */
  | "upstream_unavailable"
  /** 上游以业务码拒绝了请求（含 panic 码，其 `msg` 是 Go 堆栈，绝不外传）。 */
  | "upstream_rejected"
  /** 上游明确回答「这个 App 不存在」。 */
  | "app_not_found"
  /** 目标 App 已被**别的组织**绑定（唯一索引冲突）；不向调用方回显占用方。 */
  | "app_taken"
  /** 本地写入失败。 */
  | "persist_failed";

export class OrgAppBindingError extends Error {
  constructor(
    readonly kind: OrgAppBindingFailure,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OrgAppBindingError";
  }
}

/** 表行 → 绑定；`status` 列是自由文本，按契约收窄（未知值视为 degraded，最小信任）。 */
function toBinding(row: typeof workflowV2OrgApp.$inferSelect): OrgAppBinding {
  return {
    organizationId: row.organizationId,
    appId: row.appId,
    name: row.name,
    status: row.status === "active" ? "active" : "degraded",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 业务码读取：只认数字（上游返回 number）。 */
function readBusinessCode(body: unknown): number | undefined {
  if (!isRecord(body)) return;
  return typeof body.code === "number" ? body.code : undefined;
}

/** 上游成功 = HTTP 200 且 `code === 0`（业务失败多为 HTTP 200 + 非 0 码，见契约快照 §3 F5）。 */
function isUpstreamSuccess(result: UpstreamCallResult): boolean {
  return result.status === 200 && readBusinessCode(result.body) === 0;
}

/** 唯一索引冲突判定：Drizzle 把驱动错误包在 `cause` 里，逐层下钻（同 `workflow-registry` 口径）。 */
function isUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; cause?: unknown };
  return (
    candidate.code === "23505" ||
    (typeof candidate.message === "string" &&
      (candidate.message.includes("duplicate key") || candidate.message.includes("unique constraint"))) ||
    isUniqueConstraintError(candidate.cause)
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 上游调用结果的诊断字段；panic 码的 `msg` 是 Go 堆栈，只记占位符。 */
function upstreamLogFields(result: UpstreamCallResult): Record<string, unknown> {
  const code = readBusinessCode(result.body);
  const msg = isRecord(result.body) ? result.body.msg : undefined;
  return {
    upstreamStatus: result.status,
    upstreamCode: code,
    upstreamMsg: code === UPSTREAM_PANIC_CODE ? "<panic stack redacted>" : String(msg ?? "").slice(0, 200),
  };
}

/** 用一个载体探测绑定目标是否存在；只对「明确不存在」返回 missing。 */
async function inspectWithCarrier(carrier: AppCarrier, appId: string): Promise<AppExistence> {
  let result: UpstreamCallResult;
  try {
    result = await callUpstream({ path: carrier.infoPath, body: carrier.infoBody(appId) });
  } catch (error) {
    logger.warn("workflow-v2 租户 App 存活探测未能完成", { appId, error: describeError(error) });
    return { kind: "unreachable" };
  }
  if (readBusinessCode(result.body) === carrier.notFoundCode) return { kind: "missing" };
  if (carrier.missingEndpointMeansAbsent && result.status === 404) return { kind: "missing" };
  if (!isUpstreamSuccess(result)) {
    logger.warn("workflow-v2 租户 App 存活探测被上游拒绝", { appId, ...upstreamLogFields(result) });
    return { kind: "unreachable" };
  }
  return { kind: "ok", name: carrier.readName(result.body) };
}

/**
 * 探测绑定目标是否仍在上游侧存在。
 *
 * 应用载体优先：绑定的载体就是它。应用侧「不存在」（业务码 `101000002`）或「该构建没有应用接口」（HTTP 404）
 * 时再探一次旧载体（bot），让迁移期的历史绑定照常可用；两次都不在即 missing。
 */
async function inspectUpstreamApp(appId: string): Promise<AppExistence> {
  const app = await inspectWithCarrier(APP_CARRIER, appId);
  if (app.kind !== "missing") return app;
  return await inspectWithCarrier(LEGACY_BOT_CARRIER, appId);
}

/** 按组织读绑定；未绑定时返回 null。读接口不打上游（冻结 §4.3 的只读语义）。 */
export async function findOrgAppBinding(organizationId: string): Promise<OrgAppBinding | null> {
  const [row] = await getWorkflowV2Database()
    .select()
    .from(workflowV2OrgApp)
    .where(eq(workflowV2OrgApp.organizationId, organizationId))
    .limit(1);
  return row ? toBinding(row) : null;
}

/**
 * 把绑定置为 degraded（表里没有原因列，原因只进日志），供上层在探测到不存在类错误时调用。
 *
 * **永不抛错**：调用方此时正在处理上游失败，降级标记再失败不应掩盖原始错误；写失败进 error 日志。
 */
export async function markOrgAppDegraded(organizationId: string, reason: string): Promise<void> {
  try {
    await getWorkflowV2Database()
      .update(workflowV2OrgApp)
      .set({ status: "degraded", updatedAt: new Date() })
      .where(eq(workflowV2OrgApp.organizationId, organizationId));
    logger.warn("workflow-v2 租户 App 绑定置为 degraded", { organizationId, reason });
  } catch (error) {
    logger.error("workflow-v2 租户 App 降级标记写入失败", {
      organizationId,
      reason,
      error: describeError(error),
    });
  }
}

/** 把绑定恢复为 active；只在探测确认 App 仍存在时调用。 */
async function markOrgAppActive(organizationId: string): Promise<void> {
  await getWorkflowV2Database()
    .update(workflowV2OrgApp)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(workflowV2OrgApp.organizationId, organizationId));
}

/** 探测结果：`unknown` 表示上游未确认（不可达/被拒），此时保持既有状态不变。 */
export type OrgAppProbe =
  | { readonly kind: "unbound" }
  | { readonly kind: "active"; readonly binding: OrgAppBinding }
  | { readonly kind: "degraded"; readonly binding: OrgAppBinding }
  | { readonly kind: "unknown"; readonly binding: OrgAppBinding };

/**
 * 探测并收敛绑定状态：上游明确说不存在 → 置 degraded；确认存在 → 恢复 active；未确认 → 原样返回。
 *
 * 这是「App 被删」进入 degraded 的权威入口（运维探针、健康检查与对账任务 4A 都走它），因此读接口不必
 * 每次打上游。
 */
export async function probeOrgAppBinding(organizationId: string): Promise<OrgAppProbe> {
  const binding = await findOrgAppBinding(organizationId);
  if (binding === null) return { kind: "unbound" };

  const existence = await inspectUpstreamApp(binding.appId);
  if (existence.kind === "unreachable") return { kind: "unknown", binding };
  if (existence.kind === "missing") {
    await markOrgAppDegraded(organizationId, "app_not_found");
    return { kind: "degraded", binding: { ...binding, status: "degraded" } };
  }
  if (binding.status !== "active") await markOrgAppActive(organizationId);
  return { kind: "active", binding: { ...binding, status: "active" } };
}

/** 建租户 App 的请求体；两个载体字段一致，只有端点与 id 字段不同。 */
function createAppBody(platformSpaceId: string, name: string): Record<string, unknown> {
  return {
    // space_id 由服务端注入（平台个人空间），客户端不可传入（冻结 §6 的注入白名单）。
    space_id: platformSpaceId,
    name,
    description: APP_DESCRIPTION,
    icon_uri: DEFAULT_APP_ICON_URI,
  };
}

/** 用一个载体建 App；失败按「调用抛错」与「上游拒绝」分开归因，HTTP 404（接口不存在）原样返回给调用方。 */
async function createWithCarrier(
  carrier: AppCarrier,
  platformSpaceId: string,
  name: string,
): Promise<{ readonly result: UpstreamCallResult } | { readonly appId: string }> {
  let result: UpstreamCallResult;
  try {
    result = await callUpstream({ path: carrier.createPath, body: createAppBody(platformSpaceId, name) });
  } catch (error) {
    logger.error("workflow-v2 创建租户 App 的请求未能完成", { error: describeError(error) });
    throw new OrgAppBindingError("upstream_unavailable", "创建上游应用 的请求未能完成", { cause: error });
  }
  const appId = carrier.readCreatedId(result.body);
  if (!isUpstreamSuccess(result) || appId === null) return { result };
  return { appId };
}

/**
 * 在上游建一个租户 App：应用载体优先，仅当该构建没有应用接口（HTTP 404）时退回 bot 载体（见文件头）。
 */
async function createUpstreamApp(platformSpaceId: string, name: string): Promise<string> {
  const created = await createWithCarrier(APP_CARRIER, platformSpaceId, name);
  if ("appId" in created) return created.appId;

  if (created.result.status === 404) {
    logger.warn("workflow-v2 上游没有应用接口，退回 bot 载体建租户 App", { carrier: LEGACY_BOT_CARRIER.label });
    const legacy = await createWithCarrier(LEGACY_BOT_CARRIER, platformSpaceId, name);
    if ("appId" in legacy) return legacy.appId;
    logger.error("workflow-v2 创建租户 App 被上游拒绝", upstreamLogFields(legacy.result));
    throw new OrgAppBindingError("upstream_rejected", "上游拒绝了创建 App 的请求");
  }

  logger.error("workflow-v2 创建租户 App 被上游拒绝", upstreamLogFields(created.result));
  throw new OrgAppBindingError("upstream_rejected", "上游拒绝了创建 App 的请求");
}

/**
 * 清理并发收敛后落败的孤儿 App（尽力而为）。
 *
 * 它在上游侧没有任何本地绑定，而上游没有「按空间列 App」的接口，不删就永久残留；删除失败只记日志，
 * 由对账任务（4A）兜底——与 2B 的 workflow 创建补偿同一口径。
 *
 * 应用载体优先；「这个 id 不是应用」或「该构建没有应用接口」时才用旧载体（bot）再试一次。
 */
async function compensateOrphanApp(platformSpaceId: string, appId: string): Promise<void> {
  let result: UpstreamCallResult;
  try {
    result = await callUpstream({
      path: APP_CARRIER.deletePath,
      body: APP_CARRIER.deleteBody(appId, platformSpaceId),
    });
  } catch (error) {
    logger.error("workflow-v2 孤儿 App 清理调用失败，留待对账任务重试", { appId, error: describeError(error) });
    return;
  }
  if (isUpstreamSuccess(result)) {
    logger.warn("workflow-v2 并发收敛后已清理孤儿 App", { appId });
    return;
  }
  const absent = result.status === 404 || readBusinessCode(result.body) === APP_CARRIER.notFoundCode;
  if (!absent) {
    logger.error("workflow-v2 孤儿 App 清理被上游拒绝，留待对账任务重试", { appId, ...upstreamLogFields(result) });
    return;
  }

  try {
    const legacy = await callUpstream({
      path: LEGACY_BOT_CARRIER.deletePath,
      body: LEGACY_BOT_CARRIER.deleteBody(appId, platformSpaceId),
    });
    if (isUpstreamSuccess(legacy)) {
      logger.warn("workflow-v2 并发收敛后已清理孤儿 App（旧载体）", { appId });
      return;
    }
    // 两个载体都说这个 id 不在：孤儿已经不存在，收敛完成。
    if (readBusinessCode(legacy.body) === LEGACY_BOT_CARRIER.notFoundCode) {
      logger.info("workflow-v2 孤儿 App 已不存在，无需清理", { appId });
      return;
    }
    logger.error("workflow-v2 孤儿 App 清理被上游拒绝，留待对账任务重试", { appId, ...upstreamLogFields(legacy) });
  } catch (error) {
    logger.error("workflow-v2 孤儿 App 清理调用失败，留待对账任务重试", { appId, error: describeError(error) });
  }
}

/**
 * 抢先落库：`ON CONFLICT DO NOTHING` 撞上 `organization_id` 唯一索引时返回 null，让调用方重读收敛。
 *
 * 不用 `ON CONFLICT DO UPDATE`：那会把先落库者的 `app_id` 覆盖成本次新建的 App，两个并发的首次
 * 调用就会「各建一个、后到的赢」，先绑定的那个 App 反而成了孤儿。
 */
async function insertBindingIfAbsent(
  organizationId: string,
  appId: string,
  name: string,
): Promise<OrgAppBinding | null> {
  try {
    const [row] = await getWorkflowV2Database()
      .insert(workflowV2OrgApp)
      .values({ organizationId, appId, name, status: "active" })
      .onConflictDoNothing({ target: workflowV2OrgApp.organizationId })
      .returning();
    return row ? toBinding(row) : null;
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // 撞的是 `app_id` 索引（同一 App 被绑到第二个组织）：本次新建的 App 不属于任何组织。
      throw new OrgAppBindingError("app_taken", "该上游应用 已被其它组织绑定");
    }
    throw new OrgAppBindingError("persist_failed", "本地绑定写入失败", { cause: error });
  }
}

/**
 * 租户 App 的展示名 = 当前**组织名称**（身份目录是组织名录的唯一合法读法，`IdentityDirectory` 契约）。
 *
 * 名称由服务端在创建时自己取，调用方（路由）不传：前端提交的名称一律不可信，而 App 名会出现在上游与
 * 组织内所有成员的界面上——让请求体决定它等于把一块用户可见文本交给任何能发请求的人。
 *
 * 组织名录读不到或名称为空/纯空白时回退 {@link DEFAULT_ORG_APP_NAME}：初始化是用户点一次就要有结果的
 * 动作，名称只是展示字段（重名不敏感），不该因为名录故障而失败；失败原因进 warn 日志，不阻断创建。
 */
export async function resolveOrgAppName(organizationId: string): Promise<string> {
  try {
    const organization = await getIdentityDirectory().getOrganization(organizationId);
    const name = organization?.name.trim();
    if (name !== undefined && name.length > 0) return name;
    logger.warn("workflow-v2 组织名称为空，租户 App 使用默认展示名", { organizationId });
  } catch (error) {
    logger.warn("workflow-v2 读取组织名称失败，租户 App 使用默认展示名", {
      organizationId,
      error: describeError(error),
    });
  }
  return DEFAULT_ORG_APP_NAME;
}

/** 首次绑定的实际动作：读一次、建上游 App、落库；冲突则重读收敛并清理孤儿。 */
async function createAndBind(organizationId: string): Promise<OrgAppBinding> {
  // 单飞内的二次检查：前一轮可能在本次进入前刚写入（首次调用者的重放等）。
  const raced = await findOrgAppBinding(organizationId);
  if (raced !== null) return raced;

  // 名称只在真正要创建时解析：已绑定是常见路径（幂等重放），不该为一次多余的目录读付费。
  const name = await resolveOrgAppName(organizationId);
  const account = await ensurePlatformAccount();
  const appId = await createUpstreamApp(account.platformSpaceId, name);

  const persisted = await insertBindingIfAbsent(organizationId, appId, name);
  if (persisted !== null) {
    logger.info("workflow-v2 租户 App 已创建并绑定", { organizationId, appId });
    return persisted;
  }

  // 唯一索引冲突：另一个调用者（可能是别的进程）先绑定成功。收敛到既有行，并清掉本次建出的孤儿。
  const winner = await findOrgAppBinding(organizationId);
  if (winner === null) {
    throw new OrgAppBindingError("persist_failed", "并发创建后读不到已绑定的 App");
  }
  logger.warn("workflow-v2 并发创建 App 收敛到既有绑定", { organizationId, orphanAppId: appId });
  await compensateOrphanApp(account.platformSpaceId, appId);
  return winner;
}

/** 进程内的按组织单飞：并发的首次调用共享同一次创建（跨进程由唯一索引兜底）。 */
const inFlightCreations = new Map<string, Promise<OrgAppBinding>>();

/**
 * 确保当前组织已绑定一个上游应用；已绑定则原样返回（含 degraded），未绑定则创建并绑定。
 *
 * 只能按组织调用：展示名由本函数自行从组织名录取（{@link resolveOrgAppName}），不接受调用方传名——名称是
 * 用户可见文本，不能由请求体决定（路由层因此没有对应的入参）。
 *
 * 幂等：重复调用不重复建 App。**不因 degraded 而自动重建**——App 是租户资源的物理边界，静默换一个
 * App 会让该租户既有 workflow 全部失联；换绑是管理员的显式动作（{@link rebindOrgApp}）。
 */
export async function ensureOrgApp(organizationId: string): Promise<OrgAppBinding> {
  const existing = await findOrgAppBinding(organizationId);
  if (existing !== null) return existing;

  const running = inFlightCreations.get(organizationId);
  if (running !== undefined) return running;

  const attempt = createAndBind(organizationId).finally(() => {
    // 只清自己这一轮：创建期间若已开始新一轮（前一轮已结束），不能把新句柄误清掉。
    if (inFlightCreations.get(organizationId) === attempt) inFlightCreations.delete(organizationId);
  });
  inFlightCreations.set(organizationId, attempt);
  return attempt;
}

/**
 * 显式重绑到指定的上游应用（管理员动作，准入在路由层）。
 *
 * 先向上游确认目标存在：把不存在或上游不可达的 App 写进绑定表，等于制造一个「看起来绑好了、用起来全部
 * 失败」的租户。目标已被**别的组织**占用时拒绝（`app_id` 唯一索引），现有绑定保持不变。
 */
export async function rebindOrgApp(organizationId: string, appId: string): Promise<OrgAppBinding> {
  const existence = await inspectUpstreamApp(appId);
  if (existence.kind === "missing") {
    throw new OrgAppBindingError("app_not_found", "目标上游应用 不存在");
  }
  if (existence.kind === "unreachable") {
    throw new OrgAppBindingError("upstream_unavailable", "上游服务不可达，未能确认目标 App");
  }

  const current = await findOrgAppBinding(organizationId);
  const name = existence.name ?? current?.name ?? appId;
  const now = new Date();
  try {
    const [row] = await getWorkflowV2Database()
      .insert(workflowV2OrgApp)
      .values({ organizationId, appId, name, status: "active" })
      .onConflictDoUpdate({
        target: workflowV2OrgApp.organizationId,
        set: { appId, name, status: "active", updatedAt: now },
      })
      .returning();
    if (!row) throw new OrgAppBindingError("persist_failed", "重绑未写入任何行");
    logger.info("workflow-v2 租户 App 已重绑", { organizationId, appId });
    return toBinding(row);
  } catch (error) {
    if (error instanceof OrgAppBindingError) throw error;
    // 组织行已被本组织的 upsert 命中；剩下的唯一索引冲突只可能来自 `app_id`（被别的组织占用）。
    if (isUniqueConstraintError(error)) {
      throw new OrgAppBindingError("app_taken", "该上游应用 已被其它组织绑定");
    }
    throw new OrgAppBindingError("persist_failed", "本地绑定写入失败", { cause: error });
  }
}
