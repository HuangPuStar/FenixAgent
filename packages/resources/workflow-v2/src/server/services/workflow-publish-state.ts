/**
 * 「上游当前发布版本」的读路径：卡片状态列与发布版本推导的**唯一事实来源**（用户口径：不做本地版本镜像）。
 *
 * 为什么不是本地列：`workflow_v2_workflow.published_version` 只在控制台发布成功时回写，画布内发布不经过平台，
 * 因此它随时可能落后于上游。用它渲染状态会把「上游已发布」显示成「未发布」（本次报障）；用它给发布自增会
 * 被上游以「版本号非自增」拒绝（实测：上游已是 `v0.0.4`、平台按本地列算出 `v0.0.1`）。
 *
 * **端点选型（2026-10-09 对 127.0.0.1:18080 实测，报障样本 workflow `7694508882214780928`）**：
 * - `POST /api/workflow_api/workflow_detail_info`（本文件采用）：`workflow_filter_list` 一次可带多个 id，
 *   每项回 `latest_flow_version`；与 `canvas` 的 `data.workflow_version` **同源**（上游
 *   `wf.LatestPublishedVersion`，实测两者同为 `v0.0.1`）。响应里没有 `schema_json`，单条 ~1 KB；实测
 *   100 个 filter 正常返回（3 ms），上游**省略**不存在的 id（不是回空条目）。因此一页一次调用即可，不需要
 *   按 workflow 并发读取，也没有「并发上界」可谈——出站次数与翻页次数一一对应。
 * - `POST /api/workflow_api/workflow_list`：列表项**没有版本字段**（上游 `Workflow` 结构只有 `status`（提交态）
 *   与 `product_draft_status`（产品审核态）），拿不到发布版本。
 * - `POST /api/workflow_api/canvas`：能拿到版本，但每个 workflow 一次调用，且响应携带整份 `schema_json`
 *   （大 workflow 数百 KB）。它仍是「发布日志」弹窗的口径（`workflow-publish-records.ts` 需要同一次读里
 *   的发布记录），列表页与发布链路都按它逐条读会把一次翻页/一次发布变成大响应。
 * - `POST /api/workflow_api/workflow_detail`：`version` 恒为空串（契约快照 F3，本次复测同结论），不可用。
 *
 * **失败语义**：本文件**不抛错**，把失败原因如实带回（传输/会话/熔断 → `transport`，上游业务拒绝 →
 * `upstream`），由调用方按自己的口径处置——
 * - 列表页（`listWorkflowsWithPublishStatus`）：状态是增强信息，主体数据在本地注册表，读取失败降级为
 *   `unknown` + warn 日志，**不让整页崩掉**；绑定不可用同理（但有日志说明原因）；
 * - 渠道自愈链路（`api-channel-release.ts`）：要发布一个「严格大于 App 内所有 workflow 当前版本」的新版本号，
 *   基准就是这里读到的 `latest_flow_version`；读不到只是本次自愈返回 `unavailable`，运行请求本身的失败结果
 *   不受影响。
 *
 * 不设缓存：控制台发布成功后页面立即刷新，任何 TTL 都会让刚发布的版本短暂显示成旧值或「未发布」；一笔列表
 * 请求只对应一次有界上游调用（见 {@link PUBLISH_STATE_TIMEOUT_MS}），缓存的收益抵不上这类陈旧显示。
 */

