// packages/chat-channel/src/state/aggregator.ts
// 聚合层（EventAggregator）：只消费规范化事件（NormalizedEvent），
// 投影到文档 5.2/5.3 新 schema。旧事件类型（agent_message_chunk 等）
// 的直接消费路径已删除，翻译只发生在 protocol/acp-channel.ts 边界。
//
// 映射幂等：以 turnId / entryId / toolCallId / permissionId 与终态状态机
// 确定写入目标——重放同一规范化事件不重复创建 Entry / 工具调用 / 权限请求；
// turn 终态后到达的同 turn 增量直接丢弃。
//
// 本模块为纯投影（无 I/O、无日志）；拒绝原因通过返回值交给调用方记录诊断。

import { type NormalizedEvent, type PublicError, TURN_TERMINAL_STATUSES, type TurnStatus } from "../schema";
import {
  addToolCallBlock,
  appendEntryText,
  bumpProjectionVersion,
  ensureEntry,
  getChatRoot,
  getEntry,
  getSessionRoot,
  getToolCallsMap,
  readActiveTurn,
  setActiveTurn,
  setAgentStatus,
  setEntryStatus,
  setEntryTokenUsage,
  setSessionInfo,
  upsertPendingPermission,
  upsertToolCall,
} from "./chat-writer";
import {
  applyPermissionExpiration,
  applyPermissionResolution,
  cancelAwaitingToolCalls,
  type DocPair,
  expireTurnPermissions,
} from "./permission";

export type { DocPair } from "./permission";

/** 聚合结果：applied=false 时 reason 为脱敏拒绝原因（供日志，不含敏感载荷） */
export interface ApplyResult {
  applied: boolean;
  reason?: string;
}

/** 用户消息/助手回复的 entryId 派生规则（turn 内稳定，重放不重复创建） */
const USER_ENTRY = (turnId: string) => `${turnId}:user`;
const ASSISTANT_ENTRY = (turnId: string) => `${turnId}:assistant`;

/** 提取公共错误（过滤内部细节，仅保留脱敏 code/message） */
function extractPublicError(update: Record<string, unknown>): PublicError | null {
  const raw = update.publicError ?? update.error;
  if (raw && typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "agent_error";
    const message = typeof record.message === "string" ? record.message : "Agent request failed";
    return { code, message };
  }
  if (typeof raw === "string") return { code: "agent_error", message: raw };
  return null;
}

/**
 * 状态机守卫：当前 turn 是否仍可写入内容增量 / 接受执行类事件。
 * cancelling 非终态但输出已停止——用户已取消，晚到增量一律丢弃，
 * 避免"已取消但还在输出"的中间态；终态后同样丢弃（不新建 entry、不回退状态机）。
 */
function canWriteToTurn(turnStatus: TurnStatus | null): boolean {
  if (!turnStatus || turnStatus === "cancelling") return false;
  return !TURN_TERMINAL_STATUSES.has(turnStatus);
}

/** 提取文本块文本（content 或 update 顶层，兼容原始与包裹格式） */
function extractText(event: NormalizedEvent): string {
  const content = event.content;
  if (content) {
    const text = content.text;
    if (typeof text === "string") return text;
  }
  const updateText = event.update.text;
  return typeof updateText === "string" ? updateText : "";
}

/** 从 ACP 工具帧提取 toolCallId（toolCallId 优先，兼容 content 内嵌 id） */
function extractToolCallId(event: NormalizedEvent): string | null {
  const direct = event.update.toolCallId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const inner = event.content?.id;
  if (typeof inner === "string" && inner.length > 0) return inner;
  return null;
}

