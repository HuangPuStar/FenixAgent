import { ACP_METHOD, createRequest, createSuccessResponse, type JsonRpcRequest } from "../json-rpc.js";
import type {
  ACPSettings,
  AvailableCommand,
  BrowserToolParams,
  BrowserToolResult,
  ConnectionState,
  ContentBlock,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  PermissionRequestPayload,
  PromptCapabilities,
  PromptUsage,
  ResumeSessionRequest,
  SessionModelState,
  SessionModeState,
  SessionUpdate,
} from "../types.js";
import { ACPPending } from "./pending.js";
import { ACPProtocol } from "./protocol.js";
import { ACPState } from "./state.js";
import { WSTransport } from "./transport.js";

/**
 * Error thrown when disconnect() is called while a connection is in progress.
 */
export class DisconnectRequestedError extends Error {
  constructor() {
    super("Disconnect requested");
    this.name = "DisconnectRequestedError";
  }
}

// Backward-compatible handler types
export type ConnectionStateHandler = (state: ConnectionState, error?: string) => void;
export type SessionUpdateHandler = (sessionId: string, update: SessionUpdate) => void;
export type SessionCreatedHandler = (sessionId: string) => void;
export type PromptCompleteHandler = (stopReason: string, usage?: PromptUsage) => void;
export type PermissionRequestHandler = (request: PermissionRequestPayload) => void;
export type BrowserToolCallHandler = (params: BrowserToolParams) => Promise<BrowserToolResult>;
export type ErrorMessageHandler = (message: string) => void;
export type ModelChangedHandler = (modelId: string) => void;
export type ModelStateChangedHandler = (state: SessionModelState | null) => void;
export type ModeChangedHandler = (modeId: string) => void;
export type ModeStateChangedHandler = (state: SessionModeState | null) => void;
export type AvailableCommandsChangedHandler = (commands: AvailableCommand[]) => void;
export type SessionLoadedHandler = (sessionId: string) => void;
export type SessionSwitchingHandler = (sessionId: string) => void;

/**
 * ACP 客户端 — 薄编排层，组合传输/协议/状态/pending 四个子模块。
 *
 * 公开 API 保持向后兼容（setXxxHandler + getter），内部通过子模块解耦。
 */
export class ACPClient {
  private readonly transport: WSTransport;
  private readonly protocol: ACPProtocol;
  readonly state: ACPState;
  private readonly pending: ACPPending;
  private settings: ACPSettings;

  // Connect promise
  private connectResolve: (() => void) | null = null;
  private connectReject: ((error: Error) => void) | null = null;
  private connecting = false;

  // Heartbeat
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;
  private missedPongs = 0;
  private static readonly HEARTBEAT_INTERVAL_MS = 60_000;
  private static readonly PONG_TIMEOUT_MS = 60_000;
  private static readonly MAX_MISSED_PONGS = 3;

  // Backward-compatible handlers
  private connectionStateHandlers = new Set<ConnectionStateHandler>();
  private sessionUpdateHandler: SessionUpdateHandler | null = null;
  private sessionCreatedHandler: SessionCreatedHandler | null = null;
  private promptCompleteHandler: PromptCompleteHandler | null = null;
  private permissionRequestHandler: PermissionRequestHandler | null = null;
  private browserToolCallHandler: BrowserToolCallHandler | null = null;
  private errorMessageHandler: ErrorMessageHandler | null = null;
  private authFailureHandler: (() => void) | null = null;
  private modelChangedHandler: ModelChangedHandler | null = null;
  private modelStateChangedHandler: ModelStateChangedHandler | null = null;
  private modeChangedHandler: ModeChangedHandler | null = null;
  private modeStateChangedHandler: ModeStateChangedHandler | null = null;
  private availableCommandsChangedHandler: AvailableCommandsChangedHandler | null = null;
  private sessionLoadedHandler: SessionLoadedHandler | null = null;
  private sessionSwitchingHandler: SessionSwitchingHandler | null = null;