import { createLogger } from "@fenix/logger";
import { callUpstream, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";
import {
  listWorkflows,
  type WorkflowListInput,
  type WorkflowListItem,
  type WorkflowListPage,
} from "./workflow-registry";

const logger = createLogger("wf2-publish-state");

/** 上游「工作流详情（含当前发布版本）」端点；`workflow_filter_list` 支持批量。 */
const WORKFLOW_DETAIL_INFO_PATH = "/api/workflow_api/workflow_detail_info";

/**
 * 状态读取的独立超时预算（5 秒，短于 `upstreamTimeoutMs` 的默认 10 秒）。
 *
 * 理由是这一屏的主数据（本地注册表）**已经就绪**，状态只是增强：上游卡住时用户宁可先看到列表 + 「状态未知」，
 * 也不该看着骨架屏等满默认预算。预算覆盖冷启动（含会话重登）绰绰有余——实测 `workflow_detail_info` 3~16 ms、
 * 上游登录 40~60 ms，5 秒只兜「上游真的卡住」，不构成误降级。
 */
const PUBLISH_STATE_TIMEOUT_MS = 5_000;

/** 工作流的上游发布状态；`published` 时 {@link WorkflowPublishStatus.publishedVersion} 必非空。 */
export interface WorkflowPublishStatus {
  readonly publishState: "published" | "unpublished" | "unknown";
  /** 上游当前发布版本（形如 `v0.0.1`）；仅 `published` 时非 null。 */
  readonly publishedVersion: string | null;
}

/** 判定不明时统一用它：不造默认值，也不把「不知道」说成「未发布」。 */
const UNKNOWN_STATUS: WorkflowPublishStatus = { publishState: "unknown", publishedVersion: null };

/** 读取失败：传输/会话/熔断（未取到可信响应）或上游业务拒绝（取到了但不可用）。 */
export type WorkflowPublishStatusFailure =
  | { readonly kind: "transport"; readonly error: unknown }
  | { readonly kind: "upstream"; readonly result: UpstreamCallResult };

/**
 * 一批状态的一次读取。
 *
 * `statuses` **总是覆盖全部请求 id**（含判定不明者），调用方不需要再补默认值；`failure` 只在整批不可信时
 * 非空，此时每个 id 都是 `unknown`。个别 id 没有条目（上游不认识它）不算整批失败，表现为该 id 的 `unknown`。
 */
export interface WorkflowPublishStatusRead {
  readonly statuses: ReadonlyMap<string, WorkflowPublishStatus>;
  readonly failure: WorkflowPublishStatusFailure | null;
}

/**
 * 列表状态读取的作用域：由**路由**经 `resolveBinding` 解析后传入（本文件不自己解析绑定）。
 *
 * 为什么不在这里读绑定：`resolveBinding` 是控制面身份解析的唯一口径（含「台账缺行 + 绑定还在」时按需引导
 * **自愈**），发布、运行日志、发布记录三条读路径都走它。本文件若改用原始仓储读（`findTenantBinding`），
 * 就会在台账缺行时**静默降级为未知**，而同一页面的其它读路径正在自愈——两处读路径给出两个真相
 * （2026-10-09 实测：列表「状态未知」，同一时刻发布日志「当前版本 v0.0.4 正确」）。
 */
export interface WorkflowPublishStatusScope {
  /** 可用的平台空间（`space_id` 注入源）；null 表示绑定不可用，此时状态一律未知且**不发出站**。 */
  readonly platformSpaceId: string | null;
  /** 空间不可用的原因标签（`resolveBinding` 的 kind）；只进日志，回答「为什么这一页状态是未知」。 */
  readonly unavailableReason: string | null;
}

/** 列表项 + 上游发布状态（路由直接序列化的形状）。 */
export interface WorkflowListStatusItem extends WorkflowListItem, WorkflowPublishStatus {}

export interface WorkflowListStatusPage {
  readonly items: WorkflowListStatusItem[];
  readonly total: number;
}

/** 一次状态读取的入参。 */
export interface WorkflowPublishStatusInput {
  /** 注入的 `space_id`（平台个人空间）；客户端自报的同名字段不参与。 */
  readonly spaceId: string;
  /** 本次要读的 workflow（上游 ID）；顺序即结果 map 的补全顺序。 */
  readonly upstreamWorkflowIds: readonly string[];
}

/** 上游调用端口；与 `callUpstream` 同形，缺省即真实实现（测试注入替身，不触达真实上游与会话）。 */
export type WorkflowPublishStatusUpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 上游业务成功 = HTTP 200 且 `code === 0`（与写路径同口径）。 */
function isUpstreamSuccess(result: UpstreamCallResult): boolean {
  return result.status === 200 && isRecord(result.body) && result.body.code === 0;
}

/** 读嵌套字段；路径不存在或值不是对象时返回 null。 */
function readPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (!isRecord(current)) return null;
    current = current[key];
  }
  return current ?? null;
}

/** 非空字符串才算「有值」：上游对未设置的字符串字段既可能省略也可能回空串，两者都归一成 null。 */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 有条目 + 版本非空 = 已发布；有条目 + 版本为空 = 上游说「未发布」（见 {@link parseWorkflowPublishStatuses}）。 */
function statusFromVersion(version: string | null): WorkflowPublishStatus {
  return version === null
    ? { publishState: "unpublished", publishedVersion: null }
    : { publishState: "published", publishedVersion: version };
}

/**
 * 上游响应 → 每个请求 id 的状态。
 *
 * 三类判定，逐条都有实测依据：
 * - 有条目 + `latest_flow_version` 非空 → 已发布（版本号）；
 * - 有条目 + 版本为空 → **确实未发布**（上游对未发布回空串）；
 * - **没有条目 → 未知**：上游省略不认识的 id（实测 100 个 filter 里 99 个不存在的 id 被省略），而本地登记
 *   的上游对象本应存在——差异可能来自上游已删除、空间切换或上游行为变化，任何解释都不是「未发布」的证据。
 *
 * 请求之外的 id 一律忽略（上游若放宽过滤语义，也不会把别的 workflow 的版本挂到本页条目上）。
 */
