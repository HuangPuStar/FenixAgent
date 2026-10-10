/**
 * 对外触发：以平台账号 PAT 调上游 `POST /v1/workflow/run` 运行**已发布版本**。
 *
 * 语义由上游定义（`ApplicationService.OpenAPIRun`）：执行配置固定 `From: FromSpecificVersion` +
 * `LatestPublishedVersion` + `ExecuteModeRelease`，因此「跑的是哪个版本」不由本模块决定，请求里的 `version`
 * 字段在当前上游构建里被忽略（已登记为已知差距）。同步返回 `data`（执行结果，通常是 JSON 序列化字符串）与
 * `execute_id`/`token`/`cost`，异步只返回 `execute_id`/`debug_url`。
 *
 * 为什么归属没有在这里判：上游 `checkUserSpace` 只校验「PAT 所属用户属于该 workflow 的 space」，**不校验
 * workflow ↔ App/组织的归属**——多租户隔离完全由本地注册表在路由层兜住（ADR §4）。本模块只负责「怎么调、
 * 怎么归一化」，输入里的上游 workflow ID 已由调用方按组织谓词解析过。
 *
 * 响应口径：`/api/*` 面归一化为**域形状**（`{ executeId, data, token, cost, debugUrl }`，字段缺失为 null 不省略
 * 键），不原样回传上游信封；业务失败映射为平台稳定错误码，传输层失败直接抛给路由层按既有口径分流
 * （超时 504 / 网络 502 / 会话 503 / 熔断 503，与 `/web` 面同一张表）。
 */

import { createLogger } from "@fenix/logger";
import { UPSTREAM_PANIC_CODE, type UpstreamCallResult, type UpstreamOpenApiCallInput } from "./upstream-client";

const logger = createLogger("wf2-workflow-run");

/** 上游 OpenAPI 面唯一的运行入口。 */
const RUN_PATH = "/v1/workflow/run";

/**
 * 上游业务码（`WorkflowError.OpenAPICode()` 的映射结果，见上游 `errnoMap` 与我方需要行动的三枚）。
 *
 * 只登记**调用方可据此行动**的码：未发布（先发布再调）、参数不合法（改参数）、当前发布版本未登记到 API
 * 渠道（平台侧自愈的对象，见 `api-channel-release.ts`）；其余码（含 panic 兜底的 777777775）一律按
 * 「上游拒绝了本次请求」处理，不逐个透出——逐个映射等于把上游的实现细节固化成我方契约。
 *
 * 为什么 `777777778` 要单独映射：上游把它当作内部错误抛出（不在 `errnoMap` 里，`msg` 只给通用的
 * "Service Internal Error"），而它实际是**固定契约缺前置条件**——`connector_workflow_version` 里没有该
 * workflow 当前版本的登记行。不映射的话调用方只看到 502「上游拒绝」，无从判断能不能自己修。
 */
const UPSTREAM_RUN_CODE_BAD_REQUEST = 4000;
const UPSTREAM_RUN_CODE_NOT_PUBLISHED = 6031;
const UPSTREAM_RUN_CODE_VERSION_NOT_REGISTERED = 777777778;

/**
 * 「当前发布版本未登记到 API 渠道」的平台错误码；路由层据此触发 `ensureApiChannelRelease` 自愈后重试一次。
 *
 * 与 {@link UPSTREAM_RUN_CODE_VERSION_NOT_REGISTERED} 分开命名：前者是我方稳定契约，后者是上游实现细节，
 * 上游哪天换了码值，只有这个常量所在的映射函数需要改。
 */
export const WORKFLOW_NOT_REGISTERED_CODE = "WORKFLOW_NOT_REGISTERED_TO_API_CHANNEL";

