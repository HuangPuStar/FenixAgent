// packages/chat-channel/src/protocol/translator.ts
// 前端 action → ACP JSON-RPC 翻译。
// 纯函数，不依赖任何 I/O 或框架。

import { hasQuestionAnswer, normalizeQuestionAnswers } from "../schema";

/** 前端 Action → ACP JSON-RPC 请求的调用上下文（服务端权威字段，浏览器传入值一律不可信） */
export interface TranslateActionContext {
  /**
   * Peri 待发送队列代号（Session Doc `userInputQueue.generation`，服务端从投影读取）。
   * 浏览器传入值不可信：代号不匹配时 peri 以 -32602 拒绝整条命令并回传权威快照。
   */
  generation?: string | null;
  /** 端到端幂等键：浏览器 commandId 原样转交 peri（peri 按它去重，重复提交不重复入队） */
  commandId?: string;
  /**
   * 会话级 MCP 条目（通道 B）。只由服务端注入，浏览器无法指定；构造失败时不注入。
   * 条目只在 ACP 消息里传递，不落盘——token 生命周期与 session 一致。
   */
  mcpServers?: readonly Record<string, unknown>[];
}

/** Peri 待发送队列（steer）扩展方法名（acp-link 只做原样透传，方法名字面量两侧一致） */
export const USER_INPUT_QUEUE_METHODS = {
  snapshot: "session/input/snapshot",
  enqueue: "session/input/enqueue",
  dispatch: "session/input/dispatch",
  takeback: "session/input/takeback",
} as const;

/**
 * 将前端的简化操作转换为 ACP JSON-RPC 请求。
 *
 * workspacePath 由服务端根据已认证的 environment 解析，不可信任浏览器传入的值。
 *
 * @param parsed  前端发来的 { action, ... }
 * @param workspacePath 环境工作目录（服务端解析后注入）
 * @param rpcId   JSON-RPC 请求 id。调用方必须提供，避免消息被当作 notification 而非 request。
 * @param context 服务端权威字段（steer 三 action 的 generation / commandId）
 */
