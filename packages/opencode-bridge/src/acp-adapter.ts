import * as acp from "@agentclientprotocol/sdk";
import type { AgentCapabilities, PromptCapabilities, ProxyMessage } from "./acp-types.js";

// ── ACP Session State ──

export interface AcpSessionState {
  sessionId: string | null;
  connection: acp.ClientSideConnection | null;
  agentCapabilities: AgentCapabilities | null;
  promptCapabilities: PromptCapabilities | null;
  dispatcher: AcpDispatcher | null;
}

export function createAcpSessionState(): AcpSessionState {
  return {
    sessionId: null,
    connection: null,
    agentCapabilities: null,
    promptCapabilities: null,
    dispatcher: null,
  };
}

// ── JSON-RPC helpers ──

const ACP_METHOD = {
  SESSION_NEW: "session/new",
  SESSION_PROMPT: "session/prompt",
  SESSION_CANCEL: "session/cancel",
  SESSION_SET_MODEL: "session/set_model",
  SESSION_SET_MODE: "session/set_mode",
  SESSION_LIST: "session/list",
  SESSION_LOAD: "session/load",
  SESSION_RESUME: "session/resume",
  SESSION_UPDATE: "session/update",
  REQUEST_PERMISSION: "request_permission",
} as const;

function createSuccessResponse(id: string | number, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function createErrorResponse(id: string | number | null, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// ── ACP Dispatcher ──

/**
 * opencode-bridge 内部的 ACP 消息分发器。
 * 将 ProxyMessage 翻译为 ClientSideConnection SDK 调用。
 */
export class AcpDispatcher {
  constructor(
    private state: AcpSessionState,
    private send: (type: string, payload?: unknown) => void,
    private cwd?: string,
  ) {}

  async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as ProxyMessage;
    const { type, id } = msg;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    try {
      switch (type) {
        case "new_session":
          await this.handleNewSession(id, payload);
          break;
        case "prompt":
          await this.handlePrompt(id, payload);
          break;
        case "cancel":
          await this.handleCancel(id);
          break;
        case "set_session_model":
          await this.handleSetSessionModel(id, payload);
          break;
        case "set_session_mode":
          await this.handleSetSessionMode(id, payload);
          break;
        case "list_sessions":
          await this.handleListSessions(id, payload);
          break;
        case "load_session":
          await this.handleLoadSession(id, payload);
          break;
        case "resume_session":
          await this.handleResumeSession(id, payload);
          break;
        default:
          if (id !== undefined) {
            this.send(createErrorResponse(id, -32601, `Unknown method: ${type}`));
          }
      }
    } catch (err) {
      if (id !== undefined) {
        this.send(createErrorResponse(id, -32603, (err as Error).message));
      }
    }
  }

  private async handleNewSession(id: string | number | undefined, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    const result = await this.state.connection.newSession({
      cwd: (params.cwd as string) ?? this.cwd ?? "/",
      mcpServers: [],
    });
    this.state.sessionId = result.sessionId;
    if (id !== undefined) {
      this.send(createSuccessResponse(id, { sessionId: result.sessionId }));
    }
  }

  private async handlePrompt(id: string | number | undefined, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "No active session"));
      return;
    }
    const content = (params.content as acp.ContentBlock[]) ?? [];
    const result = await this.state.connection.prompt({ sessionId: this.state.sessionId, prompt: content });
    if (id !== undefined) {
      this.send(createSuccessResponse(id, result));
    }
  }

  private async handleCancel(id: string | number | undefined): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      if (id !== undefined) this.send(createSuccessResponse(id, { cancelled: false }));
      return;
    }
    await this.state.connection.cancel({ sessionId: this.state.sessionId });
    if (id !== undefined) {
      this.send(createSuccessResponse(id, { cancelled: true }));
    }
  }

  private async handleSetSessionModel(id: string | number | undefined, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "No active session"));
      return;
    }
    await this.state.connection.unstable_setSessionModel({
      sessionId: this.state.sessionId,
      modelId: (params.modelId as string) ?? "",
    });
    if (id !== undefined) {
      this.send(createSuccessResponse(id, { modelId: params.modelId }));
    }
  }

  private async handleSetSessionMode(id: string | number | undefined, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "No active session"));
      return;
    }
    await this.state.connection.setSessionMode({
      sessionId: this.state.sessionId,
      modeId: (params.modeId as string) ?? "",
    });
    if (id !== undefined) {
      this.send(createSuccessResponse(id, { modeId: params.modeId }));
    }
  }

  private async handleListSessions(id: string | number | undefined, _params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    const result = await this.state.connection.listSessions({});
    if (id !== undefined) {
      this.send(createSuccessResponse(id, result));
    }
  }

  private async handleLoadSession(id: string | number | undefined, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    const result = await this.state.connection.loadSession({
      sessionId: (params.sessionId as string) ?? "",
      cwd: (params.cwd as string) ?? this.cwd ?? "/",
      mcpServers: [],
    });
    this.state.sessionId = (params.sessionId as string) ?? "";
    if (id !== undefined) {
      this.send(createSuccessResponse(id, result));
    }
  }

  private async handleResumeSession(id: string | number | undefined, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection) {
      if (id !== undefined) this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    // biome-ignore lint/suspicious/noExplicitAny: unstable_resumeSession not in SDK types
    const result = await (this.state.connection as any).unstable_resumeSession({
      sessionId: (params.sessionId as string) ?? "",
      cwd: (params.cwd as string) ?? this.cwd ?? "/",
    });
    this.state.sessionId = (params.sessionId as string) ?? "";
    if (id !== undefined) {
      this.send(createSuccessResponse(id, result));
    }
  }
}
