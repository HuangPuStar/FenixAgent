// packages/chat-channel/src/protocol/acp-channel.ts
// ACPChannel：入站消息规范化边界。
//
// 职责（文档 6.2）：把 acp-link 私有帧（agent_message_chunk / agent_thought_chunk /
// prompt_complete 等）与 JSON-RPC session/update 通知翻译为统一的规范化事件
// （session/update 语义：增量、内容块、终态），聚合层只消费规范化事件。
//
// 双格式兼容：原始 { type, payload } 与包裹 { type, payload: { jsonrpc: "2.0", ... } }。
//
// Peri Task 通道（切片 0B）：显式识别 `peri/agent_event`（Subagent 生命周期，
// event_json 内嵌 AcpEvent DTO）与 `peri/unstable_event`（Background Task，
// { event, data } 信封），翻译为 NormalizedPeriTaskEvent。未知 event type /
// 非法 event_json / 缺字段一律返回 null（不生成 unknown Task，避免把任意 Peri
// 控制事件暴露到 UI）；raw payload 不写入日志，拒绝原因只记录脱敏 code。

import {
  type NormalizedEvent,
  type NormalizedEventType,
  type NormalizedPeriTaskEvent,
  PERI_AGENT_EVENT_METHOD,
  PERI_AGENT_EVENT_TYPES,
  PERI_TASK_FALLBACK_TITLE,
  PERI_TASK_SUBTYPE_ALLOWLIST,
  PERI_TASK_SUMMARY_MAX,
  PERI_TASK_TITLE_MAX,
  PERI_UNSTABLE_EVENT_METHOD,
  PERI_UNSTABLE_EVENT_NAMES,
  truncateUtf8Safe,
} from "../schema";

/** 从消息中提取 JSON-RPC 对象（兼容原始和包裹两种格式） */
export function extractJsonRpc(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (msg.jsonrpc === "2.0") return msg;
  const payload = msg.payload as Record<string, unknown> | undefined;
  if (payload?.jsonrpc === "2.0") return payload;
  return null;
}

/**
 * 从 EngineRelay 消息中提取 ACP 事件类型和载荷（兼容层内部翻译）。
 * 兼容两种消息格式：
 * 1. 原始引擎格式: { type: "agent_message_chunk", payload: { type: "text", text: "..." } }
 * 2. JSON-RPC session/update: { jsonrpc: "2.0", method: "session/update", params: { update: { sessionUpdate: "...", content: {...} } } }
 *    （含包裹格式: { type: "session_data", payload: { jsonrpc: "2.0", ... } }）
 */
export function extractAcpEvent(
  rawMessage: unknown,
  msgType: string | undefined,
): { type: string; payload?: Record<string, unknown> } {
  const message = rawMessage as Record<string, unknown>;
  // 1. 尝试 JSON-RPC session/update 通知提取
  const rpc = extractJsonRpc(message);
  if (rpc && rpc.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    if (update?.sessionUpdate) {
      return {
        type: update.sessionUpdate as string,
        payload: update as Record<string, unknown>,
      };
    }
  }

  // 1.5. JSON-RPC 响应中的 prompt 结果：
  // session-manager 的 JSON-RPC 路径可能将 prompt 结果包装为
  //   createSuccessResponse(id, result) → { jsonrpc: "2.0", result: { stopReason: ... } }
  // 当 session_data payload 是此类 JSON-RPC 响应时，提取为 prompt_complete。
  if (rpc && "result" in rpc) {
    const result = rpc.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object" && "stopReason" in result) {
      return {
        type: "prompt_complete",
        payload: result,
      };
    }
  }

  // 2. session_data 包裹格式：{ type: "session_data", payload: { type: "prompt_complete", payload: ... } }
  // session-manager 将 prompt_complete 等非 JSON-RPC 事件通过
  //   emit(sessionId, "session_data", { type: "prompt_complete", payload: result })
  // 发送。需要提取内部嵌套 type，否则聚合层收到 type="session_data" 无法匹配任何 handler。
  const innerPayload = message.payload as Record<string, unknown> | undefined;
  if (msgType === "session_data" && innerPayload?.type && typeof innerPayload.type === "string") {
    return {
      type: innerPayload.type as string,
      payload: (innerPayload.payload as Record<string, unknown>) ?? innerPayload,
    };
  }

  // 3. 回退：原始 EngineRelayMessage 格式 { type, payload }
  return {
    type: msgType || "unknown",
    payload: innerPayload ?? message,
  };
}