export function parseWorkflowPublishStatuses(
  body: unknown,
  requestedIds: readonly string[],
): Map<string, WorkflowPublishStatus> {
  const resolved = new Map<string, WorkflowPublishStatus>();
  const entries = readPath(body, ["data"]);
  if (Array.isArray(entries)) {
    const requested = new Set(requestedIds);
    for (const entry of entries) {
      const workflowId = readNonEmptyString(readPath(entry, ["workflow_id"]));
      if (workflowId === null || !requested.has(workflowId)) continue;
      resolved.set(workflowId, statusFromVersion(readNonEmptyString(readPath(entry, ["latest_flow_version"]))));
    }
  }
  return new Map(requestedIds.map((id) => [id, resolved.get(id) ?? UNKNOWN_STATUS]));
}

/**
 * 批量读取上游当前发布版本；**不抛错**（失败原因经返回值带回，理由见文件头）。
 *
 * 失败隔离：一次请求覆盖一批 id，失败即整批 `unknown`——调用方的呈现层必须把它与「确实未发布」分开，
 * 而不是把读不到当成没有（这正是本次报障的错误方向）。熔断打开时由 `callUpstream` 直接短路，同样落到
 * `unknown`，不会阻塞页面。
 */
export async function readUpstreamPublishStatuses(
  input: WorkflowPublishStatusInput,
  options: { readonly callUpstream?: WorkflowPublishStatusUpstreamCall } = {},
): Promise<WorkflowPublishStatusRead> {
  const unknownAll = () => new Map(input.upstreamWorkflowIds.map((id) => [id, UNKNOWN_STATUS]));
  // 空集（本页无记录）不发请求：既无 id 可查，也不该为一次空翻页付出出站代价。
  if (input.upstreamWorkflowIds.length === 0) return { statuses: new Map(), failure: null };
  const upstream = options.callUpstream ?? callUpstream;

  let result: UpstreamCallResult;
  try {
    result = await upstream({
      path: WORKFLOW_DETAIL_INFO_PATH,
      body: {
        space_id: input.spaceId,
        workflow_filter_list: input.upstreamWorkflowIds.map((workflowId) => ({ workflow_id: workflowId })),
      },
      timeoutMs: PUBLISH_STATE_TIMEOUT_MS,
    });
  } catch (error) {
    return { statuses: unknownAll(), failure: { kind: "transport", error } };
  }

  if (!isUpstreamSuccess(result)) return { statuses: unknownAll(), failure: { kind: "upstream", result } };
  return { statuses: parseWorkflowPublishStatuses(result.body, input.upstreamWorkflowIds), failure: null };
}

/**
 * 列表读路径：本地注册表的一页 + 上游发布状态投影（列表路由的唯一入口）。
 *
 * 绑定不可用（scope 里没有空间）时**不发上游请求**：那种状态下列表页渲染的是引导屏，状态列不会上屏；这里只把
 * 状态置为未知并留一条带原因标签的 warn 日志，供排查「为什么状态是未知」。
 *
 * 上游读取失败同样只降级状态列（warn 日志留证），列表本身照常返回——「状态没读到」不该升级成「列表打不开」。
 */
export async function listWorkflowsWithPublishStatus(
  orgId: string,
  input: WorkflowListInput,
  scope: WorkflowPublishStatusScope,
  options: { readonly callUpstream?: WorkflowPublishStatusUpstreamCall } = {},
): Promise<WorkflowListStatusPage> {
  const page: WorkflowListPage = await listWorkflows(orgId, input);
  if (page.items.length === 0) return { items: [], total: page.total };

  if (scope.platformSpaceId === null) {
    logger.warn("workflow-v2 租户绑定不可用，列表发布状态按未知呈现", {
      organizationId: orgId,
      reason: scope.unavailableReason,
      items: page.items.length,
    });
    return { items: page.items.map((item) => ({ ...item, ...UNKNOWN_STATUS })), total: page.total };
  }

  const read = await readUpstreamPublishStatuses(
    { spaceId: scope.platformSpaceId, upstreamWorkflowIds: page.items.map((item) => item.upstreamWorkflowId) },
    options,
  );
  if (read.failure !== null) {
    logger.warn("workflow-v2 列表发布状态读取失败，状态列按未知呈现", {
      organizationId: orgId,
      stage: read.failure.kind,
      upstreamStatus: read.failure.kind === "upstream" ? read.failure.result.status : null,
      upstreamCode: read.failure.kind === "upstream" ? readPath(read.failure.result.body, ["code"]) : null,
      items: page.items.length,
    });
  }
  return {
    items: page.items.map((item) => ({ ...item, ...(read.statuses.get(item.upstreamWorkflowId) ?? UNKNOWN_STATUS) })),
    total: page.total,
  };
}