/** 处理用户消息：创建新 turn（幂等：同 turnId 重放跳过），终结未完成的旧 turn */
function applyUserMessage(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const turnId = event.turnId;
  if (!turnId) return { applied: false, reason: "user_message missing turnId" };

  const active = readActiveTurn(pair.session);
  // 重放保护：同 turnId 的 user_message 已投影过 → 跳过，不重复创建 Entry
  if (active.turnId === turnId) return { applied: false, reason: "duplicate turn" };

  // 旧 turn 未终结（用户连发/重试）→ 将旧 assistant entry 置为 cancelled，
  // 保证任何时刻只有一个活动 turn（文档 8.2：默认每会话仅一个活动 turn）
  if (active.turnId && active.turnStatus && !TURN_TERMINAL_STATUSES.has(active.turnStatus)) {
    const oldAssistant = getEntry(pair.chat, ASSISTANT_ENTRY(active.turnId));
    if (oldAssistant) setEntryStatus(pair.chat, ASSISTANT_ENTRY(active.turnId), "cancelled");
  }

  const text = extractText(event);
  ensureEntry(pair.chat, {
    entryId: USER_ENTRY(turnId),
    turnId,
    kind: "message",
    role: "user",
  });
  setEntryStatus(pair.chat, USER_ENTRY(turnId), "completed");
  if (text) appendEntryText(pair.chat, USER_ENTRY(turnId), "text", "text", text);

  // assistant entry 先置 pending，首个增量到达时转 streaming
  ensureEntry(pair.chat, {
    entryId: ASSISTANT_ENTRY(turnId),
    turnId,
    kind: "message",
    role: "assistant",
  });
  setActiveTurn(pair.session, turnId, "accepting");
  return { applied: true };
}

/** 处理文本/思考增量：定位当前 turn 的 assistant entry，Y.Text 追加 */
function applyDelta(pair: DocPair, event: NormalizedEvent, blockType: "text" | "reasoning"): ApplyResult {
  const active = readActiveTurn(pair.session);
  // 终态或 cancelling 后到达的增量一律丢弃（不新建 entry、不回退状态机）
  if (!active.turnId || !canWriteToTurn(active.turnStatus)) {
    return { applied: false, reason: "delta after terminal or cancelled turn" };
  }
  const entryId = ASSISTANT_ENTRY(active.turnId);
  if (!getEntry(pair.chat, entryId)) {
    return { applied: false, reason: "assistant entry not found" };
  }
  const text = extractText(event);
  if (!text) return { applied: false, reason: "empty delta" };
  appendEntryText(pair.chat, entryId, blockType, blockType, text, blockType === "reasoning" ? "summary" : undefined);
  setEntryStatus(pair.chat, entryId, "streaming");
  // accepting → running（首个增量到达）
  if (active.turnStatus === "accepting") setActiveTurn(pair.session, active.turnId, "running");
  return { applied: true };
}

/** 处理工具调用事件：toolCallId upsert 幂等 + assistant entry 的 tool block 幂等 */
function applyToolCall(pair: DocPair, event: NormalizedEvent, status: "running" | "completed" | "error"): ApplyResult {
  const toolCallId = extractToolCallId(event);
  if (!toolCallId) return { applied: false, reason: "tool_call missing toolCallId" };

  const active = readActiveTurn(pair.session);
  // 终态或 cancelling 后的工具调用不投影：取消后不允许再出现新的工具输出
  if (!active.turnId || !canWriteToTurn(active.turnStatus)) {
    return { applied: false, reason: "tool_call without writable turn" };
  }

  const result =
    event.update.rawOutput !== undefined
      ? (event.update.rawOutput as Record<string, unknown> | null)
      : ((event.update.output as Record<string, unknown> | null) ?? null);
  upsertToolCall(pair.chat, {
    toolCallId,
    turnId: active.turnId,
    name: (event.update.title as string) ?? (event.update.name as string) ?? "",
    status,
    arguments: (event.update.rawInput as Record<string, unknown> | null) ?? null,
    result: status === "completed" ? result : undefined,
  });

  // 工具块挂到 assistant entry（幂等：重放不重复添加）
  const assistantEntry = getEntry(pair.chat, ASSISTANT_ENTRY(active.turnId));
  if (assistantEntry) {
    addToolCallBlock(pair.chat, ASSISTANT_ENTRY(active.turnId), toolCallId);
  }

  if (active.turnStatus === "accepting") setActiveTurn(pair.session, active.turnId, "running");
  return { applied: true };
}

