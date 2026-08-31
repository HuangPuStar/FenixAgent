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

import { isPublicError } from "../public-error";
import {
  DEFAULT_PERMISSION_TIMEOUT_MS,
  DEFAULT_QUESTION_TIMEOUT_MS,
  type NormalizedEvent,
  type NormalizedPeriTaskEvent,
  type PeriTaskStatus,
  type PeriTaskViewProjection,
  type PublicError,
  type QuestionItemProjection,
  TOOL_TERMINAL_STATUSES,
  type ToolCallStatus,
  TURN_TERMINAL_STATUSES,
  type TurnStatus,
} from "../schema";
import {
  addToolCallBlock,
  appendEntryText,
  bumpProjectionVersion,
  ensureEntry,
  getChatRoot,
  getEntry,
  getPeriTasksMap,
  getSessionRoot,
  getToolCallsMap,
  readActiveTurn,
  setActiveTurn,
  setAgentStatus,
  setEntryStatus,
  setSessionAvailableCommands,
  setSessionInfo,
  setSessionModelState,
  setSessionModeState,
  upsertPendingPermission,
  upsertPendingQuestion,
  upsertPeriTaskView,
  upsertToolCall,
} from "./chat-writer";
import { applyPermissionExpiration, applyPermissionResolution, type DocPair } from "./permission";
import { respondQuestion } from "./question";
import { applySessionList } from "./session-list";
import { convergeTurnExit, turnAssistantEntryId } from "./turn-machine";

export type { DocPair } from "./permission";

/** 聚合结果：applied=false 时 reason 为脱敏拒绝原因（供日志，不含敏感载荷） */
export interface ApplyResult {
  applied: boolean;
  reason?: string;
}

/** 用户消息的 entryId 派生规则（turn 内稳定，重放不重复创建） */
const USER_ENTRY = (turnId: string) => `${turnId}:user`;
// assistant entryId 派生统一在 turn-machine（turnAssistantEntryId）：收敛入口
// 与聚合层共用同一规则，禁止此处再次定义造成派生漂移

/** Y.Doc 只接受来源边界产生的完整公开错误；非法值拒绝投影，不在下游猜测分类。 */
function extractPublicError(update: Record<string, unknown>): PublicError | null {
  const raw = update.publicError ?? update.error;
  return isPublicError(raw) ? raw : null;
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

/**
 * 提取工具名称与入参。标准 ACP ToolCallContent 将字段放在 content.name/input，
 * 私有增量帧则使用 update.title/name/rawInput；顶层字段优先以保留更新帧语义。
 */
function extractToolCallDetails(event: NormalizedEvent): {
  name: string;
  arguments: Record<string, unknown> | null;
} {
  const directName = event.update.title ?? event.update.name;
  const contentName = event.content?.name;
  const name = typeof directName === "string" ? directName : typeof contentName === "string" ? contentName : "";

  const directArguments = event.update.rawInput ?? event.update.input ?? event.update.arguments;
  const contentArguments = event.content?.input ?? event.content?.arguments;
  const rawArguments = directArguments ?? contentArguments;
  const argumentsValue =
    typeof rawArguments === "object" && rawArguments !== null && !Array.isArray(rawArguments)
      ? (rawArguments as Record<string, unknown>)
      : null;

  return { name, arguments: argumentsValue };
}

/** 处理用户消息：创建新 turn（幂等：同 turnId 重放跳过），终结未完成的旧 turn */
function applyUserMessage(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const turnId = event.turnId;
  if (!turnId && !event.callbackEntryId) return { applied: false, reason: "user_message missing turnId" };
  if (!turnId) {
    const entryId = event.callbackEntryId as string;
    const text = extractText(event);
    ensureEntry(pair.chat, { entryId, turnId: null, kind: "message", role: "user" });
    setEntryStatus(pair.chat, entryId, "completed");
    if (text) appendEntryText(pair.chat, entryId, "text", "text", text);
    ensureEntry(pair.chat, { entryId: `${entryId}:assistant`, turnId: null, kind: "message", role: "assistant" });
    return { applied: true };
  }

  // M2 重放保护：按 user entry 存在性判定（同 turnId 已投影过 → 跳过）。
  // 不能按 active.turnId === turnId 判定：历史回放/乱序下 active 可能已被更新
  // turn 接管，按 active 判定会把旧 turn 的历史消息重新投影一遍并把 active
  // 顶回旧 turn（状态聚合错乱）。
  if (getEntry(pair.chat, USER_ENTRY(turnId))) {
    return { applied: false, reason: "duplicate turn" };
  }

  const active = readActiveTurn(pair.session);
  // 旧 turn 未终结（用户连发/重试/回放历史接续）→ 经统一收敛入口终结（H1）：
  // assistant entry 终态 + 该 turn 权限失效 + 工具收敛，与终态事件/权限失效
  // 共用 convergeTurnExit，不在此手写收敛（历史教训：手写只收敛 entry 导致
  // 旧 turn 权限残留 pending、running 工具永久转圈）。
  // 实时 turn 置 cancelled（用户放弃等待），回放 turn（turn_replay_ 前缀，历史
  // 回显）置 completed——回放中后续 user_message 表明上一段历史已完整结束，
  // 置 cancelled 会让历史消息全部显示"已取消"（状态聚合错乱）。
  // 保证任何时刻只有一个活动 turn（文档 8.2：默认每会话仅一个活动 turn）
  if (active.turnId && active.turnStatus && !TURN_TERMINAL_STATUSES.has(active.turnStatus)) {
    const isReplayTurn = active.turnId.startsWith("turn_replay_");
    // finalStatus 随后被下方 setActiveTurn(turnId, "accepting") 覆盖（同一事务），
    // 传入仅为保持收敛入口语义完整；本处收敛的实质是权限/工具清理
    convergeTurnExit(pair, active.turnId, {
      finalStatus: isReplayTurn ? "completed" : "cancelled",
      entryStatus: isReplayTurn ? "completed" : "cancelled",
    });
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
    entryId: turnAssistantEntryId(turnId),
    turnId,
    kind: "message",
    role: "assistant",
  });
  setActiveTurn(pair.session, turnId, "accepting");
  return { applied: true };
}

