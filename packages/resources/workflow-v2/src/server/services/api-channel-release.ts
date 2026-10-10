/**
 * 「确保工作流当前发布版本已登记到上游 API 渠道」——对外触发接口真正可用的**前置条件**。
 *
 * ## 为什么需要这一步（上游协议的硬约束，2026-10-09 实测）
 *
 * 上游 `POST /v1/workflow/run`（运行已发布版本）在真正执行前校验渠道登记表（`backend/domain/workflow/service/
 * executable_impl.go` → `checkApplicationWorkflowReleaseVersion`）：
 *
 * ```sql
 * SELECT * FROM connector_workflow_version
 * WHERE connector_id = 1024 AND workflow_id = ? AND version = ?
 * ```
 *
 * `1024` = `consts.APIConnectorID`；`version` = `workflow_meta.latest_version`（上游 `wf.LatestPublishedVersion`，
 * PAT 运行路径取它）。表里没有这一行就回 `777777778 ErrWorkflowSpecifiedVersionNotFound`（该码不在上游
 * `errnoMap` 里，`msg` 只给通用的 "Service Internal Error"）。
 *
 * 该表的**唯一写入路径**是「把 App 发布到渠道」：`ReleaseApplicationWorkflows` →
 * `BatchCreateConnectorWorkflowVersion`（`service_impl.go:963`，`connector_ids` 由 App 发布请求携带）。
 * 触发它的 HTTP 端点只有一个：`POST /api/intelligence_api/publish/publish_project`
 * （`project_id` + `version_number` + `connectors: {"1024": {}}`）。
 *
 * ## 两个必须照做、实测才知道的协议细节
 *
 * 1. **渠道行只为「这一次新创建的 workflow 版本」写入**。`ReleaseApplicationWorkflows` 对每个 workflow 先
 *    `GetVersion(wf, version)`，版本已存在就 `continue`（既不建版本也不进 `workflowIDs`）。因此发布一个
 *    「已存在的工作流版本号」会得到一次**看起来成功、实际什么都没登记**的空转（实测：workflow 级发布
 *    `v0.0.3` 后按同版本发布 App → `publish_status=5`，但 `connector_workflow_version` 里仍只有 `v0.0.2`）。
 *    结论：目标版本必须严格大于该 App 下**所有** workflow 的当前版本，也必须未被 App 发布记录占用。
 * 2. **同一版本重复发布不是幂等**：`PublishAPP` 先 `CheckAPPVersionExist(appID, version)`，命中即回
 *    `101000002 ErrAppRecordNotFound`（一个语义错位的码）。多副本并发时它正好充当互斥：抢输的一方拿到
 *    该码，重算版本后再试一次（有界，见 {@link MAX_RELEASE_ATTEMPTS}）。
 *
 * ## 设计取舍
 *
 * - **时机**：只做「运行前兜底」这一条路径，由调用方（`routes/api/**`）在收到 `777777778` 后触发。理由是
 *   上游**没有读接口**能回答「这个 workflow 版本登记了吗」（`GetVersionListByConnectorAndWorkflowID` 只在
 *   domain 层，无 HTTP 出口，已核对全仓调用点），因此「主动检查—必要时发布」在成功路径上既做不到、也无法
 *   验证；而失败回执本身就是最可靠、零成本的探测信号。
 * - **幂等 / 并发**：进程内按 App 单飞（同一 App 的并发自愈共享一次发布——一次发布覆盖该 App 下全部
 *   workflow，键必须落在 App 上）；每个 workflow 记冷却窗口；跨副本靠上游的版本占用（细节 2）自然互斥。
 * - **失败隔离**：本函数**永不抛错**，一律返回结构化结果；调用方据此决定是否重试运行。上游不可达、被拒、
 *   版本号形状不认识都不会掩盖原始运行错误，只多一条日志。
 * - **多租户**：只接受「已由路由按组织谓词解析出来的」`upstreamWorkflowId` 与 `appId`，不接受任何客户端
 *   字段；发布用平台账号会话，操作对象是租户自己的 App（上游 `ValidateDraftAPPAccess` 校验 owner）。
 */