/** 私有帧类型 → 规范化事件类型映射（终态判定依赖 payload 内容，见 normalize 内分支） */
const PRIVATE_FRAME_TO_NORMALIZED: Record<string, NormalizedEventType> = {
  agent_message_chunk: "message_delta",
  agent_thought_chunk: "reasoning_delta",
  user_message_chunk: "user_message",
  prompt_complete: "turn_completed",
  agent_message_complete: "turn_completed",
  session_error: "turn_failed",
  tool_call_result: "tool_call_completed",
  tool_call_error: "tool_call_failed",
  permission_request: "permission_requested",
  permission_response: "permission_resolved",
  // AskUserQuestion 交互问题（acp-link claude-adapter 拦截工具后发送私有帧，
  // payload 携带 sessionId/questionId/toolId/toolName/questions[]/description）
  interactive_question: "question_requested",
  session_update: "session_updated",
  plan: "plan",
  available_commands_update: "session_updated",
};

/** 提取规范化事件类型（sessionUpdate 值 → 规范化类型；tool_call 系列在 normalize 中细分） */
function mapSessionUpdateType(sessionUpdate: string): NormalizedEventType | null {
  switch (sessionUpdate) {
    case "agent_message_chunk":
      return "message_delta";
    case "agent_thought_chunk":
      return "reasoning_delta";
    case "user_message_chunk":
      return "user_message";
    case "tool_call":
    case "tool_call_update":
      // 可能是开始（running）也可能直接携带终态（completed/error），
      // 在 normalize 中按 payload.status 细分
      return "tool_call_started";
    case "permission_request":
      return "permission_requested";
    case "permission_response":
      return "permission_resolved";
    case "session_info_update":
      return "session_updated";
    case "plan":
      return "plan";
    case "available_commands_update":
      // 命令列表为会话级元数据（与 modelState/modeState 同级），随 session_updated
      // 投影到 Session Doc session map，前端 slash 命令菜单的数据源（YJS 重构恢复）
      return "session_updated";
    case "usage_update":
      // Peri 在独立 session/update 通知中发送当前上下文占用；prompt response 不带 usage。
      return "usage_updated";
    default:
      return null;
  }
}

/** 判断 tool_call 帧是否已携带终态（非流式 agent 可能直接发送完整结果）。
 * 标准 ACP（agent-client-protocol）工具失败序列化为 "failed"（ToolCallStatus::Failed），
 * 与私有帧的 "error" 一并收敛为 tool_call_failed，避免标准失败被误判为 started。 */
function resolveToolCallType(payload: Record<string, unknown> | undefined): NormalizedEventType {
  const status = (payload?.status as string | undefined) ?? "running";
  if (status === "completed" || status === "complete" || status === "done") return "tool_call_completed";
  if (status === "error" || status === "failed") return "tool_call_failed";
  return "tool_call_started";
}

/**
 * 从消息中提取 ACP sessionId。
 * session-bound notification（session/update、peri/agent_event、peri/unstable_event）
 * 的 sessionId 都在 params.sessionId；兼容顶层 session_id/sessionId 的历史形态。
 */
function extractSessionId(message: Record<string, unknown>): string | null {
  const rpc = extractJsonRpc(message);
  if (rpc?.method) {
    const params = rpc.params as Record<string, unknown> | undefined;
    const sessionId = params?.sessionId;
    if (typeof sessionId === "string" && sessionId.length > 0) return sessionId;
  }
  const direct = message.session_id ?? message.sessionId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  return null;
}

