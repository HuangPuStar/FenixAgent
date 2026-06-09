import * as acp from "@agentclientprotocol/sdk";
import { AcpDispatcher, type AcpSessionState, createAcpSessionState } from "./acp-adapter.js";
import type { ContentBlock } from "./acp-types.js";

// biome-ignore lint/suspicious/noExplicitAny: event callback signatures vary by event type
type SessionEventCallback = (...args: any[]) => void;

/**
 * opencode ACP session 处理器。
 * 封装 ACP session 生命周期、系统提示注入、权限策略、sendData 消息路由。
 */
export class SessionHandler {
  private listeners = new Map<string, SessionEventCallback[]>();
  private systemPrompt: string | null = null;
  private currentAcpSessionId: string | null = null;
  private sessionState: AcpSessionState;

  constructor(
    private connection: acp.ClientSideConnection,
    private cwd: string,
    capabilities: Record<string, unknown>,
    private send: (type: string, payload?: unknown) => void,
  ) {
    this.sessionState = createAcpSessionState();
    this.sessionState.connection = connection;
    // biome-ignore lint/suspicious/noExplicitAny: capabilities shape varies
    this.sessionState.agentCapabilities = capabilities as any;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    console.log("[opencode-bridge] system prompt set:", prompt.substring(0, 50));
  }

  /** 自动创建 ACP session（bootstrap 行为） */
  async autoCreateSession(sessionId: string): Promise<void> {
    try {
      const autoSession = await this.connection.newSession({ cwd: this.cwd, mcpServers: [] });
      this.currentAcpSessionId = autoSession.sessionId;
      this.sessionState.sessionId = autoSession.sessionId;
      console.log("[opencode-bridge] auto-created:", autoSession.sessionId);
      this.emit(sessionId, "session_data", { type: "session_created", payload: autoSession });
    } catch (err) {
      console.error("[opencode-bridge] auto newSession failed:", err);
    }
  }

  /** 处理 ACP 消息路由 */
  async sendData(sessionId: string, rawPayload: unknown): Promise<boolean> {
    const msg = rawPayload as Record<string, unknown>;
    const type = msg.type as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    try {
      switch (type) {
        case "connect":
          break;
        case "new_session":
          await this.handleNewSession(sessionId, payload);
          break;
        case "prompt":
          await this.handlePrompt(sessionId, payload);
          break;
        case "cancel":
          await this.handleCancel();
          break;
        case "set_session_model":
          await this.handleSetSessionModel(sessionId, payload);
          break;
        case "set_session_mode":
          await this.handleSetSessionMode(sessionId, payload);
          break;
        case "resume_session":
          await this.handleResumeSession(sessionId, payload);
          break;
        case "list_sessions":
          await this.handleListSessions(sessionId);
          break;
        case "load_session":
          await this.handleLoadSession(sessionId, payload);
          break;
        default:
          console.log("[opencode-bridge] unknown:", type);
      }
    } catch (err) {
      console.error("[opencode-bridge] sendData error:", err);
      this.emit(sessionId, "session_error", String(err));
    }
    return true;
  }

  getDispatcher(): AcpDispatcher {
    if (!this.sessionState.dispatcher) {
      this.sessionState.dispatcher = new AcpDispatcher(this.sessionState, this.send);
    }
    return this.sessionState.dispatcher;
  }

  on(event: string, cb: SessionEventCallback): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }

  private emit(sessionId: string, event: string, payload: unknown): void {
    for (const cb of this.listeners.get(event) ?? []) {
      cb(sessionId, payload);
    }
  }

  private async handleNewSession(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    const r = await this.connection.newSession({
      cwd: (payload.cwd as string) ?? this.cwd,
      mcpServers: [],
    });
    this.currentAcpSessionId = r.sessionId;
    this.emit(sessionId, "session_data", { type: "session_created", payload: r });
  }

  private async handlePrompt(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.currentAcpSessionId) {
      const r = await this.connection.newSession({ cwd: this.cwd, mcpServers: [] });
      this.currentAcpSessionId = r.sessionId;
      this.emit(sessionId, "session_data", { type: "session_created", payload: r });
    }
    const blocks = (payload.content as ContentBlock[]) ?? [];
    if (this.systemPrompt) {
      blocks.unshift({ type: "text" as const, text: this.systemPrompt });
      this.systemPrompt = null;
      console.log("[opencode-bridge] injected system prompt");
    }
    this.connection
      .prompt({ sessionId: this.currentAcpSessionId!, prompt: blocks as acp.ContentBlock[] })
      .then((result) => {
        this.emit(sessionId, "session_data", { type: "prompt_complete", payload: result });
      })
      .catch((err) => {
        console.error("[opencode-bridge] prompt failed:", err);
        this.emit(sessionId, "session_error", String(err));
      });
  }

  private async handleCancel(): Promise<void> {
    if (this.currentAcpSessionId) {
      this.connection.cancel({ sessionId: this.currentAcpSessionId }).catch(() => {});
    }
  }

  private async handleSetSessionModel(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.currentAcpSessionId) {
      this.emit(sessionId, "session_error", "No active session");
      return;
    }
    this.connection
      .unstable_setSessionModel({
        sessionId: this.currentAcpSessionId,
        modelId: (payload.modelId as string) ?? "",
      })
      .then(() =>
        this.emit(sessionId, "session_data", { type: "model_changed", payload: { modelId: payload.modelId } }),
      )
      .catch(() => {});
  }

  private async handleSetSessionMode(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.currentAcpSessionId) {
      this.emit(sessionId, "session_error", "No active session");
      return;
    }
    this.connection
      .setSessionMode({ sessionId: this.currentAcpSessionId, modeId: (payload.modeId as string) ?? "" })
      .then(() => this.emit(sessionId, "session_data", { type: "mode_changed", payload: { modeId: payload.modeId } }))
      .catch(() => {});
  }

  private async handleResumeSession(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    // biome-ignore lint/suspicious/noExplicitAny: unstable_resumeSession not in SDK types
    const r = await (this.connection as any).unstable_resumeSession({
      sessionId: (payload.sessionId as string) ?? "",
      cwd: this.cwd,
    });
    this.currentAcpSessionId = r.sessionId ?? (payload.sessionId as string);
    this.emit(sessionId, "session_data", { type: "session_resumed", payload: r });
  }

  private async handleListSessions(sessionId: string): Promise<void> {
    const r = await this.connection.listSessions({});
    this.emit(sessionId, "session_data", { type: "session_list", payload: r });
  }

  private async handleLoadSession(sessionId: string, payload: Record<string, unknown>): Promise<void> {
    const targetSid = (payload.sessionId as string) ?? "";
    const r = await this.connection.loadSession({ sessionId: targetSid, cwd: this.cwd, mcpServers: [] });
    this.currentAcpSessionId = targetSid;
    this.emit(sessionId, "session_data", { type: "session_loaded", payload: r });
  }
}