/** 处理权限请求：permissionId upsert 幂等；turn 进入 awaiting_permission */
function applyPermissionRequested(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const permissionId =
    (event.update.permissionId as string | undefined) ?? (event.update.requestId as string | undefined);
  if (!permissionId) return { applied: false, reason: "permission missing permissionId" };

  const active = readActiveTurn(pair.session);
  // 终态或 cancelling 后的权限请求不投影：turn 已不可恢复执行（C5 失效清理在此边界外）
  if (!canWriteToTurn(active.turnStatus)) {
    return { applied: false, reason: "permission requested for unwritable turn" };
  }
  const toolCallId = typeof event.update.toolCallId === "string" ? event.update.toolCallId : null;

  // ACP 选项（allow_once/allow_always/reject_once/reject_always）→ 文档 5.3 三态
  const options: Array<"allow_once" | "allow_session" | "deny"> = [];
  if (Array.isArray(event.update.options)) {
    for (const option of event.update.options as unknown[]) {
      if (option === "allow_once") options.push("allow_once");
      else if (option === "allow_always" || option === "allow_session") options.push("allow_session");
      else if (option === "reject_once" || option === "reject_always" || option === "deny") options.push("deny");
    }
  }
  if (options.length === 0) options.push("allow_once", "deny");

  upsertPendingPermission(pair.session, {
    permissionId,
    turnId: active.turnId ?? "",
    toolCallId,
    title: (event.update.title as string) ?? (event.update.tool as string) ?? "Permission request",
    description: typeof event.update.description === "string" ? event.update.description : null,
    options,
    status: "pending",
    expiresAt:
      typeof event.update.expiresAt === "string"
        ? event.update.expiresAt
        : new Date(Date.now() + 5 * 60_000).toISOString(),
  });

  // 关联工具调用进入 awaiting_permission（存在才更新）
  if (toolCallId) {
    const tool = getToolCallsMap(pair.chat).get(toolCallId);
    if (tool) {
      tool.set("status", "awaiting_permission");
      tool.set("permissionId", permissionId);
    }
  }

  if (
    active.turnStatus &&
    !TURN_TERMINAL_STATUSES.has(active.turnStatus) &&
    active.turnStatus !== "awaiting_permission"
  ) {
    setActiveTurn(pair.session, active.turnId, "awaiting_permission");
  }
  return { applied: true };
}

/** 处理权限解析：CAS（仅 pending → resolved 一次），重复 resolve 不生效 */
function applyPermissionResolved(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const permissionId =
    (event.update.permissionId as string | undefined) ?? (event.update.requestId as string | undefined);
  if (!permissionId) return { applied: false, reason: "permission_resolve missing permissionId" };

  const decision =
    (event.update.decision as string | null | undefined) ??
    (event.update.optionId as string | null | undefined) ??
    null;
  // CAS 迁移与收敛在 state/permission.ts 单一来源（控制面 respond_permission 共用）
  return applyPermissionResolution(pair, permissionId, decision)
    ? { applied: true }
    : { applied: false, reason: "permission not pending (duplicate resolve)" };
}

/**
 * 用户取消请求：running / awaiting_permission / accepting → cancelling（非终态）。
 * 重复取消幂等跳过；终态后到达的取消请求拒绝（终态不可逆）。
 * Agent 确认取消（turn_cancelled）或取消超时（turn_interrupted）在此状态上收敛。
 */
