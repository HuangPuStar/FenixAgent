import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

// biome-ignore lint/suspicious/noExplicitAny: event callback signatures vary by event type
type SessionEventCallback = (...args: any[]) => void;

export class SessionManager {
  private listeners = new Map<string, SessionEventCallback[]>();
  private readonly agentName: string;
  private readonly cwd: string;

  private sharedProc: ChildProcess | null = null;
  private sharedConnection: acp.ClientSideConnection | null = null;
  private initPromise: Promise<void> | null = null;
  private currentAcpSessionId: string | null = null;
  private agentCapabilities: Record<string, unknown> | null = null;
  private activeRelayId: string | null = null;
  private systemPrompt: string | null = null;

  getCapabilities(): Record<string, unknown> | null {
    return this.agentCapabilities;
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
    console.log("[session-manager] system prompt set:", prompt.substring(0, 50));
  }

  constructor(agentName: string, _maxSessions = 5, cwd = "/home/bun/app") {
    this.agentName = agentName;
    this.cwd = cwd;
  }

  async startSession(sessionId: string): Promise<"started" | "queued" | "error"> {
    console.log("[session-manager] startSession:", sessionId);
    this.activeRelayId = sessionId;

    if (this.sharedConnection && this.sharedProc && !this.sharedProc.killed && this.sharedProc.exitCode === null) {
      console.log("[session-manager] reusing opencode");
      if (this.currentAcpSessionId) {
        try {
          const response = await this.sharedConnection.listSessions({});
          const existing = response.sessions.find(
            (s: { sessionId: string }) => s.sessionId === this.currentAcpSessionId,
          );
          if (existing) {
            this.emit(sessionId, "session_data", { type: "session_created", payload: existing });
          }
        } catch {
          /* ignore */
        }
      }
      return "started";
    }

    if (this.initPromise) {
      try {
        await this.initPromise;
        return "started";
      } catch {
        return "error";
      }
    }

    try {
      console.log("[session-manager] spawning opencode...");
      const proc = spawn(this.agentName, ["acp"], {
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env },
      });

      proc.on("exit", (code) => {
        console.log("[session-manager] opencode exited:", code);
        this.sharedProc = null;
        this.sharedConnection = null;
        this.initPromise = null;
        this.currentAcpSessionId = null;
      });

      const input = Writable.toWeb(proc.stdin!) as unknown as WritableStream<Uint8Array>;
      const output = Readable.toWeb(proc.stdout!) as unknown as ReadableStream<Uint8Array>;
      const stream = acp.ndJsonStream(input, output);

      const connection = new acp.ClientSideConnection(
        (_agent) => ({
          requestPermission: async (_p) => ({ outcome: { outcome: "selected" as const, optionId: "allow" } }),
          sessionUpdate: async (params) => {
            if (this.activeRelayId) {
              this.emit(this.activeRelayId, "session_data", { type: "session_update", payload: params });
            }
          },
          readTextFile: async (_p) => ({ content: "" }),
          writeTextFile: async (_p) => ({}),
        }),
        stream,
      );

      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "rcs-relay", version: "1.0.0" },
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });
      this.initPromise = Promise.resolve();

      this.sharedProc = proc;
      this.sharedConnection = connection;
      this.agentCapabilities = initResult.agentCapabilities as Record<string, unknown> | null;
      console.log("[session-manager] opencode initialized");

      // 首次初始化时自动创建一个 session（前端 bootstrap 时序依赖此行为）
      try {
        const autoSession = await connection.newSession({ cwd: this.cwd, mcpServers: [] });
        this.currentAcpSessionId = autoSession.sessionId;
        console.log("[session-manager] auto-created:", autoSession.sessionId);
        this.emit(sessionId, "session_data", { type: "session_created", payload: autoSession });
      } catch (err) {
        console.error("[session-manager] auto newSession failed:", err);
      }

      return "started";
    } catch (err) {
      console.error("[session-manager] startSession failed:", err);
      this.initPromise = null;
      return "error";
    }
  }

  async sendData(sessionId: string, rawPayload: unknown): Promise<boolean> {
    this.activeRelayId = sessionId;

    if (!this.sharedConnection) {
      this.startSession(sessionId).then((r) => {
        if (r === "started") this.sendData(sessionId, rawPayload);
      });
      return true;
    }

    const msg = rawPayload as Record<string, unknown>;
    const type = msg.type as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    try {
      switch (type) {
        case "connect":
          break;
        case "new_session":
          try {
            const r = await this.sharedConnection.newSession({
              cwd: (payload.cwd as string) ?? this.cwd,
              mcpServers: [],
            });
            this.currentAcpSessionId = r.sessionId;
            this.emit(sessionId, "session_data", { type: "session_created", payload: r });
          } catch (err) {
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "prompt": {
          if (!this.currentAcpSessionId) {
            const r = await this.sharedConnection.newSession({ cwd: this.cwd, mcpServers: [] });
            this.currentAcpSessionId = r.sessionId;
            this.emit(sessionId, "session_data", { type: "session_created", payload: r });
          }
          const blocks = (payload.content as acp.ContentBlock[]) ?? [];
          // 注入系统提示词（恢复 Phase 2 删除的 Instance AgentLaunchSpec prompt 链路）
          if (this.systemPrompt) {
            blocks.unshift({ type: "text" as const, text: this.systemPrompt });
            this.systemPrompt = null;
            console.log("[session-manager] injected system prompt");
          }
          console.log("[session-manager] prompt, acpSession:", this.currentAcpSessionId);
          // 与 server 模式 handlePrompt 一致：await 结果并发送 prompt_complete
          this.sharedConnection
            .prompt({ sessionId: this.currentAcpSessionId!, prompt: blocks })
            .then((result) => {
              console.log(
                "[session-manager] prompt completed, stopReason:",
                (result as unknown as Record<string, unknown>).stopReason,
              );
              this.emit(sessionId, "session_data", { type: "prompt_complete", payload: result });
            })
            .catch((err) => {
              console.error("[session-manager] prompt failed:", err);
              this.emit(sessionId, "session_error", String(err));
            });
          break;
        }
        case "cancel":
          if (this.currentAcpSessionId) {
            this.sharedConnection.cancel({ sessionId: this.currentAcpSessionId }).catch(() => {});
          }
          break;
        case "set_session_model":
          if (!this.currentAcpSessionId) {
            this.emit(sessionId, "session_error", "No active session");
            break;
          }
          this.sharedConnection
            .unstable_setSessionModel({
              sessionId: this.currentAcpSessionId,
              modelId: (payload.modelId as string) ?? "",
            })
            .then(() =>
              this.emit(sessionId, "session_data", { type: "model_changed", payload: { modelId: payload.modelId } }),
            )
            .catch(() => {});
          break;
        case "set_session_mode":
          if (!this.currentAcpSessionId) {
            this.emit(sessionId, "session_error", "No active session");
            break;
          }
          this.sharedConnection
            .setSessionMode({ sessionId: this.currentAcpSessionId, modeId: (payload.modeId as string) ?? "" })
            .then(() =>
              this.emit(sessionId, "session_data", { type: "mode_changed", payload: { modeId: payload.modeId } }),
            )
            .catch(() => {});
          break;
        case "resume_session":
          try {
            // 与 server 模式 handleResumeSession 一致：unstable_resumeSession + cwd
            // biome-ignore lint/suspicious/noExplicitAny: unstable_resumeSession not in SDK types
            const r = await (this.sharedConnection as any).unstable_resumeSession({
              sessionId: (payload.sessionId as string) ?? "",
              cwd: this.cwd,
            });
            this.currentAcpSessionId = r.sessionId ?? (payload.sessionId as string);
            this.emit(sessionId, "session_data", { type: "session_resumed", payload: r });
          } catch (err) {
            console.error("[session-manager] resumeSession failed:", String(err));
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "list_sessions":
          try {
            const r = await this.sharedConnection.listSessions({});
            this.emit(sessionId, "session_data", { type: "session_list", payload: r });
          } catch (err) {
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "load_session":
          try {
            const targetSid = (payload.sessionId as string) ?? "";
            const r = await this.sharedConnection.loadSession({
              sessionId: targetSid,
              cwd: this.cwd,
              mcpServers: [],
            });
            this.currentAcpSessionId = targetSid;
            this.emit(sessionId, "session_data", { type: "session_loaded", payload: r });
          } catch (err) {
            console.error("[session-manager] loadSession failed:", String(err));
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        default:
          console.log("[session-manager] unknown:", type);
      }
    } catch (err) {
      console.error("[session-manager] sendData error:", err);
      this.emit(sessionId, "session_error", String(err));
    }

    return true;
  }

  endSession(_sessionId: string): void {
    /* shared proc, don't kill */
  }
  getAliveSessionIds(): string[] {
    return this.sharedProc && !this.sharedProc.killed ? ["shared"] : [];
  }
  hasSession(_s: string): boolean {
    return this.sharedProc !== null && !this.sharedProc.killed;
  }

  stopAll(): void {
    if (this.sharedProc) {
      this.sharedProc.kill("SIGTERM");
    }
    this.sharedProc = null;
    this.sharedConnection = null;
    this.initPromise = null;
    this.currentAcpSessionId = null;
    this.activeRelayId = null;
  }

  on(event: string, cb: SessionEventCallback): void {
    const arr = this.listeners.get(event) ?? [];
    arr.push(cb);
    this.listeners.set(event, arr);
  }

  private emit(sessionId: string, event: string, payload: unknown): void {
    // 先将 payload 保存下来，然后通过 listeners 触发
    // server.ts 的 setupSessionCallbacks 中 on("session_data", ...) 会收到这个事件
    // 然后 ws.send({ type: "session_data", session_id: sessionId, payload })
    for (const cb of this.listeners.get(event) ?? []) {
      cb(sessionId, payload);
    }
  }
}
