/**
 * 控制面发布闭环（3B）：版本自增 + 上游 `publish` 调用 + 业务拒绝的分类。
 *
 * 版本号格式与步长的依据（**不是猜测**，全部来自关联上游工作流引擎 仓的权威源码）：
 * - thrift 生成物 `PublishWorkflowRequest.WorkflowVersion` 的注释写明：「Required, the version number of
 *   the published workflow, in **SemVer format "vx.y.z"**, must be larger than the current version」；
 * - 服务端 `parseVersion`（`backend/domain/workflow/service/utils.go`）只接受「`v` 前缀 + 恰好三段整数」，
 *   否则返回 `ErrInvalidVersionName = 777777769`；`isIncremental` 要求新版本在 (major, minor, patch) 上
 *   **严格大于**已发布版本，否则 `777777775 the version number is not self-incrementing`；
 * - 首次发布用什么版本、后续怎么加：上游自己的发布对话框
 *   （`frontend/packages/workflow/playground/.../publish-with-version-v2.tsx` 的 `getDefaultVersion`）
 *   给的是 `workflow_version ? 'v' + semver.inc(version, 'patch') : 'v0.0.1'`——即**首发布 v0.0.1、其后
 *   patch 自增**。本模块照此口径生成，与上游控制台的行为一致（用户在两处看到的版本号序列相同）。
 *
 * 为什么版本由本地注册表推导而不是读上游：契约快照 F3 实测「`workflow_detail.version` 在发布前后均为空
 * 串」，上游没有可靠的「当前发布版本」读接口；本地 `workflow_v2_workflow.published_version` 因此是版本
 * 自增的唯一依据（设计 §4.2 的 publish 行）。代价见回报中的开放问题：画布内经 BFF 的 publish 不透传登记
 * 该列，若用户在画布里发布，本地版本会落后并导致下一次发布被上游以「未自增」拒绝——这属于对账任务（4A）
 * 的输入，本模块不猜测、不静默兜底。
 *
 * `force` 的语义**有据可依**（不是「拿不准」）：上游 thrift 注释写明「If the TestRun step was executed
 * before the process was published, the force parameter value should be false, or not passed; if the TestRun
 * step was not executed..., the force parameter value should be true」，服务端
 * `if !policy.Force && !draft.TestRunSuccess { ... needs to pass the test run before publishing }`。因此
 * `force: true` = **跳过「当前草稿必须先通过一次 test_run」的前置校验**；缺省（不传）保持上游默认的严格
 * 口径，控制台要强制发布时显式传 `force: true`。
 */

