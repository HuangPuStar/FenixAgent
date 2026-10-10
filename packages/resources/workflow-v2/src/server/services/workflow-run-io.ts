/**
 * 运行日志「出入参数」的读路径：按 `execute_id` 读上游 `GET /api/workflow_api/get_process`。
 *
 * 与 `workflow-run-records.ts`（清单）同属运行日志视图，但上游契约与产出形状都不同，因此独立成文件：
 * 清单读的是 `list_spans` 的 span + tags 摘要；这里读的是**节点级执行结果**——上游不提供运行级的
 * input/output 字段，出入参数按画布约定取 Start 节点的 `input` 与 End 节点的 `output`（回退 `raw_output`）。
 *
 * ## 上游契约（2026-10-10 实测，本地环境；样本：Start→End 空图运行）
 *
 * 标准信封 `{code, msg, data}`，`data.nodeResults[]` 每个节点 13 个字段（`nodeId` / `NodeType` / `NodeName` /
 * `nodeStatus` / `errorInfo` / `input` / `output` / `nodeExeCost` / `tokenAndCost` / `raw_output` / `errorLevel` /
 * `logVersion` / `extra`）；`input` / `output` 是 JSON 序列化字符串。**运行结束后仍可查**（实测终态
 * `executeStatus=2` 且 `code=0`），因此它不是「只对运行中有意义的轮询快照」。`NodeType` 回的是类型名
 * （`"Start"` / `"End"`）而不是 schema 里的 `"1"` / `"2"`；缺对应节点（如节点调试运行）时字段为 null，不猜。
 *
 * 三条负例（同批只读探针，设计记录 §3）：`execute_id` 不存在时上游回 **HTTP 200 + `code=0` + `nodeResults:null`
 * 的空壳**（不是失败，因此平台侧只能给 null）；`workflow_id` 不存在同样回 `code=0` 并把两个 id 原样回显
 * ——上游**不校验**运行与 workflow 的归属，归属判定只在平台侧（见路由 docblock 的边界说明）；缺
 * `execute_id` 会触发上游 panic（`code=777777775`，`msg` 是 Go 堆栈，路由层统一脱敏），本函数恒带该参数。
 * 契约快照「`execute_id` 可换 `log_id`」在本构建不成立：只传 `log_id` 同样 panic，因此只按 `execute_id` 查。
 *
 * `space_id` 由调用方从绑定行取（客户端不接触）：上游按「登录用户与工作流 space 的关系」授权。端点只挂 GET
 * （POST 调用返回 not found，见契约快照 §2 第 16 行）。
 *
 * 失败语义与其它控制面读路径同口径：传输/会话失败**原样抛**（路由层统一映射 502/503/504），上游业务失败
 * （非 2xx / `code≠0`）如实带回原始结果，路由层再映射。
 */

import { callUpstream, type UpstreamCallInput, type UpstreamCallResult } from "./upstream-client";

/** 上游运行过程端点；只挂 GET（POST 调用会 404）。 */
const GET_PROCESS_PATH = "/api/workflow_api/get_process";

/** 画布约定的节点类型名（实测 `NodeType` 回的是名字，不是 schema 里的 "1"/"2"）。 */
const START_NODE_TYPE = "Start";
const END_NODE_TYPE = "End";

/** 单次运行的出入参数；上游缺失时为 null（不造默认值、不省略键）。 */
export interface WorkflowRunIo {
  /** 运行输入 = Start 节点的 `input`（JSON 序列化字符串）。 */
  readonly input: string | null;
  /** 运行输出 = End 节点的 `output`（缺失时回退 `raw_output`）。 */
  readonly output: string | null;
}

/** 读取结果：上游业务失败如实带回原始响应，由路由层映射（见文件头）。 */
export type WorkflowRunIoOutcome =
  | { readonly ok: true; readonly io: WorkflowRunIo }
  | { readonly ok: false; readonly result: UpstreamCallResult };

/** 上游调用端口；与 `callUpstream` 同形，缺省即真实实现（测试注入替身，不触达真实上游与会话）。 */
export type WorkflowRunIoUpstreamCall = (input: UpstreamCallInput) => Promise<UpstreamCallResult>;

export interface WorkflowRunIoInput {
  /** 该次运行所属的上游 workflow ID（路由层已按本地注册表校验归属）。 */
  readonly upstreamWorkflowId: string;
  readonly executeId: string;
  /** 平台个人空间 ID（租户绑定行提供）。 */
  readonly platformSpaceId: string;
}

/**
 * 读取单次运行的出入参数。
 *
 * 返回 `ok: false` 表示上游明确拒绝（业务失败），调用方原样交给统一失败映射；抛出的异常表示传输/会话层失败。
 */
export async function fetchWorkflowRunIo(
  input: WorkflowRunIoInput,
  deps: { readonly callUpstream?: WorkflowRunIoUpstreamCall } = {},
): Promise<WorkflowRunIoOutcome> {
  const upstream = deps.callUpstream ?? callUpstream;
  const result = await upstream({
    path: GET_PROCESS_PATH,
    method: "GET",
    query: {
      workflow_id: input.upstreamWorkflowId,
      space_id: input.platformSpaceId,
      execute_id: input.executeId,
    },
  });
  if (!isGetProcessAccepted(result)) return { ok: false, result };
  return { ok: true, io: extractRunIo(result.body) };
}

/** 上游成功判定：HTTP 200 且顶层 `code === 0`（与运行清单同款标准信封）。 */
function isGetProcessAccepted(result: UpstreamCallResult): boolean {
  return result.status === 200 && isRecord(result.body) && result.body.code === 0;
}

/** 从 `data.nodeResults` 抽运行级出入参数：Start.input 与 End.output；缺节点或空串一律 null。 */
function extractRunIo(body: unknown): WorkflowRunIo {
  const nodeResults = readNodeResults(body);
  const start = nodeResults.find((node) => readNonEmptyString(node, ["NodeType"]) === START_NODE_TYPE);
  const end = nodeResults.find((node) => readNonEmptyString(node, ["NodeType"]) === END_NODE_TYPE);
  return {
    input: readNonEmptyString(start, ["input"]),
    output: readNonEmptyString(end, ["output"]) ?? readNonEmptyString(end, ["raw_output"]),
  };
}

/** `data.nodeResults` 数组；缺失或非数组都按「没有节点结果」处理（返回空数组，不猜）。 */
function readNodeResults(body: unknown): readonly unknown[] {
  const raw = readPath(body, ["data", "nodeResults"]);
  return Array.isArray(raw) ? raw : [];
}

/** 读嵌套字段；路径不存在或值为 null 时返回 null。 */
function readPath(body: unknown, path: readonly string[]): unknown {
  let current: unknown = body;
  for (const key of path) {
    if (current === null || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return current ?? null;
}

/** 非空字符串；其余形态（null / 数字 / 空串）一律 null——空串与「没有值」在上屏口径上不区分。 */
function readNonEmptyString(body: unknown, path: readonly string[]): string | null {
  const value = readPath(body, path);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