function applyTurnCancelRequested(pair: DocPair): ApplyResult {
  const active = readActiveTurn(pair.session);
  if (!active.turnId || !active.turnStatus) return { applied: false, reason: "cancel without active turn" };
  if (TURN_TERMINAL_STATUSES.has(active.turnStatus)) {
    return { applied: false, reason: "cancel after terminal turn" };
  }
  if (active.turnStatus === "cancelling") return { applied: false, reason: "duplicate cancel" };
  setActiveTurn(pair.session, active.turnId, "cancelling");
  return { applied: true };
}

/** 处理 turn 终态（completed/failed/cancelled/interrupted）：Entry 终态 + activeTurn 终态，之后增量丢弃 */
function applyTurnTerminal(
  pair: DocPair,
  event: NormalizedEvent,
  status: "completed" | "error" | "cancelled" | "interrupted",
): ApplyResult {
  const active = readActiveTurn(pair.session);
  if (!active.turnId) return { applied: false, reason: "terminal without active turn" };
  // 终态幂等：已终结的同 turn 再次收到终态事件 → 跳过（不重复写）
  if (TURN_TERMINAL_STATUSES.has(active.turnStatus ?? "accepting")) {
    return { applied: false, reason: "duplicate terminal" };
  }

  const entryId = ASSISTANT_ENTRY(active.turnId);
  if (getEntry(pair.chat, entryId)) {
    if (status === "error") {
      const publicError = extractPublicError(event.update);
      const entry = getEntry(pair.chat, entryId);
      if (entry && publicError) entry.set("error", publicError);
    }
    setEntryStatus(
      pair.chat,
      entryId,
      status === "completed" ? "completed" : status === "error" ? "error" : "cancelled",
    );
  }

  // token 用量（prompt_complete 的 usage）随完成态写入 assistant entry，前端由此派生展示
  if (status === "completed") {
    const usage = event.update.usage;
    setEntryTokenUsage(pair.chat, entryId, usage as Record<string, unknown> | null | undefined);
  }

  const turnStatus: TurnStatus =
    status === "completed"
      ? "completed"
      : status === "error"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : "interrupted";
  setActiveTurn(pair.session, active.turnId, turnStatus);

  // C5：turn 终态后该 turn 的权限请求失效（pending → expired）、
  // 关联的 awaiting_permission 工具调用收敛 cancelled，不残留可授权项
  expireTurnPermissions(pair, active.turnId);
  cancelAwaitingToolCalls(pair, active.turnId);
  return { applied: true };
}

/** 处理 plan：投影为 system entry（结构化字段 + 人类可读 text block） */
function applyPlan(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const entries = event.update.entries;
  if (!Array.isArray(entries)) return { applied: false, reason: "plan missing entries" };

  const active = readActiveTurn(pair.session);
  const turnId = active.turnId ?? "global";
  const entryId = `plan:${turnId}:${getChatRoot(pair.chat).get("planSeq") ?? 0}`;

  const entry = ensureEntry(pair.chat, {
    entryId,
    turnId: active.turnId,
    kind: "system",
    role: "system",
  });
  setEntryStatus(pair.chat, entryId, "completed");
  entry.set("planEntries", entries);

  const summary = (entries as Array<Record<string, unknown>>)
    .map((e) => `[${String(e.priority ?? "medium")}] ${String(e.content ?? "")}`)
    .join("\n");
  if (summary) appendEntryText(pair.chat, entryId, "text", "text", summary);
  getChatRoot(pair.chat).set("planSeq", ((getChatRoot(pair.chat).get("planSeq") as number | undefined) ?? 0) + 1);
  return { applied: true };
}