/** 归一化后的运行结果；上游缺失的字段一律 null（不造默认值、不省略键）。 */
export interface WorkflowRunSummary {
  /** 执行 ID：同步与异步都返回（上游 `execute_id`）。 */
  readonly executeId: string | null;
  /** 同步执行的输出（上游 `data`，通常是 JSON 序列化字符串）；异步与未命中时为 null。 */
  readonly data: string | null;
  /** 本次消耗的 token 数（上游 `token`）。 */
  readonly token: number | null;
  /** 本次消耗（上游 `cost`，字符串形态）。 */
  readonly cost: string | null;
  /** 上游调试页地址（上游 `debug_url`）。 */
  readonly debugUrl: string | null;
}

/**
 * 业务失败映射结果：HTTP 状态 + 平台稳定错误码 + 审计标签。
 *
 * 形状与路由层的 `HttpFailure` 结构一致（不 import 它：那是路由面的类型，服务层不反向依赖路由），
 * `auditResult` 恒为 `upstream_rejected`——能走到这里说明上游活着并明确拒绝了这次运行。
 */
export interface WorkflowRunRejection {
  readonly httpStatus: number;
  readonly code: string;
  readonly message: string;
  readonly auditResult: "upstream_rejected";
}

/** 运行结果：成功带归一化结果，业务失败带映射后的拒绝信息（传输失败直接抛，不在本类型里表达）。 */
export type WorkflowRunOutcome =
  | { readonly ok: true; readonly run: WorkflowRunSummary }
  | { readonly ok: false; readonly rejection: WorkflowRunRejection };

/** 上游调用端口；与 `callUpstreamOpenApi` 同形，缺省即真实实现（测试注入替身，不触达真实上游与凭据）。 */
export type WorkflowRunCall = (input: UpstreamOpenApiCallInput) => Promise<UpstreamCallResult>;

export interface WorkflowRunInput {
  /** 上游 workflow ID（已由调用方按组织谓词解析）。 */
  readonly upstreamWorkflowId: string;
  /** 参数（JSON 字符串，已归一化）；未提供时为 null。 */
  readonly parameters: string | null;
  /** 异步运行（上游立即返回 `execute_id`，不等待结果）。 */
  readonly isAsync: boolean;
  /** 运行时用户（上游 `ext.user_id`）；未提供时为 null。 */
  readonly runtimeUserId: string | null;
}

