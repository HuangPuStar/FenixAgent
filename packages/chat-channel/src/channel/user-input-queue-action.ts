// packages/chat-channel/src/channel/user-input-queue-action.ts
// Peri 待发送队列（steer）三类 Action 的执行：代号解析 → 出站 → 等待 peri 回执 → 收敛。
//
// 与 session-mutation-action.ts 同模式：从 session-channel 抽出的命令实现（该文件已接近
// 单文件行数红线）。四条不变量：
// - sessionId / generation / commandId 是服务端权威值，浏览器传入一律不可信
//   （sessionId 来自连接绑定的 acpSessionId，generation 来自 Session Doc 投影）；
// - generation 未知时先补拉一次 snapshot（读操作），拿不到即明确失败，绝不猜值
//   （猜错会让 peri 以 -32602 拒绝整条命令，用户白等一个往返）；
// - CommandId 原样转交 peri：端到端幂等键，重复提交只在 peri 侧入队一次；
// - 本路径不写 Chat Doc：peri 的 user_input_delivered 是 canonical transcript 的
//   唯一写入信号（重复写入会让聊天区出现两条同样的用户气泡）。

import {
  buildUserInputQueueSnapshotRequest,
  toPeriMessageContent,
  translateSimpleAction,
} from "../protocol/translator";
import type { DocManager } from "../state/doc-manager";
import { readUserInputQueue, setUserInputQueueEnabled } from "../state/user-input-queue";
import type {
  SharedRelay,
  UserInputRequestHandle,
  UserInputRequestKind,
  UserInputRequestOutcome,
} from "./connection-types";
import type { SessionConnection } from "./session-channel";
import type { Command, CommandOutcome } from "./types";
import { CommandExecutionError, isUserInputQueueAction } from "./types";
import { DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS, registerUserInputRequest } from "./user-input-pending";

export interface UserInputQueueActionDependencies {
  docManager: DocManager;
  /** 诊断日志（不得包含内容正文等敏感信息） */
  reportError: (message: string, error: unknown) => void;
  /** 等待 peri 回执的上限（毫秒），缺省 DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS（测试注入更短值） */
  timeoutMs?: number;
}

/** relay 侧发送能力：SessionConnection 与 SharedRelay 两种来源适配成同一形状 */
interface UserInputQueueRelayBinding {
  rcsSessionId: string;
  workspacePath: string | null;
  sendToRelay: (message: Record<string, unknown>) => Promise<void> | void;
  getNextRpcId: () => number;
  registerRequest: (rpcId: number | string, kind: UserInputRequestKind, timeoutMs: number) => UserInputRequestHandle;
}

/**
 * steer Action 前置校验（CommandCoordinator 不发 accepted）：属主身份 + payload 形状。
 * 失败即浏览器看到一次明确错误，而不是进入执行后才失败。
 */
export function validateUserInputQueueAction(connection: SessionConnection, command: Command): void {
  // 只读 observer（非环境属主连接）不得发起会话写操作：前端可能误发，服务端必须拒绝。
  // ownerUserId 缺省（旧装配）时不做判定——当前 /acp/yjs 只放行环境属主，属纵深防御。
  if (connection.ownerUserId && connection.ownerUserId !== connection.userId) {
    throw new CommandExecutionError("ACTION.FORBIDDEN");
  }
  const payload = command.payload;
  if (command.type === "dispatch_user_inputs") {
    const inputIds = payload.inputIds;
    if (!Array.isArray(inputIds) || inputIds.length === 0 || !inputIds.every(isNonEmptyString)) {
      throw new CommandExecutionError("ACTION.INVALID_STATE");
    }
    return;
  }
  if (!isNonEmptyString(payload.inputId)) {
    throw new CommandExecutionError("ACTION.INVALID_STATE");
  }
  if (command.type === "enqueue_user_input") {
    // 空内容既不该占用队列容量（PENDING_CAPACITY=32），也不该产生一个空气泡
    const content = toPeriMessageContent(payload.content);
    const empty = typeof content === "string" ? content.length === 0 : content.length === 0;
    if (empty) throw new CommandExecutionError("ACTION.INVALID_STATE");
  }
}