import { createLogger } from "@fenix/logger";
import { callUpstream, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";
import { readUpstreamPublishStatuses } from "./workflow-publish-state";
import { nextPublishVersion } from "./workflow-publish-version";

const logger = createLogger("wf2-api-channel-release");

/** 上游 API 渠道的 connector id（`consts.APIConnectorID`）。 */
export const API_CONNECTOR_ID = 1024;

/** App 发布端点（唯一能写 `connector_workflow_version` 的入口）。 */
const PUBLISH_APP_PATH = "/api/intelligence_api/publish/publish_project";

/** App 发布记录列表：读「已被占用的版本号」。 */
const PUBLISH_RECORD_LIST_PATH = "/api/intelligence_api/publish/publish_record_list";

/** App 详情（`intelligence_type=2` 即 Project）：取 App 所在空间 id，并确认它确实是应用实体。 */
const APP_INFO_PATH = "/api/intelligence_api/search/get_draft_intelligence_info";

/** App 内 workflow 列表（按 `project_id` 硬过滤）。 */
const WORKFLOW_LIST_PATH = "/api/workflow_api/workflow_list";

/** 上游「记录不存在」业务码（`errno.ErrAppRecordNotFound`）：非应用实体、或版本号被占用时出现。 */
const UPSTREAM_RECORD_NOT_FOUND_CODE = 101000002;

/**
 * 自愈总预算：运行请求已经失败过一次，自愈不得让调用方等成超时。
 *
 * 超时只影响本次返回值（调用方拿不到 `released` 就不重试运行），在途发布**不取消**——上游可能已经建出
 * 版本，取消只会让下一次调用重复一遍（与 `ensurePlatformAccountWithinBudget` 同口径）。
 */
export const RELEASE_BUDGET_MS = 15_000;

/**
 * 冷却窗口：同一 workflow 在上一轮自愈尝试（成败都算）后的这段时间内不再尝试。
 *
 * 防的是「上游持续拒绝」与「版本被并发推进」时每次外部调用都打一轮上游；代价是一次真正需要自愈的请求要等
 * 冷却结束，对外表现为带 `retryAfterSeconds` 的 409（调用方可重试）。
 */
export const RELEASE_COOLDOWN_MS = 30_000;

/** 单次自愈的发布尝试上限（第二次只为处理跨副本的版本占用）。 */
const MAX_RELEASE_ATTEMPTS = 2;

/** 读接口超时（短于默认 10s：读失败只是本次自愈放弃，不该拖住调用方）。 */
const READ_TIMEOUT_MS = 5_000;

/** 发布接口超时（写动作，给足上游做版本快照的时间）。 */
const PUBLISH_TIMEOUT_MS = 10_000;

/** workflow 列表分页参数与页数上限（单个租户 App 的 workflow 数量远小于该上界）。 */
const WORKFLOW_PAGE_SIZE = 100;
const MAX_WORKFLOW_PAGES = 5;

/** 版本读取一次最多带多少个 id（上游 `workflow_detail_info` 实测 100 个正常返回）。 */
const MAX_VERSION_QUERY_IDS = 100;

/** 自愈结果；调用方只认 `released`（其余一律不重试运行，并把原因带进日志）。 */
export type ApiChannelReleaseOutcome =
  /** 目标版本已登记：上游发布成功且 workflow 的当前版本确实推进到该版本。 */
  | { readonly status: "released"; readonly version: string }
  /** 承载该 workflow 的上游对象不是「应用实体」（历史 bot 绑定），没有可发布到渠道的路径。 */
  | { readonly status: "app_not_publishable" }
  /** 冷却中：上一轮尝试（成败都算）还没过窗口。 */
  | { readonly status: "cooldown"; readonly retryAfterSeconds: number }
  /** 上游以业务码拒绝（版本占用以外的拒绝）。 */
  | { readonly status: "rejected"; readonly httpStatus: number; readonly upstreamCode: number | null }
  /** 传输/会话/熔断失败，或超出预算：本次没拿到可信结论。 */
  | { readonly status: "unavailable" }
  /** 上游发布链路跑完但目标版本没生效（命中协议细节 1 的空转）。 */
  | { readonly status: "unverified"; readonly version: string }
  /** 上游版本号形状不认识（不是 `vx.y.z`）：不猜版本号，直接放弃。 */
  | { readonly status: "version_unparseable" };

/** 上游调用端口；与 `callUpstream` 同形，测试注入替身（不触达真实上游与会话）。 */
export type ApiChannelReleaseUpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

export interface ApiChannelReleaseInput {
  /** 上游 workflow id（已由调用方按组织谓词解析）。 */
  readonly upstreamWorkflowId: string;
  /** 该 workflow 所属的上游应用 id（本地注册表的 `appId` 列，非客户端输入）。 */
  readonly appId: string;
}

export interface ApiChannelReleaseDeps {
  readonly callUpstream?: ApiChannelReleaseUpstreamCall;
  /** 时钟（冷却窗口用）；缺省即 `Date.now`。 */
  readonly now?: () => number;
}

/** 版本比较键：`major.minor.patch` 三段整数（上游版本形状固定，直接比较数值）。 */
function versionRank(version: string): number | null {
  const matched = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  if (matched === null) return null;
  const [, major, minor, patch] = matched;
  return (Number(major) * 1_000 + Number(minor)) * 1_000 + Number(patch);
}

/**
 * 版本集合 → 下一个可发布版本：取集合内最大值 + patch 1；集合为空取首个版本 `v0.0.1`。
 *
 * 集合里出现认不出的版本号时返回 null（**拒绝猜测**）：上游自己写入的版本恒为 `vx.y.z`，读不出形状说明读到的
 * 不是版本号，猜一个只会得到误导性的「未自增」或空转。
 */
export function nextReleaseVersion(versions: readonly string[]): string | null {
  const recognized = versions
    .map((version) => ({ version, rank: versionRank(version) }))
    .filter((item): item is { version: string; rank: number } => item.rank !== null);
  if (recognized.length !== versions.length) return null;
  if (recognized.length === 0) return nextPublishVersion(null);
  const max = recognized.reduce((best, item) => (item.rank > best.rank ? item : best));
  return nextPublishVersion(max.version);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 上游业务码；非数字返回 null。 */
function readBusinessCode(body: unknown): number | null {
  if (!isRecord(body)) return null;
  return typeof body.code === "number" ? body.code : null;
}

/** 上游业务成功 = HTTP 200 且 `code === 0`。 */
function isUpstreamSuccess(result: UpstreamCallResult): boolean {
  return result.status === 200 && readBusinessCode(result.body) === 0;
}

/** 读嵌套字段（缺失或形状不符时为 null）。 */
function readPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current;
}

/** 读非空字符串；缺失、非字符串、空串都归 null。 */
function readString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 自愈日志字段：上游 `msg` 截断入日志（panic 栈由日志侧只看前 200 字符，绝不进响应）。 */
function upstreamLogFields(result: UpstreamCallResult): Record<string, unknown> {
  return {
    upstreamStatus: result.status,
    upstreamCode: readBusinessCode(result.body),
    upstreamMsg: String(readPath(result.body, ["msg"]) ?? "").slice(0, 200),
  };
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 进程内单飞表：键是 App。一次发布覆盖该 App 下全部 workflow，同一 App 不能并发发两次——键落在 workflow 上
 * 会让同一 App 的两个 workflow 各发一次，互相占用版本号。
 */
const inFlightByApp = new Map<string, Promise<ApiChannelReleaseOutcome>>();

/** 冷却表：workflow id → 冷却截止时间（毫秒）。 */
const cooldownUntil = new Map<string, number>();

/** 仅测试使用：清空进程内单飞与冷却状态（模块级状态会跨用例互相污染）。 */
export function resetApiChannelReleaseStateForTests(): void {
  inFlightByApp.clear();
  cooldownUntil.clear();
}

/** 读 App 所在空间：应用实体不存在（历史 bot 绑定）与上游不可达分开归因。 */
async function inspectApp(
  appId: string,
  upstream: ApiChannelReleaseUpstreamCall,
): Promise<{ kind: "ok"; spaceId: string } | { kind: "not_publishable" } | { kind: "unavailable" }> {
  let result: UpstreamCallResult;
  try {
    result = await upstream({
      path: APP_INFO_PATH,
      body: { intelligence_id: appId, intelligence_type: 2 },
      timeoutMs: READ_TIMEOUT_MS,
    });
  } catch (error) {
    logger.warn("workflow-v2 API 渠道自愈：App 探测未能完成", { error: describeError(error) });
    return { kind: "unavailable" };
  }
  if (readBusinessCode(result.body) === UPSTREAM_RECORD_NOT_FOUND_CODE) return { kind: "not_publishable" };
  if (!isUpstreamSuccess(result)) {
    logger.warn("workflow-v2 API 渠道自愈：App 探测被上游拒绝", upstreamLogFields(result));
    return { kind: "unavailable" };
  }
  const spaceId = readString(readPath(result.body, ["data", "basic_info", "space_id"]));
  if (spaceId === null) {
    logger.warn("workflow-v2 API 渠道自愈：App 详情缺少 space_id", upstreamLogFields(result));
    return { kind: "unavailable" };
  }
  return { kind: "ok", spaceId };
}

/** 读 App 下全部 workflow id（按 `project_id` 硬过滤）；读不全就返回 null（版本号必须建立在完整集合上）。 */
async function readAppWorkflowIds(
  appId: string,
  spaceId: string,
  upstream: ApiChannelReleaseUpstreamCall,
): Promise<string[] | null> {
  const ids: string[] = [];
  for (let page = 1; page <= MAX_WORKFLOW_PAGES; page += 1) {
    let result: UpstreamCallResult;
    try {
      result = await upstream({
        path: WORKFLOW_LIST_PATH,
        body: { space_id: spaceId, project_id: appId, page, size: WORKFLOW_PAGE_SIZE },
        timeoutMs: READ_TIMEOUT_MS,
      });
    } catch (error) {
      logger.warn("workflow-v2 API 渠道自愈：workflow 列表读取未能完成", { error: describeError(error) });
      return null;
    }
    if (!isUpstreamSuccess(result)) {
      logger.warn("workflow-v2 API 渠道自愈：workflow 列表被上游拒绝", upstreamLogFields(result));
      return null;
    }
    const list = readPath(result.body, ["data", "workflow_list"]);
    const items = Array.isArray(list) ? list : [];
    for (const item of items) {
      const id = readString(readPath(item, ["workflow_id"]));
      if (id !== null) ids.push(id);
    }
    if (items.length < WORKFLOW_PAGE_SIZE) return ids;
  }
  logger.warn("workflow-v2 API 渠道自愈：workflow 列表超出分页上界，放弃本次自愈", {
    appId,
    pages: MAX_WORKFLOW_PAGES,
  });
  return null;
}

/** 一条 App 发布记录：版本号 + 发布状态（`5` = `PublishDone`，`1` = `PackFailed`，其余见上游枚举）。 */
interface AppPublishRecord {
  readonly version: string;
  readonly status: number | null;
}

/**
 * 读 App 发布记录（失败记录也算占用版本号：同一版本不能发第二次）。
 *
 * 同时返回 `publish_status`：目标版本没生效时，它是**唯一**能区分「版本已存在被跳过」与「应用打包失败」
 * 的线索（后者意味着应用内有 workflow 校验不通过，整次发布什么都不建）。
 */
async function readAppPublishRecords(
  appId: string,
  upstream: ApiChannelReleaseUpstreamCall,
): Promise<AppPublishRecord[] | null> {
  let result: UpstreamCallResult;
  try {
    result = await upstream({
      path: PUBLISH_RECORD_LIST_PATH,
      body: { project_id: appId },
      timeoutMs: READ_TIMEOUT_MS,
    });
  } catch (error) {
    logger.warn("workflow-v2 API 渠道自愈：App 发布记录读取未能完成", { error: describeError(error) });
    return null;
  }
  if (!isUpstreamSuccess(result)) {
    logger.warn("workflow-v2 API 渠道自愈：App 发布记录被上游拒绝", upstreamLogFields(result));
    return null;
  }
  const list = readPath(result.body, ["data"]);
  const items = Array.isArray(list) ? list : [];
  const records: AppPublishRecord[] = [];
  for (const item of items) {
    const version = readString(readPath(item, ["version_number"]));
    if (version === null) continue;
    const status = readPath(item, ["publish_status"]);
    records.push({ version, status: typeof status === "number" ? status : null });
  }
  return records;
}

/** 读一批 workflow 的当前发布版本（只统计已发布的，未发布的不占版本号）。 */
async function readWorkflowVersions(
  spaceId: string,
  upstreamWorkflowIds: readonly string[],
  upstream: ApiChannelReleaseUpstreamCall,
): Promise<string[] | null> {
  const read = await readUpstreamPublishStatuses(
    { spaceId, upstreamWorkflowIds: upstreamWorkflowIds.slice(0, MAX_VERSION_QUERY_IDS) },
    { callUpstream: (input) => upstream({ ...input, timeoutMs: READ_TIMEOUT_MS }) },
  );
  if (read.failure !== null) return null;
  return [...read.statuses.values()]
    .map((status) => status.publishedVersion)
    .filter((version): version is string => version !== null);
}

/** 一次自愈的全部出站动作：版本推导 → 发布 → 校验；返回结构化结论，不抛错。 */
async function attemptRelease(
  input: ApiChannelReleaseInput,
  upstream: ApiChannelReleaseUpstreamCall,
): Promise<ApiChannelReleaseOutcome> {
  const app = await inspectApp(input.appId, upstream);
  if (app.kind === "not_publishable") {
    logger.warn("workflow-v2 API 渠道自愈：承载对象不是可发布的应用实体", { appId: input.appId });
    return { status: "app_not_publishable" };
  }
  if (app.kind === "unavailable") return { status: "unavailable" };

  const workflowIds = await readAppWorkflowIds(input.appId, app.spaceId, upstream);
  if (workflowIds === null) return { status: "unavailable" };
  const workflowVersions = await readWorkflowVersions(app.spaceId, workflowIds, upstream);
  if (workflowVersions === null) return { status: "unavailable" };
  const publishRecords = await readAppPublishRecords(input.appId, upstream);
  if (publishRecords === null) return { status: "unavailable" };

  let candidates: string[] = [...workflowVersions, ...publishRecords.map((record) => record.version)];
  for (let attempt = 1; attempt <= MAX_RELEASE_ATTEMPTS; attempt += 1) {
    const target = nextReleaseVersion(candidates);
    if (target === null) {
      logger.warn("workflow-v2 API 渠道自愈：上游版本号形状不认识，拒绝猜测", {
        appId: input.appId,
        observed: candidates.slice(0, 5),
      });
      return { status: "version_unparseable" };
    }

    let published: UpstreamCallResult;
    try {
      published = await upstream({
        path: PUBLISH_APP_PATH,
        body: {
          project_id: input.appId,
          version_number: target,
          // 只发 API 渠道；`connectors` 的键即 connector_id（上游 `PublishProjectRequest.connectors`）。
          connectors: { [String(API_CONNECTOR_ID)]: {} },
        },
        timeoutMs: PUBLISH_TIMEOUT_MS,
      });
    } catch (error) {
      logger.warn("workflow-v2 API 渠道自愈：发布请求未能完成", {
        appId: input.appId,
        version: target,
        error: describeError(error),
      });
      return { status: "unavailable" };
    }

    if (isUpstreamSuccess(published)) {
      const effective = await readWorkflowVersions(app.spaceId, [input.upstreamWorkflowId], upstream);
      if (effective?.includes(target) === true) {
        logger.info("workflow-v2 API 渠道自愈完成", {
          upstreamWorkflowId: input.upstreamWorkflowId,
          appId: input.appId,
          version: target,
        });
        return { status: "released", version: target };
      }
      // 上游回了成功但目标版本没生效。两种成因靠发布记录的状态区分（2026-10-09 实测第二种）：
      // - `publish_status=5`（PublishDone）但版本没动 → 目标版本已存在，上游跳过建版本（协议细节 1）；
      // - `publish_status=1`（PackFailed）→ 应用内有 workflow 校验不通过，整次发布什么都不建
      //   （`ReleaseApplicationWorkflows` 先校验全部 workflow，任一条不通过就整体放弃）。
      const records = await readAppPublishRecords(input.appId, upstream);
      const record = records?.find((item) => item.version === target) ?? null;
      logger.warn("workflow-v2 API 渠道自愈：发布返回成功但目标版本未生效", {
        appId: input.appId,
        version: target,
        publishRecordStatus: record?.status ?? null,
      });
      return { status: "unverified", version: target };
    }

    const upstreamCode = readBusinessCode(published.body);
    if (upstreamCode === UPSTREAM_RECORD_NOT_FOUND_CODE && attempt < MAX_RELEASE_ATTEMPTS) {
      // 版本号被并发占用（另一副本或一次并发发布先落库）：刷新记录后重算一次。
      logger.info("workflow-v2 API 渠道自愈：目标版本已被占用，刷新记录后重试", {
        appId: input.appId,
        version: target,
      });
      const refreshed = await readAppPublishRecords(input.appId, upstream);
      if (refreshed === null) return { status: "unavailable" };
      candidates = [...candidates, ...refreshed.map((record) => record.version)];
      continue;
    }

    logger.warn("workflow-v2 API 渠道自愈：发布被上游拒绝", {
      appId: input.appId,
      version: target,
      ...upstreamLogFields(published),
    });
    return { status: "rejected", httpStatus: published.status, upstreamCode };
  }

  return { status: "unavailable" };
}

/**
 * 确保「该 workflow 的当前发布版本」已登记到 API 渠道；**永不抛错**，一律返回结构化结果。
 *
 * 冷却与单飞都在本函数内收口：命中冷却时零出站直接返回；同一 App 的并发调用共享同一次发布（`inFlightByApp`），
 * 因此 N 个并发运行请求最多产生一次渠道发布。超出 {@link RELEASE_BUDGET_MS} 时本次返回 `unavailable`，
 * 在途发布继续跑完（下次调用能读到它的结果）。
 */
export async function ensureApiChannelRelease(
  input: ApiChannelReleaseInput,
  deps: ApiChannelReleaseDeps = {},
): Promise<ApiChannelReleaseOutcome> {
  return await releaseWithCooldownPolicy(input, deps);
}

/** 共用的执行骨架：冷却检查 → 单飞 → 预算与结算。 */
async function releaseWithCooldownPolicy(
  input: ApiChannelReleaseInput,
  deps: ApiChannelReleaseDeps,
): Promise<ApiChannelReleaseOutcome> {
  const upstream = deps.callUpstream ?? callUpstream;
  const now = deps.now ?? Date.now;

  const cooling = cooldownUntil.get(input.upstreamWorkflowId);
  if (cooling !== undefined && cooling > now()) {
    return { status: "cooldown", retryAfterSeconds: Math.ceil((cooling - now()) / 1000) };
  }

  let attempt = inFlightByApp.get(input.appId);
  if (attempt === undefined) {
    const started: Promise<ApiChannelReleaseOutcome> = attemptRelease(input, upstream).finally(() => {
      if (inFlightByApp.get(input.appId) === started) inFlightByApp.delete(input.appId);
    });
    inFlightByApp.set(input.appId, started);
    attempt = started;
  }

  // 成败都记冷却：失败时避免「每次外部调用都打一轮上游」，成功时避免「版本被并发推进后反复发布」。
  const guarded = attempt.then((outcome: ApiChannelReleaseOutcome) => {
    cooldownUntil.set(input.upstreamWorkflowId, now() + RELEASE_COOLDOWN_MS);
    return outcome;
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<ApiChannelReleaseOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ status: "unavailable" }), RELEASE_BUDGET_MS);
  });
  try {
    return await Promise.race([guarded, budget]);
  } catch (error) {
    // 兜底：上游端口可注入，替身抛错不应把运行接口的失败路径打断。
    logger.error("workflow-v2 API 渠道自愈异常", { appId: input.appId, error: describeError(error) });
    return { status: "unavailable" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