/** 参数归一化结果：可用的 JSON 字符串，或一条面向调用方的固定文案（不回显候选值）。 */
export type RunParametersResult =
  | { readonly ok: true; readonly parameters: string | null }
  | { readonly ok: false; readonly message: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 归一化请求里的 `parameters`（对象或 JSON 字符串）成上游要的 JSON 字符串。
 *
 * 对象的键必须是字符串（JSON 语义如此）；字符串必须解析成一个 **JSON 对象**——上游把它 `Unmarshal` 进
 * `map[string]any`，数组或标量会被判成参数错误。本地先判一次是为了不让一次必然失败的请求打到上游
 * （省一次往返，也让调用方拿到 422 而不是 502）。
 */
export function normalizeRunParameters(value: unknown): RunParametersResult {
  if (value === undefined || value === null) return { ok: true, parameters: null };
  if (typeof value === "object" && !Array.isArray(value)) {
    return { ok: true, parameters: JSON.stringify(value) };
  }
  if (typeof value !== "string") return { ok: false, message: "parameters 必须是 JSON 对象或 JSON 字符串" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { ok: false, message: "parameters 不是合法的 JSON 字符串" };
  }
  if (!isRecord(parsed)) return { ok: false, message: "parameters 解析后必须是 JSON 对象" };
  return { ok: true, parameters: value };
}

/** 读信封里的字段（上游成功响应是扁平的 `{ code, msg, data, token, cost, debug_url, execute_id }`）。 */
function readField(body: unknown, key: string): unknown {
  return isRecord(body) ? body[key] : null;
}

/** 读字符串字段：缺失或类型不符时为 null（不把数字当字符串用）。 */
function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** 读整数字段：缺失或类型不符时为 null。 */
function readInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

/** 上游业务成功 = HTTP 200 且 `code === 0`（业务失败多为 HTTP 200 + `code≠0`）。 */
function isSuccess(result: UpstreamCallResult): boolean {
  return result.status === 200 && readField(result.body, "code") === 0;
}

/**
 * 业务码 → 平台稳定错误（只映射可行动的两枚，其余归入通用的「上游拒绝」）。
 *
 * 消息一律是我方固定文案：上游 `msg` 在 panic 分支是 Go 堆栈（含绝对路径与函数名），永不进入响应；
 * 业务码本身进日志供排障，不进响应体。
 */
function mapBusinessCode(code: number | null): WorkflowRunRejection {
  if (code === UPSTREAM_RUN_CODE_NOT_PUBLISHED) {
    return {
      httpStatus: 409,
      code: "WORKFLOW_NOT_PUBLISHED",
      message: "工作流尚未发布，对外接口只能运行已发布版本",
      auditResult: "upstream_rejected",
    };
  }
  if (code === UPSTREAM_RUN_CODE_BAD_REQUEST) {
    return {
      httpStatus: 422,
      code: "INVALID_PARAMETERS",
      message: "上游判定运行参数不合法",
      auditResult: "upstream_rejected",
    };
  }
  if (code === UPSTREAM_RUN_CODE_VERSION_NOT_REGISTERED) {
    return {
      // 409：目标状态与前置条件冲突（该版本还没登记到 API 渠道），不是「上游崩了」，也不该被当成可重试的 502。
      httpStatus: 409,
      code: WORKFLOW_NOT_REGISTERED_CODE,
      message: "工作流当前发布版本尚未登记到 API 渠道，平台正在尝试自动补登记，请稍后重试",
      auditResult: "upstream_rejected",
    };
  }
  return {
    httpStatus: 502,
    code: "UPSTREAM_REJECTED",
    message: "上游拒绝了本次运行请求",
    auditResult: "upstream_rejected",
  };
}

/** 把上游成功响应归一化成域形状（字段缺失为 null，不省略键）。 */
function toSummary(body: unknown): WorkflowRunSummary {
  return {
    executeId: readString(readField(body, "execute_id")),
    data: readString(readField(body, "data")),
    token: readInteger(readField(body, "token")),
    cost: readString(readField(body, "cost")),
    debugUrl: readString(readField(body, "debug_url")),
  };
}

/**
 * 运行一次已发布工作流。
 *
 * 不自动重试：上游**没有幂等键**，重试会产生多次真实运行（设计 §4.7「写接口不重试」）；传输失败由调用方
 * 决定是否让调用方自己重试。
 *
 * `ext` 只放受控字段（当前仅 `user_id`）：它是上游的运行时用户标识，客户端自报的其他键会一路透到上游
 * 业务侧，属于不可信输入，因此不开放任意透传。
 */
export async function runPublishedWorkflow(
  input: WorkflowRunInput,
  deps: { readonly callUpstreamOpenApi: WorkflowRunCall },
): Promise<WorkflowRunOutcome> {
  const result = await deps.callUpstreamOpenApi({
    path: RUN_PATH,
    body: {
      workflow_id: input.upstreamWorkflowId,
      // 上游 `Ext` 是必填 map：空对象与省略在 Go 侧等价，显式给 `{}` 让出站请求体形态稳定（可被用例断言）。
      ext: input.runtimeUserId === null ? {} : { user_id: input.runtimeUserId },
      ...(input.parameters === null ? {} : { parameters: input.parameters }),
      is_async: input.isAsync,
    },
  });

  if (isSuccess(result)) return { ok: true, run: toSummary(result.body) };

  const code = readField(result.body, "code");
  const upstreamCode = typeof code === "number" ? code : null;
  logger.error("对外触发运行被上游拒绝", {
    upstreamStatus: result.status,
    upstreamCode,
    // 上游 msg 只在非 panic 时截断入日志：panic 码的 msg 是 Go 堆栈，一个字都不进日志。
    upstreamMsg:
      upstreamCode === UPSTREAM_PANIC_CODE
        ? "<panic stack redacted>"
        : String(readField(result.body, "msg") ?? "").slice(0, 200),
  });
  return { ok: false, rejection: mapBusinessCode(upstreamCode) };
}