import { createLogger } from "@fenix/logger";
import { callUpstream, UPSTREAM_PANIC_CODE, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";

const logger = createLogger("wf2-publish");

/** 首次发布的初始版本：与上游控制台 `getDefaultVersion` 的 `v0.0.1` 同口径（见文件头）。 */
export const INITIAL_PUBLISH_VERSION = "v0.0.1";

/** 版本形状：`v` + 三段整数（上游 `parseVersion` 的唯一接受形状）。 */
const PUBLISH_VERSION_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

/**
 * 上游「版本名非法」业务码（契约快照 §2 第 20 行 / 上游 `errno.ErrInvalidVersionName`）。
 *
 * 只在本模块声明为私有常量：冻结 §4 的导出常量表（鉴权失败码、panic 码）是对外契约，不因发布闭环扩容。
 */
const UPSTREAM_INVALID_VERSION_NAME_CODE = 777777769;

/** 上游两种 `777777775` 的区分文案（取自上游服务端 `service_impl.go` 的字面量）。 */
const REJECTION_DRAFT_NOT_VERIFIED = "needs to pass the test run before publishing";
const REJECTION_VERSION_NOT_INCREMENTAL = "not self-incrementing";

export interface WorkflowVersionParts {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

/** 解析 `vx.y.z`；不合法返回 null（调用方据此拒绝发布，而不是猜一个版本号送上去）。 */
export function parsePublishVersion(version: string): WorkflowVersionParts | null {
  const matched = PUBLISH_VERSION_PATTERN.exec(version.trim());
  if (matched === null) return null;
  return { major: Number(matched[1]), minor: Number(matched[2]), patch: Number(matched[3]) };
}

/**
 * 下一个发布版本：未发布过（null）取 {@link INITIAL_PUBLISH_VERSION}，否则同 major.minor 下 patch+1。
 *
 * 本地记录不可解析时返回 null——那种状态只可能来自「本模块之外写过的数据」，此时**拒绝发布**（调用方
 * 回 500 并留日志），不拿一个伪造的版本号去撞上游（撞上就是 777777775，错误信息还指向版本号，掩盖真因）。
 */
export function nextPublishVersion(publishedVersion: string | null): string | null {
  if (publishedVersion === null) return INITIAL_PUBLISH_VERSION;
  const current = parsePublishVersion(publishedVersion);
  if (current === null) return null;
  return `v${current.major}.${current.minor}.${current.patch + 1}`;
}

/** 上游拒绝的归一结果；`upstreamCode` 只进日志与审计，不进面向用户的响应。 */
export interface WorkflowPublishRejection {
  readonly httpStatus: number;
  readonly code: string;
  readonly message: string;
  readonly upstreamCode: number | null;
}

/** 发布结果：成功带生成版本与上游 commit id；失败带已归一化的控制面错误。 */
export type WorkflowPublishOutcome =
  | { readonly ok: true; readonly version: string; readonly commitId: string }
  | { readonly ok: false; readonly rejection: WorkflowPublishRejection };

export interface WorkflowPublishInput {
  readonly upstreamWorkflowId: string;
  /** 注入的 `space_id`（平台个人空间）；客户端自报的同名字段不参与。 */
  readonly spaceId: string;
  /** 本地注册表里的已发布版本；null 表示从未发布。 */
  readonly publishedVersion: string | null;
  /** 版本说明，映射到上游 `version_description`。 */
  readonly description?: string | undefined;
  /** true 时跳过上游「草稿必须先通过 test_run」的前置校验（见文件头）。 */
  readonly force?: boolean | undefined;
}

/** 上游调用端口；与 `callUpstream` 同形，缺省即真实实现（测试注入替身，不触达真实上游与会话）。 */
export type WorkflowPublishUpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

/** 读上游信封里的字符串字段；非字符串（含缺失）返回 null。 */
function readString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** 读上游信封 `data.<key>` 里的字符串字段；非字符串（含缺失）返回 null。 */
function readDataString(body: unknown, key: string): string | null {
  if (typeof body !== "object" || body === null) return null;
  return readString((body as Record<string, unknown>).data ?? null, key);
}

/** 读上游业务码；非数字返回 null。 */
function readCode(body: unknown): number | null {
  if (typeof body !== "object" || body === null) return null;
  const value = (body as Record<string, unknown>).code;
  return typeof value === "number" ? value : null;
}

/** 上游业务成功 = HTTP 200 且 `code === 0`（业务失败多为 HTTP 200 + `code≠0`，契约快照 §3 F5）。 */
function isUpstreamSuccess(result: UpstreamCallResult): boolean {
  return result.status === 200 && readCode(result.body) === 0;
}

/**
 * 业务拒绝 → 控制面错误。
 *
 * 上游把两类完全不同的失败都编码成 `777777775`（通用 operation fail），只靠业务码无法区分；两种语义的
 * 区分靠上游 `msg` 的两个固定短语（上文常量），这正是契约快照 F11「错误提示也要区分『草稿未验证』与
 * 『版本号非法』两种 777777775」的落地方式。区分不出来时退回通用「上游拒绝」，不猜。
 *
 * HTTP 状态：可被用户/前端修复的状态冲突（草稿未验证、版本未自增、版本名非法）用 **409**，其余上游拒绝用
 * **502**——三者都不是「重试就会好」的错误，502 会误导客户端自动重试。
 */
function classifyPublishRejection(result: UpstreamCallResult): WorkflowPublishRejection {
  const upstreamCode = readCode(result.body);
  const upstreamMessage = readString(result.body, "msg") ?? "";
  if (upstreamCode === UPSTREAM_PANIC_CODE) {
    if (upstreamMessage.includes(REJECTION_DRAFT_NOT_VERIFIED))
      return {
        httpStatus: 409,
        code: "WORKFLOW_DRAFT_NOT_VERIFIED",
        message: "当前草稿尚未通过调试运行，请先在画布中运行一次，或显式使用强制发布",
        upstreamCode,
      };
    if (upstreamMessage.includes(REJECTION_VERSION_NOT_INCREMENTAL))
      return {
        httpStatus: 409,
        code: "WORKFLOW_VERSION_NOT_INCREMENTAL",
        message: "发布版本号未严格递增，本地记录的版本可能落后于上游，请先对账",
        upstreamCode,
      };
    return { httpStatus: 502, code: "UPSTREAM_REJECTED", message: "上游拒绝了本次发布", upstreamCode };
  }
  if (upstreamCode === UPSTREAM_INVALID_VERSION_NAME_CODE)
    return {
      httpStatus: 409,
      code: "WORKFLOW_VERSION_INVALID",
      message: "上游认为该发布版本号非法（格式或名称）",
      upstreamCode,
    };
  return { httpStatus: 502, code: "UPSTREAM_REJECTED", message: "上游拒绝了本次发布", upstreamCode };
}

/**
 * 发布一个新版本：生成版本号 → 调上游 `publish` → 归一化结果。
 *
 * 上游必填字段按契约快照 §2 第 20 行：`workflow_id` / `space_id` / `has_collaborator` / `workflow_version`。
 * `has_collaborator` 恒为 false——平台账号是 FenixAgent 映射的唯一上游用户（设计 §3.1/§3.3），不存在
 * 协作者；该字段在上游已被标记为废弃（上游前端注释「Abandoned, to be deleted」），但 thrift 仍标 required。
 *
 * 传输/会话级失败（含熔断短路）**不在这里映射**：原样抛给调用方，由控制面的统一失败映射处理（与
 * create/update/delete 三条路由同一口径，避免第二套映射）。
 */
export async function publishWorkflowVersion(
  input: WorkflowPublishInput,
  options: { readonly callUpstream?: WorkflowPublishUpstreamCall } = {},
): Promise<WorkflowPublishOutcome> {
  const upstream = options.callUpstream ?? callUpstream;
  const version = nextPublishVersion(input.publishedVersion);
  if (version === null) {
    logger.error("本地注册表的发布版本号不可解析，拒绝发布", {
      upstreamWorkflowId: input.upstreamWorkflowId,
      publishedVersion: input.publishedVersion,
    });
    return {
      ok: false,
      rejection: {
        httpStatus: 500,
        code: "WORKFLOW_VERSION_UNPARSEABLE",
        message: "本地记录的发布版本号不可解析，需先对账修复后再发布",
        upstreamCode: null,
      },
    };
  }

  const result = await upstream({
    path: "/api/workflow_api/publish",
    body: {
      workflow_id: input.upstreamWorkflowId,
      space_id: input.spaceId,
      has_collaborator: false,
      workflow_version: version,
      ...(input.description === undefined ? {} : { version_description: input.description }),
      // 只在 true 时传：缺省保持上游默认（要求 test_run 通过），不把「强制」变成默认语义。
      ...(input.force === true ? { force: true } : {}),
    },
  });

  if (isUpstreamSuccess(result)) {
    return {
      ok: true,
      version,
      // 上游 `PublishWorkflowData.publish_commit_id` 当前恒为空串（Go 侧只回填 workflow_id/success，
      // 见 `application/workflow/workflow.go` 的 PublishWorkflow），这里如实回传而**不伪造**值。
      commitId: readDataString(result.body, "publish_commit_id") ?? "",
    };
  }
  const rejection = classifyPublishRejection(result);
  // 只记分类结果与业务码：上游 `msg`（尤其 panic 形态）可能带 Go 堆栈，不进日志正文。
  logger.error("workflow-v2 发布被上游拒绝", {
    upstreamWorkflowId: input.upstreamWorkflowId,
    version,
    upstreamStatus: result.status,
    upstreamCode: rejection.upstreamCode,
    rejection: rejection.code,
  });
  return { ok: false, rejection };
}