/** 处理文本/思考增量：定位当前 turn 的 assistant entry，Y.Text 追加 */
function applyDelta(pair: DocPair, event: NormalizedEvent, blockType: "text" | "reasoning"): ApplyResult {
  // 子 Agent 的消息/思考由 Peri task 容器承载，不进入主 Agent Chat Doc。
  if (event.sourceAgentId) {
    return { applied: false, reason: "subagent message is rendered by peri task scope" };
  }
  if (event.callbackEntryId) {
    const entryId = `${event.callbackEntryId}:assistant`;
    if (!getEntry(pair.chat, entryId)) return { applied: false, reason: "callback assistant entry not found" };
    const text = extractText(event);
    if (!text) return { applied: false, reason: "empty delta" };
    appendEntryText(pair.chat, entryId, blockType, blockType, text, blockType === "reasoning" ? "summary" : undefined);
    setEntryStatus(pair.chat, entryId, "streaming");
    return { applied: true };
  }

  const active = readActiveTurn(pair.session);
  // 终态或 cancelling 后到达的增量一律丢弃（不新建 entry、不回退状态机）
  if (!active.turnId || !canWriteToTurn(active.turnStatus)) {
    return { applied: false, reason: "delta after terminal or cancelled turn" };
  }
  const entryId = turnAssistantEntryId(active.turnId);
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

  // Peri 子 Agent 的工具事件虽然复用父 ACP session，但通过 sourceAgentId 独立路由；
  // 当前 Chat Doc 只承载主 Agent assistant entry，因此不写入主 Chat Doc 的 toolCalls。
  if (event.sourceAgentId) {
    return { applied: false, reason: "subagent tool call is rendered by peri task scope" };
  }

  const toolDetails = extractToolCallDetails(event);
  // TodoWrite 已由 Claude 协议边界转换为标准 ACP plan；迟到或重复的工具帧不得再生成普通工具卡。
  if (toolDetails.name === "TodoWrite") {
    return { applied: false, reason: "TodoWrite is represented by ACP plan" };
  }
  const result =
    event.update.rawOutput !== undefined
      ? (event.update.rawOutput as Record<string, unknown> | null)
      : ((event.update.output as Record<string, unknown> | null) ?? null);

  // 工具状态不可逆（CAS）：已终态（completed/error/cancelled）的工具不得被迟到的
  // updated 帧回退（网络乱序/重放下 updated 可能晚于 completed 到达，无条件覆盖会
  // 让前端工具永久转圈）；同状态重放幂等放行。awaiting_permission → running 属合法
  // 迁移（权限批准后恢复执行），不在终态集合内不受影响。
  const existingTool = getToolCallsMap(pair.chat).get(toolCallId);
  const existingStatus = existingTool?.get("status") as ToolCallStatus | undefined;
  if (existingStatus && TOOL_TERMINAL_STATUSES.has(existingStatus) && existingStatus !== status) {
    return {
      applied: false,
      reason: `tool status already terminal (${existingStatus})`,
    };
  }

  upsertToolCall(pair.chat, {
    toolCallId,
    turnId: active.turnId,
    name: toolDetails.name,
    status,
    arguments: toolDetails.arguments,
    result: status === "completed" ? result : undefined,
    publicError: status === "error" ? extractPublicError(event.update) : undefined,
  });

  // 工具块挂到 assistant entry（幂等：重放不重复添加）
  const assistantEntry = getEntry(pair.chat, turnAssistantEntryId(active.turnId));
  if (assistantEntry) {
    addToolCallBlock(pair.chat, turnAssistantEntryId(active.turnId), toolCallId);
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
    return {
      applied: false,
      reason: "permission requested for unwritable turn",
    };
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
    // 请求时刻无决议，CAS 迁移（permission_resolved）成功后由 permission.ts 写入
    decision: null,
    expiresAt:
      typeof event.update.expiresAt === "string"
        ? event.update.expiresAt
        : new Date(Date.now() + DEFAULT_PERMISSION_TIMEOUT_MS).toISOString(),
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
  if (!permissionId)
    return {
      applied: false,
      reason: "permission_resolve missing permissionId",
    };

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
 * 从 acp-link interactive_question 帧提取 questions[] 并做最小结构校验
 * （外部输入不可信：非字符串 question 丢弃，options 仅保留 label 为字符串的项）。
 */
function extractQuestionItems(raw: unknown): QuestionItemProjection[] {
  if (!Array.isArray(raw)) return [];
  const items: QuestionItemProjection[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.question !== "string" || record.question.length === 0) continue;
    const options = Array.isArray(record.options)
      ? record.options
          .filter((o): o is Record<string, unknown> => typeof o === "object" && o !== null)
          .filter((o) => typeof o.label === "string" && o.label.length > 0)
          .map((o) => ({
            label: o.label as string,
            description: typeof o.description === "string" ? o.description : null,
          }))
      : [];
    items.push({
      question: record.question,
      header: typeof record.header === "string" && record.header.length > 0 ? record.header : null,
      options,
    });
  }
  return items;
}

/**
 * 处理 AskUserQuestion 交互问题请求：questionId upsert 幂等；60s expiresAt 投影
 * （与 acp-link 侧自动空答案对齐）。问题是独立 control_response 等待态，不驱动
 * turn 状态机；正常完成帧与问题帧乱序时仍须投影，避免工具卡片已展示但面板丢失。
 * cancelled / interrupted / failed 或无活动 turn 时则拒绝，避免旧会话帧创建孤立问题。
 */
function applyQuestionRequested(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const questionId = event.update.questionId as string | undefined;
  if (!questionId) return { applied: false, reason: "question missing questionId" };

  const active = readActiveTurn(pair.session);
  // AskUserQuestion 已由 acp-link 拦截并等待 control_response；因此若私有问题帧与
  // prompt_complete 乱序到达，completed 只是展示态提前收敛，不能据此丢弃问题。
  // cancelled / interrupted / failed 则表示 Agent 确已不能消费答案，仍须拒绝；没有
  // active turn 同样拒绝，避免孤立的旧帧在当前会话创建无归属问题。
  if (
    !active.turnStatus ||
    active.turnStatus === "cancelling" ||
    active.turnStatus === "cancelled" ||
    active.turnStatus === "interrupted" ||
    active.turnStatus === "failed"
  ) {
    return {
      applied: false,
      reason: "question requested for cancelled, failed, or missing turn",
    };
  }

  upsertPendingQuestion(pair.session, {
    questionId,
    status: "pending",
    questions: extractQuestionItems(event.update.questions),
    description: typeof event.update.description === "string" ? event.update.description : null,
    // 请求时刻无决议，CAS 迁移（respondQuestion / expireQuestion）成功后由 question.ts 写入
    answer: null,
    expiresAt:
      typeof event.update.expiresAt === "string"
        ? event.update.expiresAt
        : new Date(Date.now() + DEFAULT_QUESTION_TIMEOUT_MS).toISOString(),
  });
  return { applied: true };
}

/** 处理问题应答：CAS（仅 pending → resolved 一次），重复 resolve 不生效 */
function applyQuestionResolved(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const questionId = event.update.questionId as string | undefined;
  if (!questionId) return { applied: false, reason: "question_resolved missing questionId" };

  // 多问题合并答案（optionIds 数组，按问题顺序）；兼容单值 optionId 历史形态
  const rawOptionIds = event.update.optionIds;
  const optionIds = Array.isArray(rawOptionIds)
    ? (rawOptionIds as unknown[]).filter((v): v is string => typeof v === "string" && v.length > 0)
    : typeof event.update.optionId === "string" && event.update.optionId.length > 0
      ? [event.update.optionId]
      : [];
  // CAS 迁移在 state/question.ts 单一来源（控制面 respond_question 共用）
  return respondQuestion(pair, questionId, optionIds)
    ? { applied: true }
    : { applied: false, reason: "question not pending (duplicate resolve)" };
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
  if (event.callbackEntryId) {
    const entryId = `${event.callbackEntryId}:assistant`;
    if (!getEntry(pair.chat, entryId)) return { applied: false, reason: "callback assistant entry not found" };
    setEntryStatus(
      pair.chat,
      entryId,
      status === "completed" ? "completed" : status === "error" ? "error" : "cancelled",
    );
    return { applied: true };
  }

  const active = readActiveTurn(pair.session);
  if (!active.turnId) return { applied: false, reason: "terminal without active turn" };
  // 终态归属校验：事件携带 turnId 且与当前 active turn 不一致时，视为旧 turn 的
  // 迟到终态（新 turn 已由下一条 user_message 创建，旧 turn 已被终结）——不得
  // 终结新 turn，否则连续 prompt 时前一条的终态会提前终结后一条（后一条增量
  // 全被 canWriteToTurn 丢弃、答案永远不出现，前端只见空 assistant entry）。
  // 无 turnId 的事件（历史/回放兼容形态）保持按 active turn 归位。
  if (event.turnId && active.turnId && event.turnId !== active.turnId) {
    return { applied: false, reason: "terminal for stale turn" };
  }
  // 终态幂等：已终结的同 turn 再次收到终态事件 → 跳过（不重复写）
  if (TURN_TERMINAL_STATUSES.has(active.turnStatus ?? "accepting")) {
    return { applied: false, reason: "duplicate terminal" };
  }

  // H1：turn 离开活动态统一经 convergeTurnExit 收敛——assistant entry 终态 +
  // error/usage 元数据 + activeTurn 终态 + 该 turn 权限失效 + 工具收敛（含
  // running → cancelled，终态后 running 是死状态）。历史教训：此处曾手写收敛
  // 且只做 entry + activeTurn，漏掉权限/工具清理——残留 pending 权限可被旧
  // 决议重新激活，running 工具永久转圈。
  const turnStatus: TurnStatus =
    status === "completed"
      ? "completed"
      : status === "error"
        ? "failed"
        : status === "cancelled"
          ? "cancelled"
          : "interrupted";
  convergeTurnExit(pair, active.turnId, {
    entryStatus: status === "completed" ? "completed" : status === "error" ? "error" : "cancelled",
    finalStatus: turnStatus,
    meta: {
      error: status === "error" ? extractPublicError(event.update) : null,
      usage: status === "completed" ? (event.update.usage as Record<string, unknown> | null) : null,
    },
  });
  return { applied: true };
}

/** 处理 plan：同一 turn 内原位覆盖计划快照，避免每次进度更新追加一个面板。 */
function applyPlan(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const entries = event.update.entries;
  if (!Array.isArray(entries)) return { applied: false, reason: "plan missing entries" };

  const active = readActiveTurn(pair.session);
  const turnId = active.turnId ?? "global";
  const entryId = `plan:${turnId}`;

  const entry = ensureEntry(pair.chat, {
    entryId,
    turnId: active.turnId,
    kind: "system",
    role: "system",
  });
  setEntryStatus(pair.chat, entryId, "completed");
  entry.set("planEntries", entries);
  return { applied: true };
}

/** 处理 session_updated / agent_status：覆盖式写 Session Doc 元信息 */
function applySessionControl(pair: DocPair, event: NormalizedEvent): ApplyResult {
  if (event.type === "agent_status") {
    const update = event.update;
    const caps = update.capabilities as Record<string, boolean> | undefined;
    // 空/缺失 capabilities 不覆盖已有能力：status 可能先于能力就绪到达（实例
    // start 竞态，acp-link 侧以 connect 帧缓存补发兜底），覆盖会永久清空前端
    // 能力信息（表现为 "Loading or resuming sessions is not supported"）
    setAgentStatus(pair.session, {
      instanceId: typeof update.instanceId === "string" ? update.instanceId : null,
      acpSessionId: typeof update.acpSessionId === "string" ? update.acpSessionId : null,
      status: typeof update.status === "string" ? update.status : "ready",
      capabilities: caps && typeof caps === "object" && Object.keys(caps).length > 0 ? caps : undefined,
      lastActivityAt: typeof update.lastActivityAt === "string" ? update.lastActivityAt : new Date().toISOString(),
    });
    return { applied: true };
  }

  // session_updated：session_info_update（title 等）或扁平 session 状态（status 直接字段）。
  // 注意：sessionUpdate === "ready"/"initializing" 不会到达这里——acp-channel 的
  // mapSessionUpdateType 不映射它们（会话级 status 由 session 同步 result 与 status
  // 帧通过 update.status 字段投影），此处不重复处理。
  const update = event.update;
  const patch: Record<string, unknown> = {};
  if (update.title !== undefined) patch.title = update.title;
  if (update.sessionId !== undefined) patch.sessionId = update.sessionId;
  if (update.status !== undefined) patch.status = update.status;
  setSessionInfo(pair.session, patch);
  // model/mode 状态：session/new、load 响应携带（acp-link 已从 configOptions 提取），
  // 会话级元数据，随 session_updated 一起投影（切换会话时随 session map 清空重建）
  if (update.modelState && typeof update.modelState === "object") {
    setSessionModelState(pair.session, update.modelState as Parameters<typeof setSessionModelState>[1]);
  }
  if (update.modeState && typeof update.modeState === "object") {
    setSessionModeState(pair.session, update.modeState as Parameters<typeof setSessionModeState>[1]);
  }
  // 可用命令列表：available_commands_update 通知携带（agent 启动后下发），会话级元数据，
  // 随 session_updated 一起投影（切换会话时随 session map 清空重建）
  if (Array.isArray(update.availableCommands)) {
    setSessionAvailableCommands(
      pair.session,
      update.availableCommands as Parameters<typeof setSessionAvailableCommands>[1],
    );
  }
  return { applied: true };
}

/**
 * 处理 Peri Task 事件（切片 1）：状态收敛 + 幂等 upsert + 终态保护。
 * 与消息/turn 状态机完全解耦：background task 无 active turn 也可写入。
 *
 * 状态收敛规则（规格 §二.3，无 wire sequence 时的保守状态机）：
 * - missing + terminal → 创建 terminal task（terminal-first）
 * - missing + started  → 创建 running task
 * - running + terminal → terminal
 * - terminal + started → 忽略
 * - terminal + terminal：相同终态 → 幂等忽略；不同终态 → 保留首次终态，
 *   返回脱敏冲突计数 reason（不含任何 payload 字段）
 *
 * 时间规则：
 * - Background startedAt 优先使用合法 started_at；Subagent started 无源时间，
 *   使用 receivedAt；非法时间不拒绝事件，降级为 receivedAt；
 * - stop/completed/cancelled 的 completedAt 使用 receivedAt；
 * - 不用 duration_ms 反推 startedAt。
 */
function applyPeriTaskEvent(pair: DocPair, event: NormalizedEvent): ApplyResult {
  const peri = event as NormalizedPeriTaskEvent;
  // 首次创建前即确认 taskId（normalize 已保证非空）
  const existing = getPeriTasksMap(pair.session).get(peri.taskId);
  const existingStatus = existing?.get("status") as PeriTaskStatus | undefined;

  if (!existing) {
    upsertPeriTaskView(pair.session, buildPeriTaskView(peri, periTaskTimes(peri)));
    return { applied: true };
  }

  // started 事件：终态后到达的 started 忽略（不重建、不回退），running 更新放行
  if (peri.type === "peri_task_started") {
    if (existingStatus && PERI_TASK_TERMINAL_STATUSES.has(existingStatus)) {
      return { applied: false, reason: "peri_task started after terminal" };
    }
    upsertPeriTaskView(pair.session, buildPeriTaskView(peri, periTaskTimes(peri)));
    return { applied: true };
  }

  // 终态事件
  const status = peri.type === "peri_task_completed" ? (peri.success ? "completed" : "failed") : "cancelled";
  if (existingStatus && !PERI_TASK_TERMINAL_STATUSES.has(existingStatus)) {
    // running + terminal → terminal（覆盖 summary/终态字段，不重排 taskOrder）
    upsertPeriTaskView(pair.session, buildPeriTaskView(peri, periTaskTimes(peri)));
    return { applied: true };
  }
  if (existingStatus === status) {
    // 相同终态 → 幂等忽略（重复 completed/cancelled 不补写）
    return { applied: false, reason: "peri_task duplicate terminal" };
  }
  // 不同终态冲突：保留首次终态；reason 只含低基数终态名（脱敏，不含 payload）
  return { applied: false, reason: `peri_task terminal conflict (${existingStatus})` };
}

/** Peri Task 终态集合（状态机判终态用） */
const PERI_TASK_TERMINAL_STATUSES: ReadonlySet<PeriTaskStatus> = new Set(["completed", "failed", "cancelled"]);

/** 合法 ISO 时间校验：非法/缺省降级为 receivedAt（非法时间不拒绝事件） */
function resolvePeriTimestamp(raw: string | null, fallback: string): string {
  if (raw && Number.isFinite(new Date(raw).getTime())) return raw;
  return fallback;
}

/**
 * 由规范化事件计算 startedAt/completedAt：
 * - Background started 优先使用合法 started_at，Subagent started 使用 receivedAt；
 * - 终态事件的 completedAt = receivedAt（不反推 startedAt）；
 * - terminal-first 创建时无源开始时间，startedAt 降级为 receivedAt。
 */
function periTaskTimes(peri: NormalizedPeriTaskEvent): { startedAt: string; completedAt: string | null } {
  if (peri.type === "peri_task_started") {
    const startedAt =
      peri.kind === "background" ? resolvePeriTimestamp(peri.sourceStartedAt, peri.receivedAt) : peri.receivedAt;
    return { startedAt, completedAt: null };
  }
  return { startedAt: peri.receivedAt, completedAt: peri.receivedAt };
}

/**
 * 构造投影视图（由规范化事件 + 时间字段派生）。
 * completed/cancelled 事件 title 传空串（upsert 已有时跳过覆盖，创建时回退
 * 安全 fallback）；isBackground 以通道 kind 为创建 fallback（终态事件无 wire
 * is_background 字段，upsert 更新分支不覆盖 started 确定的标记）。
 */
function buildPeriTaskView(
  peri: NormalizedPeriTaskEvent,
  times: { startedAt: string; completedAt: string | null },
): PeriTaskViewProjection {
  if (peri.type === "peri_task_started") {
    return {
      taskId: peri.taskId,
      kind: peri.kind,
      taskSubtype: peri.taskSubtype,
      title: peri.title,
      summary: peri.summary,
      status: "running",
      turnId: peri.turnId ?? null,
      isBackground: peri.isBackground,
      startedAt: times.startedAt,
      completedAt: times.completedAt,
      updatedAt: peri.receivedAt,
      detailAvailability: peri.detailAvailability,
    };
  }
  if (peri.type === "peri_task_completed") {
    return {
      taskId: peri.taskId,
      kind: peri.kind,
      // completed 事件无 wire taskSubtype（见 NormalizedPeriTaskEvent 联合类型），
      // 传 null 由 upsert 更新分支保留 started 确定的 subtype（不覆盖）
      taskSubtype: null,
      title: "",
      summary: peri.summary,
      status: peri.success ? "completed" : "failed",
      turnId: peri.turnId ?? null,
      isBackground: peri.kind === "background",
      startedAt: times.startedAt,
      completedAt: times.completedAt,
      updatedAt: peri.receivedAt,
      detailAvailability: peri.detailAvailability,
    };
  }
  return {
    taskId: peri.taskId,
    kind: "background",
    taskSubtype: null,
    title: "",
    summary: null,
    status: "cancelled",
    turnId: peri.turnId ?? null,
    isBackground: true,
    startedAt: times.startedAt,
    completedAt: times.completedAt,
    updatedAt: peri.receivedAt,
    detailAvailability: "unavailable",
  };
}

/**
 * 应用单个规范化事件到两份 Y.Doc。
 * 每份 Doc 一个 transaction（YJS 嵌套事务会合并到各自 Doc 的事务栈，
 * 跨 Doc 顺序由调用方保证，不依赖跨 Doc transaction）。
 * 聚合层唯一入口：旧事件类型不会进入这里（ACPChannel 已翻译/拒绝）。
 *
 * projectionVersion 按触达 bump（SP-A2）：transaction.changed 记录本事务内
 * 实际被修改的 type，只递增被触碰 Doc 的版本——未被触碰的 Doc 不产生任何
 * op，消除流式稳态期间 Session Doc 的版本噪声（session: 广播帧与 Redis
 * 全量快照 CAS 翻倍的根因 A2）。被拒绝的事件（applied=false）不 bump 的
 * 既有语义不变；嵌套进外层批次事务时 changed 为批次累计值，同事务内多次
 * bump 仍合并为单次 update，语义安全。
 */
export function applyNormalizedEvent(pair: DocPair, event: NormalizedEvent): ApplyResult {
  let result: ApplyResult = { applied: false, reason: "unhandled" };
  pair.chat.transact((chatTr) => {
    pair.session.transact((sessionTr) => {
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
        case "question_requested":
          result = applyQuestionRequested(pair, event);
          break;
        case "question_resolved":
          result = applyQuestionResolved(pair, event);
          break;
        case "permission_expired": {
          // C5：超时迁移（pending → expired 一次）与收敛统一走 state/permission.ts，
          // 与超时定时器共用同一 CAS 入口
          const permissionId = event.update.permissionId as string | undefined;
          if (typeof permissionId !== "string") {
            result = {
              applied: false,
              reason: "permission_expired missing permissionId",
            };
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
        case "session_list":
          // 会话列表不依赖 turn，与其他控制事件并列；实现见 state/session-list.ts
          result = applySessionList(pair, event);
          break;
        case "peri_task_started":
        case "peri_task_completed":
        case "peri_task_cancelled":
          // Peri Task 生命周期投影：独立于 turn 状态机（无 active turn 也可写入）；
          // 状态收敛/终态保护/冲突计数见 applyPeriTaskEvent
          result = applyPeriTaskEvent(pair, event);
          break;
        default: {
          // 防御：新加的规范化类型未实现处理时拒绝，不静默吞掉
          const exhaustive: never = event;
          result = {
            applied: false,
            reason: `unhandled normalized event: ${String(exhaustive)}`,
          };
        }
      }

      if (result.applied && sessionTr.changed.size > 0) {
        bumpProjectionVersion(getSessionRoot(pair.session));
      }
    });
    if (result.applied && chatTr.changed.size > 0) {
      bumpProjectionVersion(getChatRoot(pair.chat));
    }
  });
  return result;
}