/** 处理 session_updated / agent_status：覆盖式写 Session Doc 元信息 */
function applySessionControl(pair: DocPair, event: NormalizedEvent): ApplyResult {
  if (event.type === "agent_status") {
    const update = event.update;
    setAgentStatus(pair.session, {
      instanceId: typeof update.instanceId === "string" ? update.instanceId : null,
      acpSessionId: typeof update.acpSessionId === "string" ? update.acpSessionId : null,
      status: typeof update.status === "string" ? update.status : "ready",
      capabilities: (update.capabilities as Record<string, boolean> | undefined) ?? {},
      lastActivityAt: typeof update.lastActivityAt === "string" ? update.lastActivityAt : new Date().toISOString(),
    });
    return { applied: true };
  }

  // session_updated：session_info_update（title 等）或扁平 session 状态（ready/initializing）
  const update = event.update;
  const patch: Record<string, unknown> = {};
  if (update.title !== undefined) patch.title = update.title;
  if (update.sessionId !== undefined) patch.sessionId = update.sessionId;
  if (update.status !== undefined) patch.status = update.status;
  if (update.sessionUpdate === "ready" || update.sessionUpdate === "initializing") {
    patch.status = update.sessionUpdate;
  }
  setSessionInfo(pair.session, patch);
  return { applied: true };
}

/**
 * 应用单个规范化事件到两份 Y.Doc。
 * 每份 Doc 一个 transaction（YJS 嵌套事务会合并到各自 Doc 的事务栈，
 * 跨 Doc 顺序由调用方保证，不依赖跨 Doc transaction）。
 * 聚合层唯一入口：旧事件类型不会进入这里（ACPChannel 已翻译/拒绝）。
 */
export function applyNormalizedEvent(pair: DocPair, event: NormalizedEvent): ApplyResult {
  let result: ApplyResult = { applied: false, reason: "unhandled" };
  pair.chat.transact(() => {
    pair.session.transact(() => {
      switch (event.type) {
        case "user_message":
          result = applyUserMessage(pair, event);
          break;
        case "message_delta":
          result = applyDelta(pair, event, "text");
          break;
        case "reasoning_delta":
          result = applyDelta(pair, event, "reasoning");
          break;
        case "tool_call_started":
          result = applyToolCall(pair, event, "running");
          break;
        case "tool_call_completed":
          result = applyToolCall(pair, event, "completed");
          break;
        case "tool_call_failed":
          result = applyToolCall(pair, event, "error");
          break;
        case "tool_call_updated":
          result = applyToolCall(pair, event, "running");
          break;
        case "permission_requested":
          result = applyPermissionRequested(pair, event);
          break;
        case "permission_resolved":
          result = applyPermissionResolved(pair, event);
          break;
        case "permission_expired": {
          // C5：超时迁移（pending → expired 一次）与收敛统一走 state/permission.ts，
          // 与超时定时器共用同一 CAS 入口
          const permissionId = event.update.permissionId as string | undefined;
          if (typeof permissionId !== "string") {
            result = { applied: false, reason: "permission_expired missing permissionId" };
            break;
          }
          result = applyPermissionExpiration(pair, permissionId)
            ? { applied: true }
            : { applied: false, reason: "permission not pending" };
          break;
        }
        case "turn_completed":
          result = applyTurnTerminal(pair, event, "completed");
          break;
        case "turn_failed":
          result = applyTurnTerminal(pair, event, "error");
          break;
        case "turn_cancel_requested":
          result = applyTurnCancelRequested(pair);
          break;
        case "turn_cancelled":
          result = applyTurnTerminal(pair, event, "cancelled");
          break;
        case "turn_interrupted":
          result = applyTurnTerminal(pair, event, "interrupted");
          break;
        case "plan":
          result = applyPlan(pair, event);
          break;
        case "session_updated":
        case "agent_status":
          result = applySessionControl(pair, event);
          break;
        default: {
          // 防御：新加的规范化类型未实现处理时拒绝，不静默吞掉
          const exhaustive: never = event.type;
          result = { applied: false, reason: `unhandled normalized event: ${String(exhaustive)}` };
        }
      }

      if (result.applied) {
        bumpProjectionVersion(getChatRoot(pair.chat));
        bumpProjectionVersion(getSessionRoot(pair.session));
      }
    });
  });
  return result;
}