export function translateSimpleAction(
  parsed: Record<string, unknown>,
  workspacePath: string | null | undefined,
  rpcId: number,
  context: TranslateActionContext = {},
): Record<string, unknown> {
  const action = parsed.action as string;
  const id = rpcId;
  // 会话级 MCP 只在 create/load/resume 的握手里下发；其余动作携带它会被 Agent 忽略或拒绝。
  const sessionMcp = context.mcpServers && context.mcpServers.length > 0 ? { mcpServers: context.mcpServers } : {};
  switch (action) {
    case "send_prompt":
      // 携带目标 sessionId（服务端 session-channel 注入，来自绑定的 acpSessionId）：
      // dispatcher 据此精确路由 prompt；旧客户端不带时字段缺失，dispatcher fallback
      // 到连接级当前会话（向后兼容，但多会话共享 relay 时可能串会话——见 session-channel）。
      return {
        jsonrpc: "2.0",
        id,
        method: "session/prompt",
        params: { content: parsed.content, sessionId: parsed.sessionId },
      };
    case "cancel":
      // 携带目标 sessionId（前端来自 sessionState.acpSessionId），dispatcher 据此
      // 精确路由到 adapter 注册表中对应 session 的 query；旧客户端不带时字段缺失，
      // dispatcher fallback 到当前会话（向后兼容）。
      return { jsonrpc: "2.0", id, method: "session/cancel", params: { sessionId: parsed.sessionId } };
    case "create_session":
      return { jsonrpc: "2.0", id, method: "session/new", params: { cwd: workspacePath, ...sessionMcp } };
    case "load_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/load",
        params: { sessionId: parsed.sessionId, cwd: workspacePath, ...sessionMcp },
      };
    case "resume_session":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/resume",
        params: { sessionId: parsed.sessionId, cwd: workspacePath, ...sessionMcp },
      };
    case "list_sessions":
      return { jsonrpc: "2.0", id, method: "session/list", params: { cwd: workspacePath } };
    case "delete_session":
      return { jsonrpc: "2.0", id, method: "session/delete", params: { sessionId: parsed.sessionId } };
    case "respond_permission":
      // 权限响应必须以 JSON-RPC 响应形态发送（id = requestId，result 携带 outcome），
      // 与 acp-link client.respondToPermission 对齐：acp-link server/dispatcher 只解析
      // "result" in msg 的响应（requestId 为 perm_ 前缀）；旧 session/permission 请求
      // 形态在两侧都落 Method not found，属于历史协议缺陷（C5 修复）。
      return {
        jsonrpc: "2.0",
        id: typeof parsed.requestId === "string" ? parsed.requestId : "",
        result: {
          outcome:
            typeof parsed.optionId === "string" && parsed.optionId.length > 0
              ? { outcome: "selected", optionId: parsed.optionId }
              : { outcome: "cancelled" },
        },
      };
    case "respond_question": // AskUserQuestion 答案必须以 control_response 传输帧回传（非 JSON-RPC！）：
      // acp-link dispatcher 的 handleTransportMessage 只消费 { type: "control_response",
      // request_id, approved, extra } 形态（acp-dispatcher.ts:194）。
      // 多问题按 schema property 顺序合并回传 extra.answers；单选答案为 string，
      // 多选答案为 string[]。单值 optionId 仅保留历史兼容。
      {
        const rawAnswers = Array.isArray(parsed.answers)
          ? parsed.answers
          : Array.isArray(parsed.optionIds)
            ? parsed.optionIds
            : typeof parsed.optionId === "string" && parsed.optionId.length > 0
              ? [parsed.optionId]
              : [];
        const answers = normalizeQuestionAnswers(rawAnswers);
        const approved = hasQuestionAnswer(answers);
        return {
          type: "control_response",
          request_id: typeof parsed.questionId === "string" ? parsed.questionId : "",
          approved,
          extra: approved
            ? { answers }
            : { outcome: { optionId: typeof parsed.optionId === "string" ? parsed.optionId : "" } },
        };
      }
    case "set_session_mode":
      return {
        jsonrpc: "2.0",
        id,
        method: "session/setMode",
        params: { modeId: parsed.modeId },
      };
    // ── Peri 待发送队列（steer，能力 `peri.userInputQueue`）──
    // 三个方法的 params 是 camelCase 固定字段集（peri 侧 deny_unknown_fields）：多一个字段
    // 整条请求被拒，因此这里逐字段显式构造，不做 payload 透传。
    case "enqueue_user_input":
      // content 必须转成 peri 内部 MessageContent：纯文本折叠为裸字符串，含图片时换成
      // {type:'image', source:{type:'base64', media_type, data}}——ACP 的
      // {type:'image', mimeType, data} 直接出站会被拒绝或静默丢图（见 toPeriMessageContent）。
      // originalDraft 固定发送（空草稿补空串）：缺字段在 deny_unknown_fields 下不可预期，
      // 空串与缺省在取回回填时等价（前端 resolveTakebackDraft 回退 content）。
      return {
        jsonrpc: "2.0",
        id,
        method: USER_INPUT_QUEUE_METHODS.enqueue,
        params: {
          sessionId: parsed.sessionId,
          generation: requireQueueGeneration(context),
          commandId: requireQueueCommandId(context),
          inputId: parsed.inputId,
          content: toPeriMessageContent(parsed.content),
          originalDraft: typeof parsed.originalDraft === "string" ? parsed.originalDraft : "",
        },
      };
    case "dispatch_user_inputs":
      return {
        jsonrpc: "2.0",
        id,
        method: USER_INPUT_QUEUE_METHODS.dispatch,
        params: {
          sessionId: parsed.sessionId,
          generation: requireQueueGeneration(context),
          commandId: requireQueueCommandId(context),
          inputIds: normalizeInputIds(parsed.inputIds),
        },
      };
    case "takeback_user_input":
      return {
        jsonrpc: "2.0",
        id,
        method: USER_INPUT_QUEUE_METHODS.takeback,
        params: {
          sessionId: parsed.sessionId,
          generation: requireQueueGeneration(context),
          commandId: requireQueueCommandId(context),
          inputId: parsed.inputId,
        },
      };
    default:
      return parsed;
  }
}

/** 队列代号缺失即编程错误：调用方（SessionChannel）必须先补拉快照解析出代号，绝不猜值 */
function requireQueueGeneration(context: TranslateActionContext): string {
  const generation = context.generation;
  if (typeof generation !== "string" || generation.length === 0) {
    throw new Error("steer action requires a server-resolved queue generation");
  }
  return generation;
}

/** commandId 是 peri 侧的端到端幂等键；缺失即上游信封校验失效，宁可显式失败也不发半截请求 */
function requireQueueCommandId(context: TranslateActionContext): string {
  const commandId = context.commandId;
  if (typeof commandId !== "string" || commandId.length === 0) {
    throw new Error("steer action requires a commandId");
  }
  return commandId;
}

/** dispatch 的 inputIds 只保留非空字符串（空数组与非法项已在 validateUserInputQueueAction 拒绝） */
function normalizeInputIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((inputId): inputId is string => typeof inputId === "string" && inputId.length > 0);
}

// ── Peri MessageContent ⇄ 聊天区内容块 ──
// peri 的 MessageContent 是 untagged union：纯字符串 | 块数组；图片块是
// `{type:'image', source:{type:'base64', media_type, data}}`（snake_case），而聊天区 /
// ACP prompt 路径是 `{type:'image', mimeType, data}`。两个方向都必须显式转换——
// 直接透传出站会让 peri 反序列化失败或被当作未知块静默丢弃（图片无声丢失）。

