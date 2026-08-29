// biome-ignore lint/suspicious/noExplicitAny: SDKMessage types vary by message kind
type SDKMessage = Record<string, any>;

export interface AcpSessionUpdate {
  sessionUpdate: string;
  content?: unknown;
  entries?: PlanEntry[];
}

export interface PlanEntry {
  content: string;
  priority: "medium";
  status: "pending" | "in_progress" | "completed";
}

interface StreamedBlock {
  type: "text" | "thinking";
  emitted: string;
}

/** 校验 Claude TodoWrite 的完整输入并转换为 ACP v1 plan 快照。 */
export function parseTodoWritePlan(input: unknown): PlanEntry[] | null {
  if (!input || typeof input !== "object") return null;
  const todos = (input as Record<string, unknown>).todos;
  if (!Array.isArray(todos)) return null;

  const entries: PlanEntry[] = [];
  for (const todo of todos) {
    if (!todo || typeof todo !== "object") return null;
    const item = todo as Record<string, unknown>;
    if (typeof item.content !== "string" || item.content.trim() === "") return null;
    if (item.status !== "pending" && item.status !== "in_progress" && item.status !== "completed") return null;
    entries.push({ content: item.content, priority: "medium", status: item.status });
  }
  return entries;
}

/** 将完整 assistant 消息翻译为 ACP update，供实时校正和历史回放共同使用。 */
export function translateCompleteAssistantMessage(
  message: SDKMessage,
  streamedBlocks: ReadonlyMap<string, StreamedBlock> = new Map(),
  reportError: (message: string) => void = () => {},
): AcpSessionUpdate[] {
  const inner = (message.message ?? message) as Record<string, unknown>;
  const blocks = (inner.content ?? []) as Array<Record<string, unknown>>;
  const updates: AcpSessionUpdate[] = [];

  blocks.forEach((block, index) => {
    if (block.type === "text" && typeof block.text === "string") {
      const emitted = streamedBlocks.get(`text:${index}`)?.emitted ?? "";
      if (block.text === emitted) return;
      if (block.text.startsWith(emitted)) {
        updates.push({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: block.text.slice(emitted.length) },
        });
      } else {
        reportError(`assistant text block ${index} does not match streamed prefix`);
      }
      return;
    }
    if (block.type === "thinking" && typeof block.thinking === "string") {
      const emitted = streamedBlocks.get(`thinking:${index}`)?.emitted ?? "";
      if (block.thinking === emitted) return;
      if (block.thinking.startsWith(emitted)) {
        updates.push({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: block.thinking.slice(emitted.length) },
        });
      } else {
        reportError(`assistant thinking block ${index} does not match streamed prefix`);
      }
      return;
    }
    if (block.type !== "tool_use") return;
    if (block.name === "TodoWrite") {
      const entries = parseTodoWritePlan(block.input);
      if (entries === null) {
        reportError("TodoWrite input is not a valid complete plan snapshot");
        return;
      }
      updates.push({ sessionUpdate: "plan", entries });
      return;
    }
    updates.push({ sessionUpdate: "tool_call", content: block });
  });

  return updates;
}

/** ACP ↔ Claude SDK stream-json 协议转换核心。 */
export class ProtocolAdapter {
  private abortController: AbortController | null = null;
  private streamedBlocks = new Map<string, StreamedBlock>();

  constructor(
    private emit: (update: AcpSessionUpdate) => void,
    private reportError: (message: string) => void = (message) => console.warn(`[protocol-adapter] ${message}`),
  ) {}

  /** 处理来自 relay 的控制消息。 */
  async handleAcpMessage(acpMessage: Record<string, unknown>): Promise<void> {
    const type = acpMessage.type as string;
    const payload = (acpMessage.payload ?? {}) as Record<string, unknown>;
    switch (type) {
      case "new_session":
        this.emit({ sessionUpdate: "session_created", content: { sessionId: "claude_session" } });
        break;
      case "prompt": {
        const blocks = (payload.content as Array<{ type: string; text?: string }>) ?? [];
        const input = blocks.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        this.emit({ sessionUpdate: "prompt_started", content: { input } });
        break;
      }
      case "cancel":
        this.abortController?.abort();
        this.abortController = null;
        this.emit({ sessionUpdate: "prompt_complete", content: { stopReason: "cancelled" } });
        break;
      case "list_sessions":
        this.emit({ sessionUpdate: "session_list", content: { sessions: [] } });
        break;
    }
  }

  /** 处理 SDK 流式输出；完整 assistant 消息负责补齐和发布完整工具输入。 */
  handleSdkOutput(message: SDKMessage): void {
    if (message.type === "stream_event") {
      const event = message.event as Record<string, unknown> | undefined;
      if (!event) return;
      if (event.type === "content_block_delta") {
        const index = typeof event.index === "number" ? event.index : 0;
        const delta = event.delta as Record<string, unknown> | undefined;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          this.appendStreamedBlock("text", index, delta.text);
          this.emit({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: delta.text } });
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string") {
          this.appendStreamedBlock("thinking", index, delta.thinking);
          this.emit({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: delta.thinking } });
        }
      } else if (event.type === "message_start") {
        this.streamedBlocks.clear();
      } else if (event.type === "message_stop") {
        // 完整 assistant 消息通常紧随 message_stop，届时再完成校正并清理。
      }
      return;
    }

    if (message.type === "assistant") {
      for (const update of translateCompleteAssistantMessage(message, this.streamedBlocks, this.reportError)) {
        this.emit(update);
      }
      this.streamedBlocks.clear();
    } else if (message.type === "result") {
      this.streamedBlocks.clear();
      this.emit({
        sessionUpdate: "prompt_complete",
        content: { stopReason: message.subtype ?? message.stopReason ?? "end_turn" },
      });
    } else if (message.type === "system") {
      const subtype = message.subtype as string | undefined;
      if (subtype === "init") {
        this.emit({
          sessionUpdate: "status",
          content: {
            connected: true,
            agentInfo: { name: "Claude Code", version: message.version ?? "unknown" },
            capabilities: {
              loadSession: false,
              promptCapabilities: { embeddedContext: true, image: true },
              sessionCapabilities: {},
            },
          },
        });
      } else if (subtype === "thinking_tokens") {
        this.emit({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "", _meta: { thinkingTokens: message.estimated_tokens } },
        });
      } else {
        this.emit({
          sessionUpdate: "status",
          content: { connected: true, _meta: { systemSubtype: subtype, systemMessage: message } },
        });
      }
    } else if (message.type === "user") {
      const inner = (message.message ?? {}) as Record<string, unknown>;
      const blocks = (inner.content ?? []) as Array<Record<string, unknown>>;
      for (const block of blocks) {
        if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
          this.emit({ sessionUpdate: "user_message_chunk", content: { type: "text", text: block.text } });
        }
      }
    }
  }

  setAbortController(controller: AbortController): void {
    this.abortController = controller;
  }

  private appendStreamedBlock(type: "text" | "thinking", index: number, delta: string): void {
    const key = `${type}:${index}`;
    const current = this.streamedBlocks.get(key);
    this.streamedBlocks.set(key, { type, emitted: `${current?.emitted ?? ""}${delta}` });
  }
}