  /**
   * 兼容不同服务端返回形态，保证 session/load 和 session/resume 最终都能拿到 sessionId。
   * 某些实现只返回字符串，或返回对象但不带 sessionId，这里统一回填到 state 初始化结构。
   */
  private normalizeSessionSwitchResult(
    result: unknown,
    requestedSessionId: string,
  ): {
    sessionId: string;
    promptCapabilities?: PromptCapabilities;
    models?: SessionModelState | null;
    modes?: SessionModeState | null;
  } {
    if (typeof result === "string" && result.length > 0) {
      return { sessionId: result };
    }

    if (typeof result === "object" && result !== null) {
      const record = result as {
        sessionId?: unknown;
        promptCapabilities?: PromptCapabilities;
        models?: SessionModelState | null;
        modes?: SessionModeState | null;
      };
      const sessionId =
        typeof record.sessionId === "string" && record.sessionId.length > 0 ? record.sessionId : requestedSessionId;

      return {
        sessionId,
        promptCapabilities: record.promptCapabilities,
        models: record.models,
        modes: record.modes,
      };
    }

    return { sessionId: requestedSessionId };
  }

  constructor(settings: ACPSettings) {
    this.transport = new WSTransport();
    this.protocol = new ACPProtocol();
    this.state = new ACPState();
    this.pending = new ACPPending();
    this.settings = settings;
    this.setupWiring();
  }

  // ==========================================================================
  // Internal wiring — transport ↔ protocol ↔ state ↔ pending
  // ==========================================================================

