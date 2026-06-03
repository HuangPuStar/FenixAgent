import type * as acp from "@agentclientprotocol/sdk";
import {
  ACP_METHOD,
  createErrorResponse,
  createSuccessResponse,
  isTransportMessage,
  type JsonRpcRequest,
} from "./json-rpc.js";
import type {
  AgentCapabilities,
  ContentBlock,
  PermissionResponsePayload,
  PromptCapabilities,
  SessionModelState,
} from "./types.js";

// Pending permission request
interface PendingPermission {
  resolve: (outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface AcpSessionState {
  connection: acp.ClientSideConnection | null;
  sessionId: string | null;
  pendingPermissions: Map<string, PendingPermission>;
  agentCapabilities: AgentCapabilities | null;
  promptCapabilities: PromptCapabilities | null;
  modelState: SessionModelState | null;
  modeState: {
    availableModes: Array<{ id: string; name: string; description?: string | null }>;
    currentModeId: string;
  } | null;
}

export function createAcpSessionState(): AcpSessionState {
  return {
    connection: null,
    sessionId: null,
    pendingPermissions: new Map(),
    agentCapabilities: null,
    promptCapabilities: null,
    modelState: null,
    modeState: null,
  };
}

function cancelPendingPermissions(state: AcpSessionState): void {
  for (const [, pending] of state.pendingPermissions) {
    clearTimeout(pending.timeout);
    pending.resolve({ outcome: "cancelled" });
  }
  state.pendingPermissions.clear();
}

/**
 * ACP 消息分发器。接收 JSON-RPC 请求，调用 ClientSideConnection SDK，
 * 通过 send 回调返回 JSON-RPC 响应/通知。
 * server mode 和 client mode 的 relay 共用此逻辑。
 */
export class AcpDispatcher {
  constructor(
    private state: AcpSessionState,
    private send: (message: unknown) => void,
  ) {}

  /** 处理从 WS 收到的原始消息（可能是 JSON-RPC 或传输层消息） */
  async handleMessage(raw: unknown): Promise<void> {
    if (isTransportMessage(raw)) {
      await this.handleTransportMessage(raw as Record<string, unknown>);
      return;
    }

    const msg = raw as Record<string, unknown>;
    if ((msg as { jsonrpc?: string }).jsonrpc === "2.0" && msg.method && msg.id !== undefined) {
      await this.handleRequest(msg as unknown as JsonRpcRequest);
    }
  }

  private async handleTransportMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case "connect":
        if (this.state.connection) {
          this.send({
            type: "status",
            payload: {
              connected: true,
              agentInfo: { name: "remote-agent" },
              capabilities: this.state.agentCapabilities,
            },
          });
        }
        break;
      case "disconnect":
        this.handleDisconnect();
        break;
      case "ping":
        this.send({ type: "pong" });
        break;
    }
  }

  private async handleRequest(msg: JsonRpcRequest): Promise<void> {
    const { id, method, params } = msg;
    try {
      switch (method) {
        case ACP_METHOD.SESSION_NEW:
          await this.handleNewSession(id, (params ?? {}) as Record<string, unknown>);
          break;
        case ACP_METHOD.SESSION_PROMPT:
          await this.handlePrompt(id, params as { content: ContentBlock[] });
          break;
        case ACP_METHOD.SESSION_CANCEL:
          await this.handleCancel(id);
          break;
        case ACP_METHOD.SESSION_SET_MODEL:
          await this.handleSetSessionModel(id, params as { modelId: string });
          break;
        case ACP_METHOD.SESSION_SET_MODE:
          await this.handleSetSessionMode(id, params as { modeId: string });
          break;
        case ACP_METHOD.SESSION_LIST:
          await this.handleListSessions(id, (params ?? {}) as { cwd?: string; cursor?: string });
          break;
        case ACP_METHOD.SESSION_LOAD:
          await this.handleLoadSession(id, params as { sessionId: string; cwd?: string });
          break;
        case ACP_METHOD.SESSION_RESUME:
          await this.handleResumeSession(id, params as { sessionId: string; cwd?: string });
          break;
        default:
          this.send(createErrorResponse(id, -32601, `Method not found: ${method}`));
      }
    } catch (error) {
      this.send(createErrorResponse(id, -32603, (error as Error).message));
    }
  }

  private handleDisconnect(): void {
    cancelPendingPermissions(this.state);
    this.state.connection = null;
    this.state.sessionId = null;
    this.send({ type: "status", payload: { connected: false } });
  }

