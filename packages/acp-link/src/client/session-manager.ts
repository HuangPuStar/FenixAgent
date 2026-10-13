import { type ChildProcess, spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { extractModelState, extractModeState } from "../config-options-utils.js";
import {
  ACP_METHOD,
  createErrorResponse,
  createForwardedErrorResponse,
  createNotification,
  createSuccessResponse,
  isJsonRpcMessage,
  isJsonRpcRequest,
  isTransportMessage,
  type JsonRpcRequest,
} from "../json-rpc.js";
import { buildPeriCapabilityMeta, isPeriTaskNotificationMethod } from "../peri-task-capability.js";
import { buildAgentProcessEnv } from "../spawn-env.js";

// biome-ignore lint/suspicious/noExplicitAny: event callback signatures vary by event type
type SessionEventCallback = (...args: any[]) => void;

const MAX_AGENT_ERROR_LOG_LENGTH = 1_000;

/** Agent/SDK 错误只经脱敏、折叠与截断后进入 acp-link 日志；协议响应保持原有错误契约。 */
function sanitizeAgentErrorForLog(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return Array.from(
    raw
      .replace(/\b(?:https?|wss?):\/\/[^\s<>'"`]+/giu, "[REDACTED_URL]")
      .replace(
        /\b(?:bearer\s+)?[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*\s*[:=]\s*[^\s,;]+/giu,
        "[REDACTED_SECRET]",
      )
      .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, "[REDACTED_SECRET]")
      .replace(
        /(?:^|\s)(?:~\/|\/(?:Users|home|var|tmp|private|etc|opt|srv|workspace)\/)[^\s<>'"`]+/gu,
        (value) => `${value.startsWith(" ") ? " " : ""}[REDACTED_PATH]`,
      )
      .replace(/\s+/g, " ")
      .trim(),
  )
    .slice(0, MAX_AGENT_ERROR_LOG_LENGTH)
    .join("");
}

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
      const spawnEnv = buildAgentProcessEnv(launchSpec?.extraEnv as Record<string, string> | undefined);
      const spawnCwd = (launchSpec?.cwd as string) ?? this.cwd;
      const proc = spawn(this.agentName, ["acp"], {
        cwd: spawnCwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: spawnEnv,
      });

      // biome-ignore lint/suspicious/noExplicitAny: Bun.ChildProcessByStdio 不继承 EventEmitter，需 cast 监听 exit
      (proc as any).on("exit", (code: number | null) => {
        console.log("[session-manager] opencode exited:", code);
        this.sharedProc = null;
        this.sharedConnection = null;
        this.initPromise = null;
        this.currentAcpSessionId = null;
      });

      // agent 可执行文件缺失等 spawn 失败场景必须捕获，否则未监听的 error 事件会崩溃整个进程
      // biome-ignore lint/suspicious/noExplicitAny: 同上，Bun.ChildProcessByStdio 需 cast 监听 error
      (proc as any).on("error", (err: Error) => {
        console.error("[session-manager] spawn failed:", err.message);
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
          // SDK 扩展 notification 入口：把 peri/* 通知经 session_data 包裹转发到
          // 现有 relay（extractJsonRpc 兼容包裹格式），不创建第二套 JSON-RPC 栈
          extNotification: async (method: string, params: Record<string, unknown>) => {
            if (this.activeRelayId && isPeriTaskNotificationMethod(method)) {
              this.emit(this.activeRelayId, "session_data", createNotification(method, params));
            }
          },
        }),
        stream,
      );

      const periMeta = buildPeriCapabilityMeta();
      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "rcs-relay", version: "1.0.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
          // Peri Task View capability（_meta.peri.*，默认关闭，见 peri-task-capability.ts）
          ...(Object.keys(periMeta).length > 0 ? { _meta: periMeta } : {}),
        },
      });
      this.initPromise = Promise.resolve();

      this.sharedProc = proc;
      this.sharedConnection = connection;
      this.agentCapabilities = initResult.agentCapabilities as Record<string, unknown> | null;
      console.log("[session-manager] opencode initialized");

      return "started";
    } catch (err) {
      console.error("[session-manager] startSession failed:", err);
      this.initPromise = null;
      return "error";
    }
  }

  private async emitSessionList(sessionId: string): Promise<void> {
    try {
      const r = await this.sharedConnection!.listSessions({});
      // 过滤掉标题为空或以 "New session" 开头的会话
      const filtered = {
        ...r,
        sessions: r.sessions.filter((s) => s.title?.trim() && !s.title.trim().toLowerCase().startsWith("new session")),
      };
      this.emit(sessionId, "session_data", { type: "session_list", payload: filtered });
    } catch (err) {
      this.emit(sessionId, "session_error", String(err));
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
            this.emit(sessionId, "session_data", {
              type: "session_created",
              payload: { ...r, models: extractModelState(r.configOptions), modes: extractModeState(r.configOptions) },
            });
          } catch (err) {
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "prompt": {
          if (!this.currentAcpSessionId) {
            const r = await this.sharedConnection.newSession({ cwd: this.cwd, mcpServers: [] });
            this.currentAcpSessionId = r.sessionId;
            this.emit(sessionId, "session_data", {
              type: "session_created",
              payload: { ...r, models: extractModelState(r.configOptions), modes: extractModeState(r.configOptions) },
            });
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
            .setSessionConfigOption?.({
              sessionId: this.currentAcpSessionId,
              configId: "model",
              value: (payload.modelId as string) ?? "",
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
            this.emit(sessionId, "session_data", {
              type: "session_resumed",
              payload: { ...r, models: extractModelState(r.configOptions), modes: extractModeState(r.configOptions) },
            });
          } catch (err) {
            console.error("[session-manager] resumeSession failed:", String(err));
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "list_sessions":
          await this.emitSessionList(sessionId);
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
            this.emit(sessionId, "session_data", {
              type: "session_loaded",
              payload: { ...r, models: extractModelState(r.configOptions), modes: extractModeState(r.configOptions) },
            });
          } catch (err) {
            console.error("[session-manager] loadSession failed:", String(err));
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "delete_session":
          try {
            const targetSid = (payload.sessionId as string) ?? "";
            await this.sharedConnection.deleteSession({ sessionId: targetSid });
            this.emit(sessionId, "session_data", {
              type: "session_deleted",
              payload: { sessionId: targetSid },
            });
            // 删除成功后立即刷新 session/list，让前端历史列表无需等待轮询
            await this.emitSessionList(sessionId);
          } catch (err) {
            console.error("[session-manager] deleteSession failed:", String(err));
            this.emit(sessionId, "session_error", String(err));
          }
          break;
        case "rename_session": {
          this.emit(sessionId, "session_error", "session/rename is not supported by ACP");
          break;
        }
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
          this.emit(
            sessionId,
            "session_data",
            createSuccessResponse(id, {
              ...r,
              models: extractModelState(r.configOptions),
              modes: extractModeState(r.configOptions),
            }),
          );
          break;
        }
        case ACP_METHOD.SESSION_PROMPT: {
          const requestedSessionId = typeof p.sessionId === "string" && p.sessionId.length > 0 ? p.sessionId : null;
          if (!requestedSessionId && !this.currentAcpSessionId) {
            const r = await this.sharedConnection!.newSession({ cwd: this.cwd, mcpServers: [] });
            this.currentAcpSessionId = r.sessionId;
          }
          const targetSessionId = requestedSessionId ?? this.currentAcpSessionId!;
          const blocks = (p.content as acp.ContentBlock[]) ?? [];
          if (this.systemPrompt) {
            blocks.unshift({ type: "text" as const, text: this.systemPrompt });
            this.systemPrompt = null;
            console.log("[session-manager] injected system prompt");
          }
          console.log("[session-manager] prompt (json-rpc), acpSession:", targetSessionId);
          this.sharedConnection!.prompt({ sessionId: targetSessionId, prompt: blocks })
            .then((result) => {
              console.log(
                "[session-manager] prompt completed, stopReason:",
                (result as unknown as Record<string, unknown>).stopReason,
              );
              this.emit(sessionId, "session_data", { type: "prompt_complete", payload: result });
            })
            .catch((err) => {
              console.error("[session-manager] prompt failed:", sanitizeAgentErrorForLog(err));
              this.emit(sessionId, "session_data", createForwardedErrorResponse(id, err, String(err)));
            });
          break;
        }
        case ACP_METHOD.SESSION_CANCEL: {
          const targetSessionId =
            typeof p.sessionId === "string" && p.sessionId.length > 0 ? p.sessionId : this.currentAcpSessionId;
          if (targetSessionId) {
            await this.sharedConnection!.cancel({ sessionId: targetSessionId });
          }
          this.emit(sessionId, "session_data", createSuccessResponse(id, { cancelled: true }));
          break;
        }
        case ACP_METHOD.SESSION_SET_MODEL: {
          if (!this.currentAcpSessionId) {
            this.emit(sessionId, "session_data", createErrorResponse(id, -32000, "No active session"));
            break;
          }
          await this.sharedConnection!.setSessionConfigOption?.({
            sessionId: this.currentAcpSessionId,
            configId: "model",
            value: (p.modelId as string) ?? "",
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
          this.emit(
            sessionId,
            "session_data",
            createSuccessResponse(id, {
              ...r,
              models: extractModelState(r.configOptions),
              modes: extractModeState(r.configOptions),
            }),
          );
          break;
        }
        case ACP_METHOD.SESSION_LIST: {
          const r = await this.sharedConnection!.listSessions({});
          // 过滤掉标题为空或以 "New session" 开头的会话
          const filtered = {
            ...r,
            sessions: r.sessions.filter(
              (s) => s.title?.trim() && !s.title.trim().toLowerCase().startsWith("new session"),
            ),
          };
          this.emit(sessionId, "session_data", createSuccessResponse(id, filtered));
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
          this.emit(
            sessionId,
            "session_data",
            createSuccessResponse(id, {
              ...r,
              models: extractModelState(r.configOptions),
              modes: extractModeState(r.configOptions),
            }),
          );
          break;
        }
        case ACP_METHOD.SESSION_DELETE: {
          const targetSid = (p.sessionId as string) ?? "";
          await this.sharedConnection!.deleteSession({ sessionId: targetSid });
          this.emit(sessionId, "session_data", createSuccessResponse(id, { deleted: true, sessionId: targetSid }));
          break;
        }
        case ACP_METHOD.SESSION_RENAME: {
          this.emit(
            sessionId,
            "session_data",
            createErrorResponse(id, -32601, "session/rename is not supported by ACP"),
          );
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