/** 聊天区 / ACP prompt 路径的文本块 */
export interface AcpTextBlock {
  type: "text";
  text: string;
}

/** 聊天区 / ACP prompt 路径的图片块（base64 直接放 data，与 acp-link ImageContent 同形） */
export interface AcpImageBlock {
  type: "image";
  mimeType: string;
  data: string;
}

export type AcpContentBlock = AcpTextBlock | AcpImageBlock;

/** peri MessageContent 的文本块 */
export interface PeriTextBlock {
  type: "text";
  text: string;
}

/** peri MessageContent 的图片块（base64 source，snake_case；与 ACP 图片块形状不同） */
export interface PeriImageBlock {
  type: "image";
  source: { type: "base64"; media_type: string; data: string };
}

export type PeriContentBlock = PeriTextBlock | PeriImageBlock;

/** peri 内部内容表示：纯文本是裸字符串，含非文本块时是块数组 */
export type PeriMessageContent = string | PeriContentBlock[];

/**
 * 聊天区内容块（ACP ContentBlock[]）→ peri MessageContent（enqueue.content 的唯一正确形状）。
 * - 纯文本（无图片块）折叠为裸字符串（多文本块按 "\n" 连接，与 send_prompt 的文本提取同口径）；
 * - 含图片时逐块转换：图片块换成 base64 source 形状，缺 mimeType/data 的块丢弃
 *   （不猜媒体类型，也不发半截 base64）。
 */
export function toPeriMessageContent(content: unknown): PeriMessageContent {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  const blocks: PeriContentBlock[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "text", text: raw });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "image") {
      const image = toPeriImageBlock(block);
      if (image) blocks.push(image);
      continue;
    }
    const text = block.text;
    if (typeof text === "string" && text.length > 0) blocks.push({ type: "text", text });
  }

  if (blocks.every((block) => block.type === "text")) {
    return blocks.map((block) => block.text).join("\n");
  }
  return blocks;
}

/**
 * peri MessageContent → 聊天区内容块（ACP 形状），与 toPeriMessageContent 互为逆映射。
 * 用途：把 peri 回传的内容（receipt / 队列快照项）还原成聊天区形状（展示文本派生、
 * 取回回填），以及锁定两个方向的形状契约。
 */
export function fromPeriMessageContent(content: unknown): AcpContentBlock[] {
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) return [];

  const blocks: AcpContentBlock[] = [];
  for (const raw of content) {
    if (typeof raw === "string") {
      if (raw.length > 0) blocks.push({ type: "text", text: raw });
      continue;
    }
    if (typeof raw !== "object" || raw === null) continue;
    const block = raw as Record<string, unknown>;
    if (block.type === "image") {
      const image = fromPeriImageBlock(block);
      if (image) blocks.push(image);
      continue;
    }
    const text = block.text;
    if (typeof text === "string" && text.length > 0) blocks.push({ type: "text", text });
  }
  return blocks;
}

/** ACP 图片块 → peri 图片块；缺 mimeType/data 时返回 null（丢弃而非降级成文本） */
function toPeriImageBlock(block: Record<string, unknown>): PeriImageBlock | null {
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
  const data = typeof block.data === "string" ? block.data : "";
  if (!mimeType || !data) return null;
  return { type: "image", source: { type: "base64", media_type: mimeType, data } };
}

/** peri 图片块 → ACP 图片块；已是对称形状时同样接受（重复转换保持幂等） */
function fromPeriImageBlock(block: Record<string, unknown>): AcpImageBlock | null {
  const source = block.source;
  if (typeof source === "object" && source !== null) {
    const record = source as Record<string, unknown>;
    const mediaType =
      typeof record.media_type === "string"
        ? record.media_type
        : typeof record.mimeType === "string"
          ? record.mimeType
          : "";
    const data = typeof record.data === "string" ? record.data : "";
    if (mediaType && data) return { type: "image", mimeType: mediaType, data };
  }
  const mimeType = typeof block.mimeType === "string" ? block.mimeType : "";
  const data = typeof block.data === "string" ? block.data : "";
  return mimeType && data ? { type: "image", mimeType, data } : null;
}

/**
 * 队列快照请求（session/input/snapshot，读操作）：不带 generation 表示取当前代号，
 * 服务端在"投影尚无代号"与"能力协商成功"两处都会补拉一次。
 */
export function buildUserInputQueueSnapshotRequest(sessionId: string, rpcId: number): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: rpcId,
    method: USER_INPUT_QUEUE_METHODS.snapshot,
    params: { sessionId },
  };
}