  private async handleNewSession(id: number | string, params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection) {
      this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    try {
      const cwd = params.cwd as string | undefined;
      const result = await this.state.connection.newSession({
        cwd: cwd ?? process.cwd(),
        mcpServers: [],
      });
      this.state.sessionId = result.sessionId;
      this.state.modelState = result.models ?? null;
      this.state.modeState = result.modes ?? null;
      this.send(
        createSuccessResponse(id, {
          sessionId: result.sessionId,
          promptCapabilities: this.state.promptCapabilities,
          models: this.state.modelState,
          modes: this.state.modeState,
        }),
      );
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to create session: ${(error as Error).message}`));
    }
  }

  private async handlePrompt(id: number | string, params: { content: ContentBlock[] }): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send(createErrorResponse(id, -32000, "No active session"));
      return;
    }
    try {
      const result = await this.state.connection.prompt({
        sessionId: this.state.sessionId,
        prompt: params.content as acp.ContentBlock[],
      });
      this.send(createSuccessResponse(id, result));
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Prompt failed: ${(error as Error).message}`));
    }
  }

  /** 处理 JSON-RPC 响应形式的 permission_response（匹配 agent 发来的 requestPermission 的 id） */
  handlePermissionResponse(id: number | string, payload: PermissionResponsePayload): void {
    const pending = this.state.pendingPermissions.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.state.pendingPermissions.delete(payload.requestId);
    pending.resolve(payload.outcome);
    this.send(createSuccessResponse(id, { acknowledged: true }));
  }

  private async handleCancel(id: number | string): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send(createSuccessResponse(id, { cancelled: false }));
      return;
    }
    cancelPendingPermissions(this.state);
    try {
      await this.state.connection.cancel({ sessionId: this.state.sessionId });
      this.send(createSuccessResponse(id, { cancelled: true }));
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Cancel failed: ${(error as Error).message}`));
    }
  }

  private async handleSetSessionModel(id: number | string, params: { modelId: string }): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send(createErrorResponse(id, -32000, "No active session"));
      return;
    }
    if (!this.state.modelState) {
      this.send(createErrorResponse(id, -32000, "Model selection not supported"));
      return;
    }
    try {
      await this.state.connection.unstable_setSessionModel({
        sessionId: this.state.sessionId,
        modelId: params.modelId,
      });
      this.state.modelState = { ...this.state.modelState, currentModelId: params.modelId };
      this.send(createSuccessResponse(id, { modelId: params.modelId }));
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to set model: ${(error as Error).message}`));
    }
  }

  private async handleSetSessionMode(id: number | string, params: { modeId: string }): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send(createErrorResponse(id, -32000, "No active session"));
      return;
    }
    if (!this.state.modeState) {
      this.send(createErrorResponse(id, -32000, "Mode selection not supported"));
      return;
    }
    try {
      await this.state.connection.setSessionMode({
        sessionId: this.state.sessionId,
        modeId: params.modeId,
      });
      this.state.modeState = { ...this.state.modeState, currentModeId: params.modeId };
      this.send(createSuccessResponse(id, { modeId: params.modeId }));
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to set mode: ${(error as Error).message}`));
    }
  }

  private async handleListSessions(id: number | string, params: { cwd?: string; cursor?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    if (!this.state.agentCapabilities?.sessionCapabilities?.list) {
      this.send(createErrorResponse(id, -32000, "Listing sessions is not supported by this agent"));
      return;
    }
    try {
      const result = await this.state.connection.listSessions({
        cwd: params.cwd,
        cursor: params.cursor,
      });
      const MAX_SESSIONS = 20;
      const sessions = result.sessions.slice(0, MAX_SESSIONS);
      this.send(
        createSuccessResponse(id, {
          sessions: sessions.map((s: acp.SessionInfo) => ({
            _meta: s._meta,
            cwd: s.cwd,
            sessionId: s.sessionId,
            title: s.title,
            updatedAt: s.updatedAt,
          })),
          nextCursor: result.nextCursor,
          _meta: result._meta,
        }),
      );
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to list sessions: ${(error as Error).message}`));
    }
  }

  private async handleLoadSession(id: number | string, params: { sessionId: string; cwd?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    if (!this.state.agentCapabilities?.loadSession) {
      this.send(createErrorResponse(id, -32000, "Loading sessions is not supported"));
      return;
    }
    try {
      const result = await this.state.connection.loadSession({
        sessionId: params.sessionId,
        cwd: params.cwd ?? process.cwd(),
        mcpServers: [],
      });
      this.state.sessionId = params.sessionId;
      this.state.modelState = result.models ?? null;
      this.state.modeState = result.modes ?? null;
      this.send(
        createSuccessResponse(id, {
          sessionId: params.sessionId,
          promptCapabilities: this.state.promptCapabilities,
          models: this.state.modelState,
          modes: this.state.modeState,
        }),
      );
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to load session: ${(error as Error).message}`));
    }
  }

  private async handleResumeSession(id: number | string, params: { sessionId: string; cwd?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    if (!this.state.agentCapabilities?.sessionCapabilities?.resume) {
      this.send(createErrorResponse(id, -32000, "Resuming sessions is not supported"));
      return;
    }
    try {
      // @ts-expect-error SDK type mismatch: unstable_resumeSession exists on Agent interface
      const result = await this.state.connection.unstable_resumeSession({
        sessionId: params.sessionId,
        cwd: params.cwd ?? process.cwd(),
      });
      this.state.sessionId = params.sessionId;
      this.state.modelState = result.models ?? null;
      this.state.modeState = result.modes ?? null;
      this.send(
        createSuccessResponse(id, {
          sessionId: params.sessionId,
          promptCapabilities: this.state.promptCapabilities,
          models: this.state.modelState,
          modes: this.state.modeState,
        }),
      );
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to resume session: ${(error as Error).message}`));
    }
  }
}
