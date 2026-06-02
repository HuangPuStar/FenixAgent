import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import {
  type JsonRpcRequest,
  ACP_METHOD,
  createSuccessResponse,
  createNotification,
  createErrorResponse,
  isJsonRpcMessage,
  isJsonRpcRequest,
  isTransportMessage,
} from "../json-rpc.js";

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

  async startSession(sessionId: string, launchSpec?: Record<string, unknown>): Promise<"started" | "queued" | "error"> {
    console.log("[session-manager] startSession:", sessionId, launchSpec ? "with launchSpec" : "");
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
      const spawnEnv = launchSpec?.extraEnv
        ? { ...process.env, ...(launchSpec.extraEnv as Record<string, string>) }
        : { ...process.env };
      const spawnCwd = (launchSpec?.cwd as string) ?? this.cwd;
      const proc = spawn(this.agentName, ["acp"], {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv,
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
              this.emit(this.activeRelayId, "session_data", createNotification(ACP_METHOD.SESSION_UPDATE, params));
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

    // 传输层消息 — 直接忽略
    if (isTransportMessage(rawPayload)) {
      return true;
    }

    // JSON-RPC 请求
    if (isJsonRpcMessage(rawPayload) && isJsonRpcRequest(rawPayload)) {
      const msg = rawPayload as unknown as JsonRpcRequest;
      await this.handleJsonRpc(sessionId, msg);
      return true;
    }

    // 旧格式兼容：自定义 { type, payload } 消息
    const msg = rawPayload as Record<string, unknown>;
    const type = msg.type as string;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;

    try {
      switch (type) {
        case "session_data":
          // 内嵌 payload — 可能是 JSON-RPC
          return this.sendData(sessionId, payload);
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
          if (this.systemPrompt) {
            blocks.unshift({ type: "text" as const, text: this.systemPrompt });
            this.systemPrompt = null;
            console.log("[session-manager] injected system prompt");
          }
          console.log("[session-manager] prompt, acpSession:", this.currentAcpSessionId);
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

  private async handleJsonRpc(sessionId: string, msg: JsonRpcRequest): Promise<void> {
    const { id, method, params } = msg;
    const p = (params ?? {}) as Record<string, unknown>;

    try {
      switch (method) {
        case ACP_METHOD.SESSION_NEW: {
          const r = await this.sharedConnection!.newSession({
            cwd: (p.cwd as string) ?? this.cwd,
            mcpServers: [],
          });
          this.currentAcpSessionId = r.sessionId;
          this.emit(sessionId, "session_data", createSuccessResponse(id, r));
          break;
        }
        case ACP_METHOD.SESSION_PROMPT: {
          if (!this.currentAcpSessionId) {
            const r = await this.sharedConnection!.newSession({ cwd: this.cwd, mcpServers: [] });
            this.currentAcpSessionId = r.sessionId;
          }
          const blocks = (p.content as acp.ContentBlock[]) ?? [];
          if (this.systemPrompt) {
            blocks.unshift({ type: "text" as const, text: this.systemPrompt });
            this.systemPrompt = null;
            console.log("[session-manager] injected system prompt");
          }
          console.log("[session-manager] prompt (json-rpc), acpSession:", this.currentAcpSessionId);
          this.sharedConnection!
            .prompt({ sessionId: this.currentAcpSessionId!, prompt: blocks })
            .then((result) => {
              console.log(
                "[session-manager] prompt completed, stopReason:",
                (result as unknown as Record<string, unknown>).stopReason,
              );
              this.emit(sessionId, "session_data", createSuccessResponse(id, result));
            })
            .catch((err) => {
              this.emit(sessionId, "session_data", createErrorResponse(id, -32603, String(err)));
            });
          break;
        }
        case ACP_METHOD.SESSION_CANCEL: {
          if (this.currentAcpSessionId) {
            await this.sharedConnection!.cancel({ sessionId: this.currentAcpSessionId });
          }
          this.emit(sessionId, "session_data", createSuccessResponse(id, { cancelled: true }));
          break;
        }
        case ACP_METHOD.SESSION_SET_MODEL: {
          if (!this.currentAcpSessionId) {
            this.emit(sessionId, "session_data", createErrorResponse(id, -32000, "No active session"));
            break;
          }
          await this.sharedConnection!.unstable_setSessionModel({
            sessionId: this.currentAcpSessionId,
            modelId: (p.modelId as string) ?? "",
          });
          this.emit(sessionId, "session_data", createSuccessResponse(id, { modelId: p.modelId }));
          break;
        }
        case ACP_METHOD.SESSION_SET_MODE: {
          if (!this.currentAcpSessionId) {
            this.emit(sessionId, "session_data", createErrorResponse(id, -32000, "No active session"));
            break;
          }
          await this.sharedConnection!.setSessionMode({
            sessionId: this.currentAcpSessionId,
            modeId: (p.modeId as string) ?? "",
          });
          this.emit(sessionId, "session_data", createSuccessResponse(id, { modeId: p.modeId }));
          break;
        }
        case ACP_METHOD.SESSION_RESUME: {
          // biome-ignore lint/suspicious/noExplicitAny: unstable_resumeSession not in SDK types
          const r = await (this.sharedConnection as any).unstable_resumeSession({
            sessionId: (p.sessionId as string) ?? "",
            cwd: this.cwd,
          });
          this.currentAcpSessionId = r.sessionId ?? (p.sessionId as string);
          this.emit(sessionId, "session_data", createSuccessResponse(id, r));
          break;
        }
        case ACP_METHOD.SESSION_LIST: {
          const r = await this.sharedConnection!.listSessions({});
          this.emit(sessionId, "session_data", createSuccessResponse(id, r));
          break;
        }
        case ACP_METHOD.SESSION_LOAD: {
          const targetSid = (p.sessionId as string) ?? "";
          const r = await this.sharedConnection!.loadSession({
            sessionId: targetSid,
            cwd: this.cwd,
            mcpServers: [],
          });
          this.currentAcpSessionId = targetSid;
          this.emit(sessionId, "session_data", createSuccessResponse(id, r));
          break;
        }
        default:
          this.emit(sessionId, "session_data", createErrorResponse(id, -32601, `Method not found: ${method}`));
      }
    } catch (err) {
      console.error("[session-manager] handleJsonRpc error:", err);
      this.emit(sessionId, "session_data", createErrorResponse(id, -32603, String(err)));
    }
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
    for (const cb of this.listeners.get(event) ?? []) {
      cb(sessionId, payload);
    }
  }
}