  private setupWiring(): void {
    // Transport message → Protocol parse
    this.transport.on("message", (raw) => this.protocol.handleMessage(raw));

    // State subscribes to transport + protocol
    this.state.bind(this.transport, this.protocol);

    // Protocol status → connect promise + heartbeat
    this.protocol.on("status", (payload) => {
      if (payload.connected) {
        this.startHeartbeat();
        if (this.connecting) {
          this.connecting = false;
          this.connectResolve?.();
          this.connectResolve = null;
          this.connectReject = null;
        } else {
          // Reconnect completed — resend pending
          this.resendPending();
        }
      } else {
        this.stopHeartbeat();
      }
    });

    // Protocol error → reject pending + forward
    this.protocol.on("error", (payload) => {
      const errorMsg = payload?.message || JSON.stringify(payload) || "Unknown error";
      this.pending.rejectAll(new Error(errorMsg));
      if (this.connecting) {
        this.connecting = false;
        this.connectReject?.(new Error(errorMsg));
        this.connectResolve = null;
        this.connectReject = null;
      } else {
        console.error("[ACPClient] Agent error:", errorMsg);
        this.errorMessageHandler?.(errorMsg);
      }
    });

    // JSON-RPC 响应 → pending.tryResolve
    this.protocol.on("rpc_response", ({ id, result }) => {
      this.pending.tryResolve(id, result);
    });

    // Protocol pong → heartbeat
    this.protocol.on("pong", () => {
      this.missedPongs = 0;
      if (this.heartbeatTimeout) {
        clearTimeout(this.heartbeatTimeout);
        this.heartbeatTimeout = null;
      }
    });

    // Protocol business events → backward-compatible handlers
    this.protocol.on("session_update", ({ sessionId, update }) => {
      this.sessionUpdateHandler?.(sessionId, update);
    });
    this.protocol.on("prompt_complete", (payload) => {
      this.promptCompleteHandler?.(payload.stopReason, payload.usage);
    });
    this.protocol.on("permission_request", (payload) => {
      this.permissionRequestHandler?.(payload);
    });
    this.protocol.on("browser_tool_call", ({ callId, params }) => {
      this.handleBrowserToolCall(callId, params);
    });
    this.protocol.on("model_changed", ({ modelId }) => {
      this.modelChangedHandler?.(modelId);
    });
    this.protocol.on("mode_changed", ({ modeId }) => {
      this.modeChangedHandler?.(modeId);
    });

    // State events → backward-compatible handlers
    this.state.on("connectionStateChange", ({ state, error }) => {
      for (const h of this.connectionStateHandlers) h(state, error);
      if (state === "error" && error === "登录已过期") {
        this.authFailureHandler?.();
      }
    });
    this.state.on("modelStateChange", (ms: SessionModelState | null) => {
      this.modelStateChangedHandler?.(ms);
    });
    this.state.on("modeStateChange", (ms: SessionModeState | null) => {
      this.modeStateChangedHandler?.(ms);
    });
    this.state.on("availableCommandsChange", (cmds) => {
      this.availableCommandsChangedHandler?.(cmds);
    });

    // Transport state: send ACP handshake on every WS connection (initial + reconnect)
    this.transport.on("state", ({ state, detail }) => {
      if (state === "connected") {
        this.sendRaw({ type: "connect" });
      }
      if (this.connecting && (state === "error" || (state === "disconnected" && detail?.code !== 1000))) {
        const msg = detail?.reason || `Connection closed (code: ${detail?.code})`;
        this.connecting = false;
        this.connectReject?.(new Error(msg));
        this.connectResolve = null;
        this.connectReject = null;
      }
    });

    // Transport reconnect failed → reject all pending
    this.transport.on("reconnectFailed", () => {
      this.pending.rejectAll(new Error("Reconnection failed"));
    });
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect(): Promise<void> {
    this.disconnect();

    let wsUrl = this.settings.proxyUrl;
    if (this.settings.token) {
      const url = new URL(wsUrl);
      url.searchParams.set("token", this.settings.token);
      wsUrl = url.toString();
    }

    this.connecting = true;

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;

      try {
        this.transport.connect(wsUrl);
        // ACP handshake is sent by setupWiring's transport "state: connected" listener
      } catch (error) {
        this.connecting = false;
        this.connectResolve = null;
        this.connectReject = null;
        reject(error);
      }
    });
  }

  disconnect(): void {
    if (this.connecting) {
      this.connectReject?.(new DisconnectRequestedError());
      this.connecting = false;
      this.connectResolve = null;
      this.connectReject = null;
    }
    this.stopHeartbeat();
    this.pending.rejectAll(new Error("Disconnected"));
    this.state.reset();
    this.transport.disconnect();
  }

  updateSettings(settings: ACPSettings): void {
    this.settings = settings;
  }

  // ==========================================================================
  // ACP Operations
  // ==========================================================================

  createSession(cwd?: string, permissionMode?: string): void {
    const sessionCwd = cwd ?? this.settings.cwd;
    const req = createRequest(ACP_METHOD.SESSION_NEW, { cwd: sessionCwd, permissionMode });
    this.sendJsonRpcAndTrack(req, 30_000)
      .then((result) => {
        const r = result as {
          sessionId: string;
          promptCapabilities?: PromptCapabilities;
          models?: SessionModelState | null;
          modes?: SessionModeState | null;
        };
        this.state.initSession(r);
        this.sessionCreatedHandler?.(r.sessionId);
      })
      .catch(() => {});
  }

  sendPrompt(content: string | ContentBlock[]): void {
    if (!this.state.sessionId) throw new Error("No active session");
    const blocks: ContentBlock[] = typeof content === "string" ? [{ type: "text" as const, text: content }] : content;
    const req = createRequest(ACP_METHOD.SESSION_PROMPT, { content: blocks });
    this.sendJsonRpcAndTrack(req, 120_000)
      .then((result) => {
        const r = result as { stopReason?: string; usage?: PromptUsage };
        this.promptCompleteHandler?.(r.stopReason ?? "end_turn", r.usage);
      })
      .catch((err) => {
        console.error("[ACPClient] sendPrompt failed:", (err as Error).message);
        // pending 超时或被 reject 时，也要通知上层结束 loading
        this.promptCompleteHandler?.("error");
      });
  }

  cancel(): void {
    const req = createRequest(ACP_METHOD.SESSION_CANCEL);
    this.sendRaw(req);
  }

  setSessionModel(modelId: string): Promise<void> {
    if (!this.state.sessionId) throw new Error("No active session");
    const req = createRequest(ACP_METHOD.SESSION_SET_MODEL, { modelId });
    return this.sendJsonRpcAndWait<{ modelId: string }>(req, 30_000).then(() => {
      this.state.updateCurrentModel(modelId);
    });
  }

  setSessionMode(modeId: string): Promise<void> {
    if (!this.state.sessionId) throw new Error("No active session");
    const req = createRequest(ACP_METHOD.SESSION_SET_MODE, { modeId });
    return this.sendJsonRpcAndWait<{ modeId: string }>(req, 30_000).then(() => {
      this.state.updateCurrentMode(modeId);
    });
  }

  respondToPermission(requestId: string, optionId: string | null): void {
    const outcome = optionId ? { outcome: "selected" as const, optionId } : { outcome: "cancelled" as const };
    const response = createSuccessResponse(requestId, { outcome });
    this.sendRaw(response);
  }

  listSessions(request?: ListSessionsRequest): Promise<ListSessionsResponse> {
    if (!this.state.supportsSessionList) {
      throw new Error("Listing sessions is not supported by this agent");
    }
    const req = createRequest(ACP_METHOD.SESSION_LIST, request ?? {});
    return this.sendJsonRpcAndWait<ListSessionsResponse>(req, 30_000);
  }

  loadSession(request: LoadSessionRequest): Promise<string> {
    if (!this.state.supportsLoadSession) {
      throw new Error("Loading sessions is not supported by this agent");
    }
    this.sessionSwitchingHandler?.(request.sessionId);
    const req = createRequest(ACP_METHOD.SESSION_LOAD, request);
    return this.sendJsonRpcAndWait<string>(req, 60_000).then((result) => {
      const r = this.normalizeSessionSwitchResult(result, request.sessionId);
      this.state.initSession(r);
      this.sessionLoadedHandler?.(r.sessionId);
      return r.sessionId;
    });
  }

  resumeSession(request: ResumeSessionRequest): Promise<string> {
    if (!this.state.supportsResumeSession) {
      throw new Error("Resuming sessions is not supported by this agent");
    }
    this.sessionSwitchingHandler?.(request.sessionId);
    const req = createRequest(ACP_METHOD.SESSION_RESUME, request);
    return this.sendJsonRpcAndWait<string>(req, 30_000).then((result) => {
      const r = this.normalizeSessionSwitchResult(result, request.sessionId);
      this.state.initSession(r);
      this.sessionLoadedHandler?.(r.sessionId);
      return r.sessionId;
    });
  }

  // ==========================================================================
  // Backward-compatible state getters (delegate to ACPState)
  // ==========================================================================

  getState(): ConnectionState {
    return this.state.connectionState;
  }
  getSessionId(): string | null {
    return this.state.sessionId;
  }
  get supportsImages(): boolean {
    return this.state.supportsImages;
  }
  getPromptCapabilities() {
    return this.state.promptCapabilities;
  }
  get modelState(): SessionModelState | null {
    return this.state.modelState;
  }
  get modeState(): SessionModeState | null {
    return this.state.modeState;
  }
  get availableCommands(): AvailableCommand[] {
    return this.state.availableCommands;
  }
  get supportsModelSelection(): boolean {
    return this.state.supportsModelSelection;
  }
  get agentCapabilities() {
    return this.state.agentCapabilities;
  }
  get supportsLoadSession(): boolean {
    return this.state.supportsLoadSession;
  }
  get supportsResumeSession(): boolean {
    return this.state.supportsResumeSession;
  }
  get supportsSessionList(): boolean {
    return this.state.supportsSessionList;
  }
  get supportsSessionHistory(): boolean {
    return this.state.supportsSessionHistory;
  }

  // ==========================================================================
  // Backward-compatible handler setters
  // ==========================================================================

  setConnectionStateHandler(handler: ConnectionStateHandler): void {
    this.connectionStateHandlers.add(handler);
  }
  removeConnectionStateHandler(handler: ConnectionStateHandler): void {
    this.connectionStateHandlers.delete(handler);
  }
  setAuthFailureHandler(handler: (() => void) | null): void {
    this.authFailureHandler = handler;
  }
  setSessionUpdateHandler(handler: SessionUpdateHandler | null): void {
    this.sessionUpdateHandler = handler;
  }
  setSessionCreatedHandler(handler: SessionCreatedHandler | null): void {
    this.sessionCreatedHandler = handler;
  }
  setPromptCompleteHandler(handler: PromptCompleteHandler | null): void {
    this.promptCompleteHandler = handler;
  }
  setPermissionRequestHandler(handler: PermissionRequestHandler | null): void {
    this.permissionRequestHandler = handler;
  }
  setBrowserToolCallHandler(handler: BrowserToolCallHandler | null): void {
    this.browserToolCallHandler = handler;
  }
  setErrorMessageHandler(handler: ErrorMessageHandler | null): void {
    this.errorMessageHandler = handler;
  }
  setModelChangedHandler(handler: ModelChangedHandler | null): void {
    this.modelChangedHandler = handler;
  }
  setModelStateChangedHandler(handler: ModelStateChangedHandler | null): void {
    this.modelStateChangedHandler = handler;
    if (handler) handler(this.state.modelState);
  }
  setModeChangedHandler(handler: ModeChangedHandler | null): void {
    this.modeChangedHandler = handler;
  }
  setModeStateChangedHandler(handler: ModeStateChangedHandler | null): void {
    this.modeStateChangedHandler = handler;
    if (handler) handler(this.state.modeState);
  }
  setAvailableCommandsChangedHandler(handler: AvailableCommandsChangedHandler | null): void {
    this.availableCommandsChangedHandler = handler;
    if (handler) handler(this.state.availableCommands);
  }
  setSessionLoadedHandler(handler: SessionLoadedHandler | null): void {
    this.sessionLoadedHandler = handler;
  }
  setSessionSwitchingHandler(handler: SessionSwitchingHandler | null): void {
    this.sessionSwitchingHandler = handler;
  }

  // ==========================================================================
  // Heartbeat (ACP-level ping/pong, lives in orchestration layer)
  // ==========================================================================

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.missedPongs = 0;

    this.heartbeatInterval = setInterval(() => {
      if (this.transport.state !== "connected") {
        this.stopHeartbeat();
        return;
      }

      try {
        this.transport.send(JSON.stringify({ type: "ping" }));
      } catch {
        this.stopHeartbeat();
        return;
      }

      this.heartbeatTimeout = setTimeout(() => {
        this.missedPongs++;
        if (this.missedPongs >= ACPClient.MAX_MISSED_PONGS) {
          console.warn(`[ACPClient] Server unresponsive (${this.missedPongs} missed pongs), closing`);
          this.stopHeartbeat();
          this.transport.close();
        }
      }, ACPClient.PONG_TIMEOUT_MS);
    }, ACPClient.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  // ==========================================================================
  // Internal helpers
  // ==========================================================================

  private sendRaw(message: unknown): void {
    this.transport.send(JSON.stringify(message));
  }

  private sendJsonRpcAndWait<T>(req: JsonRpcRequest, timeout: number): Promise<T> {
    const promise = this.pending.register<T>(req.id, req, timeout);
    this.sendRaw(req as unknown as Record<string, unknown>);
    return promise;
  }

  private sendJsonRpcAndTrack(req: JsonRpcRequest, timeout: number): Promise<unknown> {
    return this.sendJsonRpcAndWait(req, timeout);
  }

  private resendPending(): void {
    const pendingReqs = this.pending.getPendingRequests();
    for (const { request } of pendingReqs) {
      this.sendRaw(request as Record<string, unknown>);
    }
  }

  private async handleBrowserToolCall(callId: string, params: BrowserToolParams): Promise<void> {
    if (!this.browserToolCallHandler) {
      this.sendRaw({ type: "browser_tool_result", callId, result: { error: "No browser tool handler registered" } });
      return;
    }
    try {
      const result = await this.browserToolCallHandler(params);
      this.sendRaw({ type: "browser_tool_result", callId, result });
    } catch (error) {
      this.sendRaw({ type: "browser_tool_result", callId, result: { error: (error as Error).message } });
    }
  }
}
