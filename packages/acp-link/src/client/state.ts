import type {
  AgentCapabilities,
  AvailableCommand,
  ConnectionState,
  PromptCapabilities,
  SessionModelState,
  SessionModeState,
  SessionUpdate,
} from "../types.js";
import { EventEmitter } from "./emitter.js";
import type { ACPProtocol } from "./protocol.js";
import type { WSTransport } from "./transport.js";

export interface StateEvents {
  connectionStateChange: { state: ConnectionState; error?: string };
  sessionIdChange: string | null;
  capabilitiesChange: AgentCapabilities | null;
  promptCapabilitiesChange: PromptCapabilities | null;
  modelStateChange: SessionModelState | null;
  modeStateChange: SessionModeState | null;
  availableCommandsChange: AvailableCommand[];
  [key: string]: unknown;
}

/**
 * ACP 会话状态管理。
 *
 * 订阅 transport 和 protocol 事件，维护状态，通过 EventEmitter 通知变更。
 * 不持有任何传输或协议逻辑。
 */
export class ACPState extends EventEmitter<StateEvents> {
  private _connectionState: ConnectionState = "disconnected";
  private _sessionId: string | null = null;
  private _agentCapabilities: AgentCapabilities | null = null;
  private _promptCapabilities: PromptCapabilities | null = null;
  private _modelState: SessionModelState | null = null;
  private _modeState: SessionModeState | null = null;
  private _availableCommands: AvailableCommand[] = [];

  // Getters
  get connectionState(): ConnectionState {
    return this._connectionState;
  }
  get sessionId(): string | null {
    return this._sessionId;
  }
  get agentCapabilities(): AgentCapabilities | null {
    return this._agentCapabilities;
  }
  get promptCapabilities(): PromptCapabilities | null {
    return this._promptCapabilities;
  }
  get modelState(): SessionModelState | null {
    return this._modelState;
  }
  get modeState(): SessionModeState | null {
    return this._modeState;
  }
  get availableCommands(): AvailableCommand[] {
    return this._availableCommands;
  }

  // Derived getters
  get supportsImages(): boolean {
    return this._promptCapabilities?.image === true;
  }

  get supportsModelSelection(): boolean {
    return this._modelState !== null && this._modelState.availableModels.length > 0;
  }

  get supportsLoadSession(): boolean {
    return this._agentCapabilities?.loadSession === true;
  }

  get supportsResumeSession(): boolean {
    return (
      this._agentCapabilities?.sessionCapabilities?.resume !== undefined &&
      this._agentCapabilities?.sessionCapabilities?.resume !== null
    );
  }

  get supportsSessionList(): boolean {
    return (
      this._agentCapabilities?.sessionCapabilities?.list !== undefined &&
      this._agentCapabilities?.sessionCapabilities?.list !== null
    );
  }

  get supportsSessionHistory(): boolean {
    return this.supportsLoadSession || this.supportsResumeSession;
  }