/**
 * 执行一条 steer Action（enqueue / dispatch / takeback）。
 * 成功 → committed ack；失败/超时/断连 → CommandExecutionError（CommandCoordinator 转成
 * 带 commandId 的 action_error，浏览器据此提示并允许重试；失败已清去重记录）。
 */
export async function executeUserInputQueueAction(
  dependencies: UserInputQueueActionDependencies,
  connection: SessionConnection,
  command: Command,
): Promise<CommandOutcome> {
  if (!isUserInputQueueAction(command.type)) throw new CommandExecutionError("ACTION.INVALID_STATE");
  // sessionId 是服务端权威值：来自连接绑定的 acpSessionId（load/create 后经 syncSessionId 更新）。
  // 未绑定 ACP 会话时不存在队列，直接拒绝而不是发出缺 sessionId 的请求。
  const sessionId = connection.acpSessionId;
  if (!sessionId) throw new CommandExecutionError("ACTION.INVALID_STATE");

  const { docManager } = dependencies;
  const binding = createConnectionBinding(connection);
  const generation = await resolveQueueGeneration({
    docManager,
    binding,
    sessionId,
    reportError: dependencies.reportError,
    timeoutMs: dependencies.timeoutMs,
  });

  const rpcId = binding.getNextRpcId();
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS;
  const rpc = translateSimpleAction(
    // 出站字段显式重组：sessionId 用服务端权威值覆盖 payload 里的同名客户端字段，
    // generation / commandId 只从 context 读取（浏览器传值一律不参与）
    { action: command.type, ...command.payload, sessionId },
    binding.workspacePath,
    rpcId,
    { generation, commandId: command.commandId },
  );
  // 登记在翻译之后：翻译失败（权威字段缺失等编程错误）不得留下无人消费的在途登记
  const request = binding.registerRequest(rpcId, requestKindOf(command.type), timeoutMs);
  try {
    await binding.sendToRelay(rpc);
  } catch (error) {
    request.cancel();
    dependencies.reportError(`[SessionChannel] relay send failed: action=${command.type}`, error);
    throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
  }

  const outcome = await request.completed;
  if (!outcome.ok) {
    dependencies.reportError(`[SessionChannel] user input queue action failed: action=${command.type}`, {
      reason: outcome.reason,
      publicErrorType: outcome.publicErrorType,
    });
    throw new CommandExecutionError(outcome.publicErrorType);
  }
  return {};
}

/**
 * 能力协商后的队列快照补拉（relay 层在 status 就绪与 ACP 会话绑定后调用，fire-and-forget）：
 * - 未协商能力 → 不补拉（不发请求），读取侧兜底 enabled=false 回退旧路径；
 * - 同一 ACP 会话只补拉一次（status 会重复 resend；换会话按新 sessionId 重新补拉，队列不跨会话）；
 * - 成功 → 投影 enabled=true（快照本身由响应收敛路径写入）；
 * - 失败 → enabled=false 且不影响会话可用性（前端继续直发 prompt）。
 */
export async function ensureUserInputQueueSnapshot(options: {
  shared: SharedRelay;
  sessionId: string | null;
  docManager: DocManager;
  reportError: (message: string, error: unknown) => void;
  timeoutMs?: number;
}): Promise<void> {
  const { shared, sessionId, docManager } = options;
  if (!shared.userInputQueueCapability) return;
  // 会话未绑定：无 sessionId 的 snapshot 无意义，等下次 status / 绑定完成后再拉
  if (!sessionId) return;
  if (shared.userInputSnapshotSessionId === sessionId) return;
  shared.userInputSnapshotSessionId = sessionId;

  const outcome = await requestQueueSnapshot(createSharedRelayBinding(shared), sessionId, options.timeoutMs);
  const ydoc = docManager.getSessionYdoc(shared.rcsSessionId);
  if (ydoc) setUserInputQueueEnabled(ydoc, outcome.ok);
  if (!outcome.ok) {
    options.reportError("[YJS-FE] user input queue snapshot pull failed", {
      reason: outcome.reason,
      publicErrorType: outcome.publicErrorType,
    });
  }
}

