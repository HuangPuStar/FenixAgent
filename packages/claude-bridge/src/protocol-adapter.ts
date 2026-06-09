// biome-ignore lint/suspicious/noExplicitAny: SDKMessage types vary by message kind
type SDKMessage = Record<string, any>;

/**
 * ACP ↔ stream-json 双向协议转换核心。
 * Claude Code CLI 使用 stream-json 协议（而非 ACP NDJSON），
 * ProtocolAdapter 负责将 ACP 消息转换为 SDK 输入，并将 SDK 输出转换为 ACP 事件。
 */
export class ProtocolAdapter {
  private abortController: AbortController | null = null;

  constructor(private send: (type: string, payload?: unknown) => void) {}

  /** 处理来自 relay 的 ACP 消息，转换为 SDK 操作 */
  async handleAcpMessage(acpMessage: Record<string, unknown>): Promise<void> {
    const type = acpMessage.type as string;
    const payload = (acpMessage.payload ?? {}) as Record<string, unknown>;

    switch (type) {
      case "new_session":
        this.send("session_created", { sessionId: "claude_session" });
        break;
      case "prompt": {
        const blocks = (payload.content as Array<{ type: string; text?: string }>) ?? [];
        const input = blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n");
        this.send("prompt_started", { input });
        break;
      }
      case "cancel":
        if (this.abortController) {
          this.abortController.abort();
          this.abortController = null;
        }
        this.send("prompt_complete", { stopReason: "cancelled" });
        break;
      case "list_sessions":
        this.send("session_list", { sessions: [] });
        break;
      default:
        break;
    }
  }

  /** 处理 SDK 流式输出，转换为 ACP 事件 */
  handleSdkOutput(message: SDKMessage): void {
    if (message.type === "assistant") {
      for (const block of message.content ?? []) {
        if (block.type === "text") {
          this.send("assistant", { type: "text", text: block.text });
        } else if (block.type === "tool_use") {
          this.send("tool_call", block);
        }
      }
    } else if (message.type === "result") {
      this.send("prompt_complete", { stopReason: message.subtype ?? message.stopReason ?? "end_turn" });
    } else if (message.type === "system") {
      if (message.subtype === "init") {
        this.send("status", {
          connected: true,
          agentInfo: { name: "Claude Code", version: message.version ?? "unknown" },
          capabilities: {
            loadSession: false,
            promptCapabilities: { embeddedContext: true, image: true },
            sessionCapabilities: {},
          },
        });
      }
    }
  }

  setAbortController(ac: AbortController): void {
    this.abortController = ac;
  }
}
