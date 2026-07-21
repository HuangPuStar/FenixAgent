import type * as acp from "@agentclientprotocol/sdk";
import { extractModelState, extractModeState } from "./config-options-utils.js";
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
export interface AcpDispatcherOptions {
  send: (message: unknown) => void;
  workspace?: string;
  /** 处理来自前端的 control_response / permission_response */
  onControlResponse?: (requestId: string, approved: boolean, extra?: Record<string, unknown>) => void;
  /**
   * 处理来自前端的权限响应 outcome，用于 opencode/ccb 的 requestPermission 回调。
   * 前端 respondToPermission 发送的 JSON-RPC 响应会被解析为 outcome 对象，
   * 然后通过此回调路由回 spawnAcpAgent 中 requestPermission 的待决 Promise。
   */
  onPermissionOutcome?: (
    requestId: string,
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  ) => boolean;
}

export class AcpDispatcher {
  private workspace: string;
  private send: (message: unknown) => void;
  private onControlResponse?: (requestId: string, approved: boolean, extra?: Record<string, unknown>) => void;
  private onPermissionOutcome?: (
    requestId: string,
    outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string },
  ) => boolean;

  constructor(
    private state: AcpSessionState,
    options: AcpDispatcherOptions,
  ) {
    this.send = options.send;
    this.workspace = options.workspace ?? process.cwd();
    this.onControlResponse = options.onControlResponse;
    this.onPermissionOutcome = options.onPermissionOutcome;
  }

  /** 处理从 WS 收到的原始消息（可能是 JSON-RPC 或传输层消息） */
  async handleMessage(raw: unknown): Promise<void> {
    if (isTransportMessage(raw)) {
      console.log("[acp-dispatcher] ← transport:", JSON.stringify(raw).slice(0, 500));
      await this.handleTransportMessage(raw as Record<string, unknown>);
      return;
    }

    const msg = raw as Record<string, unknown>;
    if ((msg as { jsonrpc?: string }).jsonrpc === "2.0" && msg.method && msg.id !== undefined) {
      console.log("[acp-dispatcher] ← rpc:", JSON.stringify(raw).slice(0, 500));
      await this.handleRequest(msg as unknown as JsonRpcRequest);
      return;
    }

    // 处理来自前端的 JSON-RPC 响应（如 permission_response）
    if ((msg as { jsonrpc?: string }).jsonrpc === "2.0" && msg.result && msg.id !== undefined) {
      const respId = msg.id as string;
      if (respId.startsWith("perm_")) {
        const result = msg.result as Record<string, unknown>;
        const rawOutcome = (result?.outcome as Record<string, unknown>) ?? {};
        // outcome.outcome === "selected" 只表示用户选择了某个选项，
        // 需要根据 optionId 判断究竟是 allow 还是 reject
        const optionId = (rawOutcome.optionId as string) ?? "";
        const selected = rawOutcome.outcome === "selected";
        const approved = selected && (optionId.startsWith("allow_") || optionId === "allow");

        // 1. canUseTool 路径（claude-acp-adapter）
        if (this.onControlResponse) {
          this.onControlResponse(respId, approved, result);
        }

        // 2. requestPermission 路径（opencode/ccb 的 spawnAcpAgent）
        if (this.onPermissionOutcome) {
          const typedOutcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string } = selected
            ? { outcome: "selected", optionId }
            : { outcome: "cancelled" };
          this.onPermissionOutcome(respId, typedOutcome);
        }
      }
      return;
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
      case "control_response":
      case "permission_response": {
        const requestId = (msg.request_id as string) ?? "";
        const approved = (msg.approved as boolean) ?? false;
        const extra = (msg.extra ?? msg.payload ?? {}) as Record<string, unknown>;
        if (this.onControlResponse && requestId) {
          this.onControlResponse(requestId, approved, extra);
        }
        break;
      }
      case "cancel_pending_permissions": {
        // 前端 relay 全部断开时，主服务通过 relay handle 发送此消息，
        // 通知 dispatcher 立即取消所有待决权限请求。
        cancelPendingPermissions(this.state);
        if (this.onPermissionOutcome) {
          // "__cancel_all__" 哨兵 requestId 告诉 spawnAcpAgent
          // 的 resolvePermissionOutcome 批量取消所有 pending 权限请求。
          this.onPermissionOutcome("__cancel_all__", { outcome: "cancelled" });
        }
        break;
      }
    }
  }

  private async handleRequest(msg: JsonRpcRequest): Promise<void> {
    const { id, method, params } = msg;
    const _t0 = Date.now();
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
        case ACP_METHOD.SESSION_DELETE:
          await this.handleDeleteSession(id, params as { sessionId: string });
          break;
        case ACP_METHOD.SESSION_RENAME:
          await this.handleRenameSession(id, params as { sessionId: string; title: string });
          break;
        default:
          this.send(createErrorResponse(id, -32601, `Method not found: ${method}`));
      }
      console.log("[acp-dispatcher] → rpc response:", JSON.stringify({ method, id, elapsed: Date.now() - _t0 }));
    } catch (error) {
      console.error(
        "[acp-dispatcher] ✗ rpc error:",
        JSON.stringify({ method, id, elapsed: Date.now() - _t0, error: (error as Error).message }),
      );
      this.send(createErrorResponse(id, -32603, (error as Error).message));
    }
  }

  private handleDisconnect(): void {
    cancelPendingPermissions(this.state);
    this.state.connection = null;
    this.state.sessionId = null;
    this.send({ type: "status", payload: { connected: false } });
  }

  private async handleNewSession(id: number | string, _params: Record<string, unknown>): Promise<void> {
    if (!this.state.connection) {
      this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    try {
      const result = await this.state.connection.newSession({
        cwd: this.workspace,
        mcpServers: [],
      });
      this.state.sessionId = result.sessionId;
      this.state.modelState = extractModelState(result.configOptions);
      this.state.modeState = result.modes ?? extractModeState(result.configOptions);
      this.send(
        createSuccessResponse(id, {
          ...result,
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
      // 校验 modelId 是否在 availableModels 中
      const availableIds = this.state.modelState.availableModels.map((m) => m.modelId);
      if (!availableIds.includes(params.modelId)) {
        console.warn(
          `[acp-dispatcher] setSessionModel: modelId "${params.modelId}" not in availableModels, ` +
            `rejecting. Available: ${availableIds.join(", ")}`,
        );
        this.send(createErrorResponse(id, -32602, `Model "${params.modelId}" is not available`));
        return;
      }

      await this.state.connection.setSessionConfigOption?.({
        sessionId: this.state.sessionId,
        configId: "model",
        value: params.modelId,
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
        cwd: this.workspace,
        cursor: params.cursor,
      });
      const MAX_SESSIONS = 20;
      // 过滤掉标题为空或以 "New session" 开头的会话
      const filtered = result.sessions.filter(
        (s: acp.SessionInfo) => s.title?.trim() && !s.title.trim().toLowerCase().startsWith("new session"),
      );
      const sessions = filtered.slice(0, MAX_SESSIONS);
      this.send(
        createSuccessResponse(id, {
          sessions: sessions.map((s: acp.SessionInfo) => ({
            ...s,
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
        cwd: this.workspace,
        mcpServers: [],
      });
      this.state.sessionId = params.sessionId;
      this.state.modelState = extractModelState(result.configOptions);
      this.state.modeState = result.modes ?? extractModeState(result.configOptions);
      this.send(
        createSuccessResponse(id, {
          ...result,
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
        cwd: this.workspace,
      });
      this.state.sessionId = params.sessionId;
      this.state.modelState = extractModelState(result.configOptions);
      this.state.modeState = result.modes ?? extractModeState(result.configOptions);
      this.send(
        createSuccessResponse(id, {
          ...result,
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

  private async handleDeleteSession(id: number | string, params: { sessionId: string }): Promise<void> {
    if (!this.state.connection) {
      this.send(createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }
    try {
      await this.state.connection.deleteSession({ sessionId: params.sessionId });
      this.send(createSuccessResponse(id, { deleted: true, sessionId: params.sessionId }));
    } catch (error) {
      this.send(createErrorResponse(id, -32603, `Failed to delete session: ${(error as Error).message}`));
    }
  }

  private async handleRenameSession(id: number | string, _params: { sessionId: string; title: string }): Promise<void> {
    // ACP SDK 不支持 renameSession，返回不支持错误。
    // 重命名操作应通过 RCS REST API PATCH /web/session/:id 完成。
    this.send(createErrorResponse(id, -32601, "renameSession is not supported by ACP protocol; use REST API instead"));
  }
}