/** 发送一次 snapshot 请求并等待回执（快照的投影写入在响应收敛路径完成） */
export async function requestQueueSnapshot(
  binding: UserInputQueueRelayBinding,
  sessionId: string,
  timeoutMs?: number,
): Promise<UserInputRequestOutcome> {
  const rpcId = binding.getNextRpcId();
  const request = binding.registerRequest(rpcId, "snapshot", timeoutMs ?? DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS);
  try {
    await binding.sendToRelay(buildUserInputQueueSnapshotRequest(sessionId, rpcId));
  } catch (error) {
    request.cancel();
    void error;
    return { ok: false, reason: "relay_closed", publicErrorType: "ACTION.AGENT_UNAVAILABLE" };
  }
  return request.completed;
}

/**
 * 解析队列代号（服务端权威）：
 * 1. 投影里已有（能力补拉或事件写入过）→ 直接用；
 * 2. 没有（首次入队 / 换代号 / 会话切换后的空投影）→ 先补拉一次快照再继续；
 * 3. 补拉失败或补齐后仍无代号 → 明确失败（不猜值、不重试）。
 */
async function resolveQueueGeneration(options: {
  docManager: DocManager;
  binding: UserInputQueueRelayBinding;
  sessionId: string;
  reportError: (message: string, error: unknown) => void;
  timeoutMs?: number;
}): Promise<string> {
  const projected = readProjectedGeneration(options.docManager, options.binding.rcsSessionId);
  if (projected) return projected;

  const outcome = await requestQueueSnapshot(options.binding, options.sessionId, options.timeoutMs);
  if (!outcome.ok) {
    options.reportError("[SessionChannel] queue snapshot pull failed before steer action", {
      reason: outcome.reason,
      publicErrorType: outcome.publicErrorType,
    });
    throw new CommandExecutionError(outcome.publicErrorType);
  }
  const refreshed = readProjectedGeneration(options.docManager, options.binding.rcsSessionId);
  // 快照已成功但投影没落（会话 Doc 不在内存 / 形状不被接受）：仍然不猜代号
  if (!refreshed) throw new CommandExecutionError("ACTION.INVALID_STATE");
  return refreshed;
}

/** 读取投影中的队列代号（无会话 Doc 或尚无快照时为 null） */
function readProjectedGeneration(docManager: DocManager, rcsSessionId: string): string | null {
  const ydoc = docManager.getSessionYdoc(rcsSessionId);
  return ydoc ? readUserInputQueue(ydoc).generation : null;
}

/** SessionConnection → relay 绑定（awaitUserInputRequest 未注入时报 AGENT_UNAVAILABLE） */
function createConnectionBinding(connection: SessionConnection): UserInputQueueRelayBinding {
  return {
    rcsSessionId: connection.rcsSessionId,
    workspacePath: connection.workspacePath,
    sendToRelay: (message) => connection.sendToRelay(message),
    getNextRpcId: () => connection.getNextRpcId(),
    registerRequest: (rpcId, kind, timeoutMs) => {
      const handle = connection.awaitUserInputRequest?.(rpcId, kind, timeoutMs);
      if (!handle) throw new CommandExecutionError("ACTION.AGENT_UNAVAILABLE");
      return handle;
    },
  };
}

/** SharedRelay → relay 绑定（relay 层能力补拉用：无连接上下文，rpcId 与发送都取自共享 relay） */
function createSharedRelayBinding(shared: SharedRelay): UserInputQueueRelayBinding {
  return {
    rcsSessionId: shared.rcsSessionId,
    workspacePath: shared.workspacePath,
    sendToRelay: async (message) => {
      await shared.handle.send(message as never);
    },
    getNextRpcId: () => ++shared.nextRpcId,
    registerRequest: (rpcId, kind, timeoutMs) => registerUserInputRequest(shared, { rpcId, kind, timeoutMs }),
  };
}

/** Action 类型 → 请求类别（诊断与响应形状判定用） */
function requestKindOf(action: string): UserInputRequestKind {
  if (action === "dispatch_user_inputs") return "dispatch";
  if (action === "takeback_user_input") return "takeback";
  return "enqueue";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