/** 提取内容块：优先 update.content；原始格式下 payload 自身就是内容块（{ type: "text", text }） */
function extractContent(payload: Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (!payload) return null;
  const nested = payload.content;
  if (nested && typeof nested === "object") return nested as Record<string, unknown>;
  if (typeof payload.text === "string" && (payload.type === "text" || payload.type === "image")) {
    return payload;
  }
  return null;
}

/** 读取方案 A 的标准 ACP metadata；字段存在即表示 SubAgent 内容。 */
function extractSourceAgentId(params: Record<string, unknown> | undefined): string | null {
  const meta = params?._meta as Record<string, unknown> | undefined;
  const peri = meta?.peri as Record<string, unknown> | undefined;
  const sourceAgentId = peri?.sourceAgentId;
  return typeof sourceAgentId === "string" && sourceAgentId.length > 0 ? sourceAgentId : null;
}

// ── Peri Task 事件规范化（切片 0B）──

/**
 * 将外部摘要收敛为可展示文本。
 * 先擦除常见凭证、URL 与本机绝对路径，再执行长度限制；这是纵深防御，
 * 上游仍不得在 result/output_preview 中返回秘密。
 */
function boundedSummary(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const redacted = raw
    .trim()
    .replace(/\b(?:https?|wss?):\/\/[^\s<>'"`]+/giu, "[REDACTED_URL]")
    .replace(
      /\b(?:bearer\s+)?[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/giu,
      "[REDACTED_SECRET]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "[REDACTED_SECRET]")
    .replace(
      /(?:^|\s)(?:~\/|\/(?:Users|home|var|tmp|private|etc|opt|srv|workspace)\/)[^\s<>'"`]+/gu,
      (value) => `${value.startsWith(" ") ? " " : ""}[REDACTED_PATH]`,
    );
  if (redacted.length === 0) return null;
  return truncateUtf8Safe(redacted, PERI_TASK_SUMMARY_MAX);
}

/** 读取稳定字符串字段（非字符串/缺字段返回 null，缺失字段的标题用安全 fallback） */
function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** 读取布尔字段（仅显式布尔值，缺省返回 fallback） */
function readBool(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const value = record[key];
  return typeof value === "boolean" ? value : fallback;
}

/**
 * 解析 `peri/agent_event` 的 event_json（AcpEvent DTO 的 JSON 字符串）。
 * 只接收 subagent_started / subagent_stopped；JSON 解析失败、缺字段、其他 event
 * type 返回 null。result 只作为有界摘要候选（截断 + 脱敏，不保留完整内容）。
 */
function normalizePeriAgentEvent(eventJson: string, acpSessionId: string | null): NormalizedPeriTaskEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(eventJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const type = record.type;
  if (typeof type !== "string" || !PERI_AGENT_EVENT_TYPES.has(type)) return null;
  const value = record.value;
  if (typeof value !== "object" || value === null) return null;
  const data = value as Record<string, unknown>;
  const instanceId = readString(data, "instance_id");
  if (!instanceId) return null;
  const agentName = readString(data, "agent_name");
  const receivedAt = new Date().toISOString();

  if (type === "subagent_started") {
    const title = agentName ? truncateUtf8Safe(agentName, PERI_TASK_TITLE_MAX) : PERI_TASK_FALLBACK_TITLE;
    return {
      type: "peri_task_started",
      update: {},
      content: null,
      acpSessionId,
      taskId: instanceId,
      kind: "subagent",
      taskSubtype: null,
      title,
      summary: null,
      sourceStartedAt: null,
      receivedAt,
      // Subagent 也可能是后台运行（is_background wire 字段），标记保留给展示层
      isBackground: readBool(data, "is_background", false),
      detailAvailability: "unavailable",
    };
  }

  // subagent_stopped
  const isError = readBool(data, "is_error", false);
  const result = boundedSummary(data.result);
  return {
    type: "peri_task_completed",
    update: {},
    content: null,
    acpSessionId,
    taskId: instanceId,
    kind: "subagent",
    success: !isError,
    summary: result,
    durationMs: null,
    receivedAt,
    detailAvailability: result ? "preview" : "unavailable",
  };
}

/**
 * 解析 `peri/unstable_event`（{ event, data } 信封，bg-task-*）。
 * kind allowlist 为 shell | agent | workflow；output_preview 只作为有界摘要候选。
 * 未知 event 忽略，不生成 unknown Task。
 */
function normalizePeriUnstableEvent(
  eventName: unknown,
  rawData: unknown,
  acpSessionId: string | null,
): NormalizedPeriTaskEvent | null {
  if (typeof eventName !== "string" || !PERI_UNSTABLE_EVENT_NAMES.has(eventName)) return null;
  if (typeof rawData !== "object" || rawData === null) return null;
  const data = rawData as Record<string, unknown>;
  const taskId = readString(data, "task_id");
  if (!taskId) return null;
  const kind = readString(data, "kind");
  const taskSubtype = kind && PERI_TASK_SUBTYPE_ALLOWLIST.has(kind) ? (kind as "shell" | "agent" | "workflow") : null;
  const receivedAt = new Date().toISOString();

  if (eventName === "bg-task-started") {
    const summary = boundedSummary(data.summary);
    const title = summary
      ? truncateUtf8Safe(summary, PERI_TASK_TITLE_MAX)
      : kind && PERI_TASK_SUBTYPE_ALLOWLIST.has(kind)
        ? truncateUtf8Safe(kind, PERI_TASK_TITLE_MAX)
        : PERI_TASK_FALLBACK_TITLE;
    const startedAt = readString(data, "started_at");
    return {
      type: "peri_task_started",
      update: {},
      content: null,
      acpSessionId,
      taskId,
      kind: "background",
      taskSubtype,
      title,
      summary,
      // started_at 必须为合法 ISO 时间，否则聚合层降级为 receivedAt（不拒绝事件）
      sourceStartedAt: startedAt,
      receivedAt,
      isBackground: true,
      detailAvailability: summary ? "preview" : "unavailable",
    };
  }

  if (eventName === "bg-task-completed") {
    const success = typeof data.success === "boolean" ? data.success : false;
    const preview = boundedSummary(data.output_preview);
    // duration_ms 只收非负有限数；非法值返回 null（由聚合层缺省）
    const durationMs =
      typeof data.duration_ms === "number" && Number.isFinite(data.duration_ms) ? data.duration_ms : null;
    return {
      type: "peri_task_completed",
      update: {},
      content: null,
      acpSessionId,
      taskId,
      kind: "background",
      success,
      summary: preview,
      durationMs,
      receivedAt,
      detailAvailability: preview ? "preview" : "unavailable",
    };
  }

  // bg-task-cancelled：reason 不进入 Y.Doc（raw cancellation reason 禁止），
  // 只以固定 reasonCode 表示取消终态
  return {
    type: "peri_task_cancelled",
    update: {},
    content: null,
    acpSessionId,
    taskId,
    kind: "background",
    reasonCode: "cancelled",
    receivedAt,
    detailAvailability: "unavailable",
  };
}

/**
 * ACPChannel 入站规范化：把任意 relay 入站消息翻译为规范化事件。
 * - 返回 null 表示消息不属于聚合层可消费的事件（保活帧、未知类型、已删除字段），
 *   调用方应直接忽略，不进入聚合层。
 * - 规范化事件保留双格式兼容（原始 + 包裹 JSON-RPC）。
 */
export function normalizeAcpMessage(rawMessage: unknown, msgType?: string): NormalizedEvent | null {
  const message = rawMessage as Record<string, unknown>;
  const acpSessionId = extractSessionId(message);

  const rpc = extractJsonRpc(message);

  // 1. JSON-RPC session/update 通知：事件类型与载荷都来自 params.update
  if (rpc?.method === "session/update") {
    const params = rpc.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const sessionUpdate = update?.sessionUpdate as string | undefined;
    if (sessionUpdate) {
      const baseType = mapSessionUpdateType(sessionUpdate);
      if (!baseType) return null;
      // tool_call / tool_call_update 按携带的 status 细分终态
      const type =
        sessionUpdate === "tool_call" || sessionUpdate === "tool_call_update" ? resolveToolCallType(update) : baseType;
      return {
        type,
        update: update ?? {},
        content: (update?.content as Record<string, unknown>) ?? null,
        acpSessionId,
        sourceAgentId: extractSourceAgentId(params),
      };
    }
    return null;
  }

  // 1.5. Peri Subagent / Background Task 通道：显式识别两个 wire method。
  // 未知 event type / 非法 payload 一律返回 null（不生成 unknown Task）。
  if (rpc?.method === PERI_AGENT_EVENT_METHOD) {
    const eventJson = (rpc.params as Record<string, unknown> | undefined)?.event_json;
    if (typeof eventJson !== "string") return null;
    return normalizePeriAgentEvent(eventJson, acpSessionId);
  }
  if (rpc?.method === PERI_UNSTABLE_EVENT_METHOD) {
    const params = rpc.params as Record<string, unknown> | undefined;
    return normalizePeriUnstableEvent(params?.event, params?.data, acpSessionId);
  }

  // 2. JSON-RPC 响应中的 prompt 结果（含 stopReason → turn 终态）与 cancel 确认
  if (rpc && "result" in rpc) {
    const result = rpc.result as Record<string, unknown> | undefined;
    if (result && typeof result === "object" && "stopReason" in result) {
      return {
        // cancel 后 Agent 回 prompt_complete { stopReason: "cancelled" } → turn_cancelled 终态
        type: result.stopReason === "cancelled" ? "turn_cancelled" : "turn_completed",
        update: result,
        content: null,
        acpSessionId,
      };
    }
    // acp-link server 的 session/cancel 响应 { cancelled: true } 是取消确认的另一种形态，
    // 与 prompt_complete { stopReason: "cancelled" } 收敛到同一终态事件
    if (result && typeof result === "object" && result.cancelled === true) {
      return { type: "turn_cancelled", update: result, content: null, acpSessionId };
    }
    // session/list 响应：shared-proc 与实例路径都以 JSON-RPC success 形态到达
    // （extractJsonRpc 兼容包裹 session_data 与裸 jsonrpc 两种），聚合层投影到
    // Session Doc sessions 映射（10s 轮询全量同步，幂等）
    if (result && typeof result === "object" && Array.isArray(result.sessions)) {
      return { type: "session_list", update: result, content: null, acpSessionId };
    }
    return null;
  }

  // 3. 私有帧 / session_data 包裹 → extractAcpEvent 提取后翻译
  const event = extractAcpEvent(rawMessage, msgType);
  if (event.type === "unknown" || event.type === "session_data") return null;

  // 保活/控制帧不进入聚合层
  if (
    event.type === "keep_alive" ||
    event.type === "heartbeat" ||
    event.type === "ping" ||
    event.type === "pong" ||
    event.type === "status"
  ) {
    return null;
  }

  const payload = event.payload ?? {};
  const normalizedType = PRIVATE_FRAME_TO_NORMALIZED[event.type];
  if (normalizedType) {
    return {
      // cancel 确认帧（prompt_complete / agent_message_complete 携带 stopReason: "cancelled"）
      // → turn_cancelled 终态，与 JSON-RPC 响应路径收敛一致
      type:
        normalizedType === "turn_completed" && payload.stopReason === "cancelled" ? "turn_cancelled" : normalizedType,
      update: payload,
      content: extractContent(payload),
      acpSessionId,
    };
  }

  // tool_call 系列按 payload.status 细分终态
  if (event.type === "tool_call" || event.type === "tool_call_update") {
    return {
      type: resolveToolCallType(payload),
      update: payload,
      content: extractContent(payload),
      acpSessionId,
    };
  }

  return null;
}