  /**
   * 连接到 transport + protocol，开始同步状态。
   * 返回 cleanup 函数用于解绑。
   */
  bind(transport: WSTransport, protocol: ACPProtocol): () => void {
    // Transport 事件
    const onTransportState = ({ state, detail }: { state: string; detail?: CloseEvent }) => {
      if (state === "connected") {
        this.setConnectionState("connected");
      } else if (state === "connecting") {
        this.setConnectionState("connecting");
      } else if (state === "error") {
        const error = detail?.code === 4001 ? "登录已过期" : detail?.reason || "连接已断开，请刷新页面重试";
        this.setConnectionState("error", error);
      } else if (state === "disconnected") {
        this.resetSessionState();
        this.setConnectionState("disconnected");
      }
    };
    transport.on("state", onTransportState);

    // Protocol 事件
    const onStatus = (payload: { connected: boolean; capabilities?: AgentCapabilities }) => {
      if (payload.connected) {
        this.setCapabilities(payload.capabilities ?? null);
      }
    };

    const onSessionCreated = (payload: Parameters<ACPState["initSession"]>[0]) => {
      this.initSession(payload);
    };

    const onSessionLoaded = (payload: Parameters<ACPState["initSession"]>[0]) => {
      this.initSession(payload);
    };

    const onSessionResumed = (payload: Parameters<ACPState["initSession"]>[0]) => {
      this.initSession(payload);
    };

    const onSessionUpdate = ({ update }: { sessionId: string; update: SessionUpdate }) => {
      if (update.sessionUpdate === "available_commands_update") {
        this._availableCommands = update.availableCommands;
        this.emit("availableCommandsChange", this._availableCommands);
      }
    };

    const onModelChanged = ({ modelId }: { modelId: string }) => {
      if (this._modelState) {
        this._modelState = { ...this._modelState, currentModelId: modelId };
        this.emit("modelStateChange", this._modelState);
      }
    };

    const onModeChanged = ({ modeId }: { modeId: string }) => {
      if (this._modeState) {
        this._modeState = { ...this._modeState, currentModeId: modeId };
        this.emit("modeStateChange", this._modeState);
      }
    };

    protocol.on("status", onStatus);
    protocol.on("session_created", onSessionCreated);
    protocol.on("session_loaded", onSessionLoaded);
    protocol.on("session_resumed", onSessionResumed);
    protocol.on("session_update", onSessionUpdate);
    protocol.on("model_changed", onModelChanged);
    protocol.on("mode_changed", onModeChanged);

    // 返回 cleanup
    return () => {
      transport.off("state", onTransportState);
      protocol.off("status", onStatus);
      protocol.off("session_created", onSessionCreated);
      protocol.off("session_loaded", onSessionLoaded);
      protocol.off("session_resumed", onSessionResumed);
      protocol.off("session_update", onSessionUpdate);
      protocol.off("model_changed", onModelChanged);
      protocol.off("mode_changed", onModeChanged);
    };
  }

  /**
   * 从 JSON-RPC 响应中初始化 session 状态（sessionId + capabilities + models + modes）。
   * 供 ACPClient 在收到 session/new、session/load、session/resume 响应时调用。
   */
  initSession(payload: {
    sessionId: string;
    promptCapabilities?: PromptCapabilities | null;
    models?: SessionModelState | null;
    modes?: SessionModeState | null;
  }): void {
    this._sessionId = payload.sessionId;
    this.emit("sessionIdChange", this._sessionId);
    this.setPromptCapabilities(payload.promptCapabilities ?? null);
    this.setModelState(payload.models ?? null);
    this.setModeState(payload.modes ?? null);
  }

  /** 更新当前 model 并发射 modelStateChange 事件 */
  updateCurrentModel(modelId: string): void {
    if (this._modelState) {
      this._modelState = { ...this._modelState, currentModelId: modelId };
      this.emit("modelStateChange", this._modelState);
    }
  }

  /** 更新当前 mode 并发射 modeStateChange 事件 */
  updateCurrentMode(modeId: string): void {
    if (this._modeState) {
      this._modeState = { ...this._modeState, currentModeId: modeId };
      this.emit("modeStateChange", this._modeState);
    }
  }

  /** 断开所有订阅，重置状态 */
  reset(): void {
    this.resetSessionState();
    this.setConnectionState("disconnected");
  }

  private setConnectionState(state: ConnectionState, error?: string): void {
    this._connectionState = state;
    this.emit("connectionStateChange", { state, error });
  }

  private setCapabilities(capabilities: AgentCapabilities | null): void {
    this._agentCapabilities = capabilities;
    this.emit("capabilitiesChange", capabilities);
  }

  private setPromptCapabilities(capabilities: PromptCapabilities | null): void {
    this._promptCapabilities = capabilities;
    this.emit("promptCapabilitiesChange", capabilities);
  }

  private setModelState(state: SessionModelState | null): void {
    this._modelState = state;
    this.emit("modelStateChange", state);
  }

  private setModeState(state: SessionModeState | null): void {
    this._modeState = state;
    this.emit("modeStateChange", state);
  }

  private resetSessionState(): void {
    this._sessionId = null;
    this._agentCapabilities = null;
    this._promptCapabilities = null;
    this._modelState = null;
    this._modeState = null;
    this._availableCommands = [];

    this.emit("sessionIdChange", null);
    this.emit("capabilitiesChange", null);
    this.emit("promptCapabilitiesChange", null);
    this.emit("modelStateChange", null);
    this.emit("modeStateChange", null);
    this.emit("availableCommandsChange", []);
  }
}
