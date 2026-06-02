import type * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  ContentBlock,
  PermissionResponsePayload,
  PromptCapabilities,
  ProxyMessage,
  SessionModelState,
} from "./types.js";

// Pending permission request
interface PendingPermission {
  resolve: (outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const _PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

function _generateRequestId(): string {
  return `perm_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
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
 * ACP 消息分发器。将前端 ACP 协议消息翻译成 ClientSideConnection SDK 调用，
 * 通过 send 回调将结果发回。server mode 和 client mode 的 relay 共用此逻辑。
 */
export class AcpDispatcher {
  constructor(
    private state: AcpSessionState,
    private send: (type: string, payload?: unknown) => void,
  ) {}

  async dispatch(message: ProxyMessage): Promise<void> {
    switch (message.type) {
      case "disconnect":
        this.handleDisconnect();
        break;
      case "new_session":
        await this.handleNewSession(message.payload ?? {});
        break;
      case "prompt":
        await this.handlePrompt(message.payload);
        break;
      case "permission_response":
        this.handlePermissionResponse(message.payload);
        break;
      case "cancel":
        await this.handleCancel();
        break;
      case "set_session_model":
        await this.handleSetSessionModel(message.payload);
        break;
      case "set_session_mode":
        await this.handleSetSessionMode(message.payload);
        break;
      case "list_sessions":
        await this.handleListSessions(message.payload ?? {});
        break;
      case "load_session":
        await this.handleLoadSession(message.payload);
        break;
      case "resume_session":
        await this.handleResumeSession(message.payload);
        break;
      case "connect":
        // connect 在远程模式下不需要（InstanceManager.start 已完成初始化）
        // 直接回复当前状态
        if (this.state.connection) {
          this.send("status", {
            connected: true,
            agentInfo: { name: "remote-agent" },
            capabilities: this.state.agentCapabilities,
          });
        }
        break;
      case "ping":
        this.send("pong");
        break;
      case "browser_tool_result":
        break;
    }
  }

  private handleDisconnect(): void {
    cancelPendingPermissions(this.state);
    this.state.connection = null;
    this.state.sessionId = null;
    this.send("status", { connected: false });
  }

  private async handleNewSession(params: { cwd?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send("error", { message: "Not connected to agent" });
      return;
    }
    try {
      const cwd = (params as Record<string, unknown>).cwd as string | undefined;
      const result = await this.state.connection.newSession({
        cwd: cwd ?? process.cwd(),
        mcpServers: [],
      });
      this.state.sessionId = result.sessionId;
      this.state.modelState = result.models ?? null;
      this.state.modeState = result.modes ?? null;
      this.send("session_created", {
        ...result,
        promptCapabilities: this.state.promptCapabilities,
        models: this.state.modelState,
        modes: this.state.modeState,
      });
    } catch (error) {
      this.send("error", { message: `Failed to create session: ${(error as Error).message}` });
    }
  }

  private async handlePrompt(params: { content: ContentBlock[] }): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send("error", { message: "No active session" });
      return;
    }
    try {
      const result = await this.state.connection.prompt({
        sessionId: this.state.sessionId,
        prompt: params.content as acp.ContentBlock[],
      });
      this.send("prompt_complete", result);
    } catch (error) {
      this.send("error", { message: `Prompt failed: ${(error as Error).message}` });
    }
  }

  private handlePermissionResponse(payload: PermissionResponsePayload): void {
    const pending = this.state.pendingPermissions.get(payload.requestId);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.state.pendingPermissions.delete(payload.requestId);
    pending.resolve(payload.outcome);
  }

  private async handleCancel(): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) return;
    cancelPendingPermissions(this.state);
    try {
      await this.state.connection.cancel({ sessionId: this.state.sessionId });
    } catch (error) {
      console.error("[AcpDispatcher] cancel failed:", (error as Error).message);
    }
  }

  private async handleSetSessionModel(params: { modelId: string }): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send("error", { message: "No active session" });
      return;
    }
    if (!this.state.modelState) {
      this.send("error", { message: "Model selection not supported" });
      return;
    }
    try {
      await this.state.connection.unstable_setSessionModel({
        sessionId: this.state.sessionId,
        modelId: params.modelId,
      });
      this.state.modelState = { ...this.state.modelState, currentModelId: params.modelId };
      this.send("model_changed", { modelId: params.modelId });
    } catch (error) {
      this.send("error", { message: `Failed to set model: ${(error as Error).message}` });
    }
  }

  private async handleSetSessionMode(params: { modeId: string }): Promise<void> {
    if (!this.state.connection || !this.state.sessionId) {
      this.send("error", { message: "No active session" });
      return;
    }
    if (!this.state.modeState) {
      this.send("error", { message: "Mode selection not supported" });
      return;
    }
    try {
      await this.state.connection.setSessionMode({
        sessionId: this.state.sessionId,
        modeId: params.modeId,
      });
      this.state.modeState = { ...this.state.modeState, currentModeId: params.modeId };
      this.send("mode_changed", { modeId: params.modeId });
    } catch (error) {
      this.send("error", { message: `Failed to set mode: ${(error as Error).message}` });
    }
  }

  private async handleListSessions(params: { cwd?: string; cursor?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send("error", { message: "Not connected to agent" });
      return;
    }
    if (!this.state.agentCapabilities?.sessionCapabilities?.list) {
      this.send("error", { message: "Listing sessions is not supported by this agent" });
      return;
    }
    try {
      const result = await this.state.connection.listSessions({
        cwd: params.cwd,
        cursor: params.cursor,
      });
      const MAX_SESSIONS = 20;
      const sessions = result.sessions.slice(0, MAX_SESSIONS);
      this.send("session_list", {
        sessions: sessions.map((s: acp.SessionInfo) => ({
          _meta: s._meta,
          cwd: s.cwd,
          sessionId: s.sessionId,
          title: s.title,
          updatedAt: s.updatedAt,
        })),
        nextCursor: result.nextCursor,
        _meta: result._meta,
      });
    } catch (error) {
      this.send("error", { message: `Failed to list sessions: ${(error as Error).message}` });
    }
  }

  private async handleLoadSession(params: { sessionId: string; cwd?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send("error", { message: "Not connected to agent" });
      return;
    }
    if (!this.state.agentCapabilities?.loadSession) {
      this.send("error", { message: "Loading sessions is not supported" });
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
      this.send("session_loaded", {
        sessionId: params.sessionId,
        promptCapabilities: this.state.promptCapabilities,
        models: this.state.modelState,
        modes: this.state.modeState,
      });
    } catch (error) {
      this.send("error", { message: `Failed to load session: ${(error as Error).message}` });
    }
  }

  private async handleResumeSession(params: { sessionId: string; cwd?: string }): Promise<void> {
    if (!this.state.connection) {
      this.send("error", { message: "Not connected to agent" });
      return;
    }
    if (!this.state.agentCapabilities?.sessionCapabilities?.resume) {
      this.send("error", { message: "Resuming sessions is not supported" });
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
      this.send("session_resumed", {
        sessionId: params.sessionId,
        promptCapabilities: this.state.promptCapabilities,
        models: this.state.modelState,
        modes: this.state.modeState,
      });
    } catch (error) {
      this.send("error", { message: `Failed to resume session: ${(error as Error).message}` });
    }
  }
}
