import { type ChildProcess, spawn } from "node:child_process";
import os from "node:os";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { handleFileOp } from "./client/file-operations.js";
import { InstanceManager } from "./client/instance-manager.js";
import { SessionManager } from "./client/session-manager.js";
import {
  ACP_METHOD,
  createErrorResponse,
  createNotification,
  createSuccessResponse,
  isJsonRpcMessage,
  isJsonRpcRequest,
  isTransportMessage,
  type JsonRpcRequest,
} from "./json-rpc.js";
import type { AgentCapabilities, ContentBlock, PromptCapabilities, SessionModelState } from "./types.js";
import { decodeJsonWsMessage, WsPayloadTooLargeError } from "./ws-message.js";

// ── WebSocket 抽象接口 ──────────────────────────────
// 同时满足 Bun AcpWs 和 Node.js ws.WebSocket 的最小接口
interface AcpWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
  ping(): void;
}

// WebSocket readyState 常量（跨运行时通用）
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

// 运行时检测
const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

// biome-ignore lint/suspicious/noExplicitAny: dynamic require for runtime adapter
type AdapterFn = (port: number, host: string, cb: any) => { port: number; stop(): void };

function getAdapter(): AdapterFn {
  if (isBun) {
    return require("./adapter-bun.js").startBunWsServer;
  }
  return require("./adapter-node.js").startNodeWsServer;
}

export { MAX_CLIENT_WS_PAYLOAD_BYTES } from "./ws-message.js";

export interface ServerConfig {
  port: number;
  host: string;
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  rcsUrl?: string;
  rcsSecret?: string;
  tenantId?: string;
  userId?: string;
  labels?: string[];
}

export interface AcpServerHandle {
  close: () => void;
}

// Pending permission request
interface PendingPermission {
  jsonRpcId: number | string;
  resolve: (outcome: { outcome: "cancelled" } | { outcome: "selected"; optionId: string }) => void;
  timeout: ReturnType<typeof setTimeout>;
}

// Track connected clients and their agent connections
interface ClientState {
  process: ChildProcess | null;
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
  isAlive: boolean;
}

// Permission request timeout (5 minutes)
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;

// Heartbeat interval for WebSocket ping/pong (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30_000;

// Generate unique permission request ID
let _permId = 0;
function generatePermRequestId(): string {
  _permId += 1;
  return `perm_${Date.now()}_${_permId}`;
}

function cancelPendingPermissions(clientState: ClientState): void {
  for (const [, pending] of clientState.pendingPermissions) {
    clearTimeout(pending.timeout);
    pending.resolve({ outcome: "cancelled" });
  }
  clientState.pendingPermissions.clear();
}

// ---------------------------------------------------------------------------
// Registry helpers: build register message for RCS client mode
// ---------------------------------------------------------------------------

export function buildRegisterMessage(config: ServerConfig): object {
  let ip = "127.0.0.1";
  let mac = "";
  try {
    const interfaces = os.networkInterfaces();
    for (const entries of Object.values(interfaces)) {
      if (!entries) continue;
      for (const info of entries) {
        if (!info.internal && info.family === "IPv4") {
          ip = info.address;
          if (info.mac) mac = info.mac;
          break;
        }
      }
      if (mac) break;
    }
  } catch {
    // fallback to 127.0.0.1
  }

  return {
    type: "register",
    agent_name: config.command,
    max_sessions: 5,
    capabilities: { streaming: true },
    machine_info: {
      hostname: os.hostname(),
      ip,
      mac,
      os: os.platform(),
      arch: os.arch(),
    },
    labels: config.labels ?? [],
    heartbeat_interval_ms: 30000,
    tenant_id: config.tenantId ?? null,
    user_id: config.userId ?? null,
  };
}

// ---------------------------------------------------------------------------
// Client mode: connects to RCS registry as WebSocket client
// ---------------------------------------------------------------------------

export function createAcpClient(config: ServerConfig): { close: () => void } {
  if (!config.rcsUrl) {
    throw new Error("rcsUrl is required for client mode");
  }

  const sessionMgr = new SessionManager(config.command, 5, config.cwd || process.cwd());
  const instanceMgr = new InstanceManager(config.command, config.cwd || process.cwd());
  const url = `${config.rcsUrl}/acp/ws?secret=${encodeURIComponent(config.rcsSecret ?? "")}`;
  let ws: WebSocket | null = null;
  let fileWs: WebSocket | null = null;
  let fileWsHeartbeat: ReturnType<typeof setInterval> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_MS = 30_000;
  let manualClose = false;

  function setupSessionCallbacks(): void {
    sessionMgr.on("session_data", (sessionId: string, payload: unknown) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "session_data", session_id: sessionId, payload }));
      }
    });
    sessionMgr.on("session_ended", (sessionId: string, exitCode: number) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "session_ended", session_id: sessionId, reason: `exit code ${exitCode}` }));
      }
    });
    sessionMgr.on("session_error", (sessionId: string, error: string) => {
      if (ws && ws.readyState === 1) {
        ws.send(JSON.stringify({ type: "session_error", session_id: sessionId, error }));
      }
    });
  }

  setupSessionCallbacks();

  function connect(): void {
    if (manualClose) return;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempt = 0;
      ws!.send(JSON.stringify(buildRegisterMessage(config)));

      // 重连后：为所有存活的子进程发送 session_resumed
      for (const sessionId of sessionMgr.getAliveSessionIds()) {
        ws!.send(JSON.stringify({ type: "session_resumed", session_id: sessionId }));
      }
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        // ── ACP 调试日志 ──
        if (msg.type !== "heartbeat" && msg.type !== "keep_alive") {
          console.log("[acp-client] ← RCS:", JSON.stringify(msg).slice(0, 500));
        }
        switch (msg.type) {
          case "registered": {
            console.log("[acp-client] registered successfully, machineId:", msg.machine_id);
            heartbeatTimer = setInterval(() => {
              if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "heartbeat" }));
              }
            }, 30000);

            // Establish file-ws connection
            const fileWsUrl = `${config.rcsUrl}/acp/file-ws?secret=${encodeURIComponent(config.rcsSecret ?? "")}`;
            const connectFileWs = () => {
              if (manualClose) return;
              fileWs = new WebSocket(fileWsUrl);
              fileWs.onopen = () => {
                console.log("[acp-client] file-ws connected, registering...");
                if (fileWs && fileWs.readyState === 1) {
                  fileWs.send(JSON.stringify({ type: "register", machine_id: msg.machine_id }));
                }
                fileWsHeartbeat = setInterval(() => {
                  if (fileWs && fileWs.readyState === 1) {
                    fileWs.send(JSON.stringify({ type: "keep_alive" }));
                  }
                }, 30000);
              };
              fileWs.onmessage = async (event) => {
                try {
                  const fmsg = JSON.parse(event.data as string);
                  if (fmsg.type === "file_op") {
                    const result = await handleFileOp(fmsg);
                    if (fileWs && fileWs.readyState === 1) {
                      fileWs.send(JSON.stringify(result));
                    }
                  }
                } catch {
                  // ignore
                }
              };
              fileWs.onclose = () => {
                if (fileWsHeartbeat) {
                  clearInterval(fileWsHeartbeat);
                  fileWsHeartbeat = null;
                }
                if (!manualClose) {
                  setTimeout(connectFileWs, 5000);
                }
              };
              fileWs.onerror = () => {
                // onclose will handle
              };
            };
            connectFileWs();
            break;
          }
          case "session_start": {
            const sessionId = msg.session_id as string;
            const launchSpec = msg.launch_spec;

            if (launchSpec) {
              console.log(`[acp-client] session_start with launch_spec for ${sessionId}`);
              if (msg.agent_prompt) {
                sessionMgr.setSystemPrompt?.(msg.agent_prompt as string);
              }
              sessionMgr.startSession(sessionId, launchSpec as Record<string, unknown>).then((result) => {
                console.log("[acp-client] startSession done:", result, "ws:", ws?.readyState);
                if (ws && ws.readyState === 1) {
                  if (result === "started") {
                    const caps = sessionMgr.getCapabilities?.() ?? {};
                    ws.send(
                      JSON.stringify({
                        type: "session_started",
                        session_id: sessionId,
                        payload: { capabilities: caps },
                      }),
                    );
                  } else if (result === "queued") {
                    ws.send(JSON.stringify({ type: "session_queued", session_id: sessionId }));
                  } else {
                    ws.send(JSON.stringify({ type: "session_error", session_id: sessionId, error: "spawn failed" }));
                  }
                } else {
                  console.log("[acp-client] ws not ready, state:", ws?.readyState);
                }
              });
            } else {
              console.log("[acp-client] session_start (legacy) for", sessionId);
              if (msg.agent_prompt) {
                sessionMgr.setSystemPrompt?.(msg.agent_prompt as string);
              }
              sessionMgr.startSession(sessionId).then((result) => {
                console.log("[acp-client] startSession done:", result, "ws:", ws?.readyState);
                if (ws && ws.readyState === 1) {
                  if (result === "started") {
                    const caps = sessionMgr.getCapabilities?.() ?? {};
                    ws.send(
                      JSON.stringify({
                        type: "session_started",
                        session_id: sessionId,
                        payload: { capabilities: caps },
                      }),
                    );
                  } else if (result === "queued") {
                    ws.send(JSON.stringify({ type: "session_queued", session_id: sessionId }));
                  } else {
                    ws.send(JSON.stringify({ type: "session_error", session_id: sessionId, error: "spawn failed" }));
                  }
                } else {
                  console.log("[acp-client] ws not ready, state:", ws?.readyState);
                }
              });
            }
            break;
          }
          case "session_data":
            // 优先走 InstanceManager AcpDispatcher，否则走旧 SessionManager
            if (instanceMgr.hasInstance(msg.session_id)) {
              const dispatcher = instanceMgr.getDispatcher(msg.session_id);
              if (dispatcher) {
                await dispatcher.handleMessage(msg.payload);
              }
            } else {
              sessionMgr.sendData(msg.session_id, msg.payload);
            }
            break;
          case "session_end":
            if (instanceMgr.hasInstance(msg.session_id)) {
              instanceMgr.stop(msg.session_id);
            } else {
              sessionMgr.endSession(msg.session_id);
            }
            break;
          case "prepare": {
            const instId = msg.instance_id as string;
            const launchSpec = msg.launch_spec as AgentLaunchSpec;
            try {
              await instanceMgr.prepare(instId, launchSpec);
              ws!.send(
                JSON.stringify({
                  type: "prepare_result",
                  request_id: msg.request_id,
                  instance_id: instId,
                  status: "ok",
                }),
              );
            } catch (err) {
              ws!.send(
                JSON.stringify({
                  type: "prepare_result",
                  request_id: msg.request_id,
                  instance_id: instId,
                  status: "error",
                  message: (err as Error).message,
                }),
              );
            }
            break;
          }
          case "start": {
            const instId = msg.instance_id as string;
            try {
              // send 回调：dispatcher 的 ACP 回复通过 relay 消息发回 RCS
              // payload 直接传入消息对象（JSON-RPC 或传输层消息）
              const relaySend = (msgObj: unknown) => {
                if (ws && ws.readyState === 1) {
                  const relayMsg = {
                    type: "relay",
                    instance_id: instId,
                    session_id: instId,
                    payload: msgObj,
                  };
                  // ── ACP 调试日志 ──
                  console.log("[acp-client] → RCS relay:", JSON.stringify(relayMsg).slice(0, 500));
                  ws.send(JSON.stringify(relayMsg));
                }
              };
              const result = await instanceMgr.start(instId, relaySend);
              ws!.send(
                JSON.stringify({
                  type: "start_result",
                  request_id: msg.request_id,
                  instance_id: instId,
                  status: "ok",
                  capabilities: result.capabilities,
                }),
              );
            } catch (err) {
              ws!.send(
                JSON.stringify({
                  type: "start_result",
                  request_id: msg.request_id,
                  instance_id: instId,
                  status: "error",
                  message: (err as Error).message,
                }),
              );
            }
            break;
          }
          case "stop": {
            const instId = msg.instance_id as string;
            try {
              await instanceMgr.stop(instId);
              ws!.send(
                JSON.stringify({
                  type: "stop_result",
                  request_id: msg.request_id,
                  instance_id: instId,
                  status: "ok",
                }),
              );
            } catch (err) {
              ws!.send(
                JSON.stringify({
                  type: "stop_result",
                  request_id: msg.request_id,
                  instance_id: instId,
                  status: "error",
                  message: (err as Error).message,
                }),
              );
            }
            break;
          }
          case "relay": {
            const instId = msg.instance_id as string;
            const sessId = msg.session_id as string;
            const relayPayload = msg.payload;
            // ── ACP 调试日志 ──
            console.log("[acp-client] relay → dispatcher:", JSON.stringify(relayPayload).slice(0, 500));
            if (instanceMgr.hasInstance(instId)) {
              const dispatcher = instanceMgr.getDispatcher(instId);
              if (dispatcher) {
                try {
                  await dispatcher.handleMessage(relayPayload);
                } catch (err) {
                  ws!.send(
                    JSON.stringify({
                      type: "relay",
                      instance_id: instId,
                      session_id: sessId,
                      payload: createErrorResponse(null, -32603, (err as Error).message),
                    }),
                  );
                }
              }
            } else {
              sessionMgr.sendData(sessId, relayPayload);
            }
            break;
          }
          case "relay_close":
            break;
          default:
            console.log(`[acp-client] received: ${msg.type}`);
        }
      } catch {
        // ignore parse errors
      }
    };

    ws.onclose = (event) => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (manualClose) return;

      // 提供有意义的断连原因提示
      if (event.code === 4003) {
        console.error(
          `[acp-client] 认证失败: ${event.reason || "secret 不匹配"}，请检查 RCS_SECRET 与服务端 REGISTRY_SECRET 是否一致`,
        );
        manualClose = true;
        return;
      }

      // 指数退避重连（不断连不杀子进程）
      const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
      reconnectAttempt++;
      console.log(`[acp-client] disconnected, reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
      setTimeout(connect, delay);
    };

    ws.onerror = () => {
      // ws.onclose 会触发
    };
  }

  connect();

  return {
    close: () => {
      manualClose = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (fileWsHeartbeat) clearInterval(fileWsHeartbeat);
      fileWs?.close();
      sessionMgr.stopAll();
      ws?.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Factory: creates a per-instance ACP WS server (auto-detects Bun / Node.js)
// ---------------------------------------------------------------------------

export function createAcpServer(config: ServerConfig): AcpServerHandle {
  const { port, host, command, args, cwd } = config;
  const extraEnv = config.env ?? {};

  // Per-instance state — no module-level globals
  const clients = new Map<AcpWs, ClientState>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // --- Helpers (closures over local `clients`) ---

  function sendMsg(ws: AcpWs, message: unknown): void {
    if (ws.readyState === WS_OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  function createClient(ws: AcpWs, clientState: ClientState): acp.Client {
    return {
      async requestPermission(params) {
        const permId = generatePermRequestId();

        const outcomePromise = new Promise<{ outcome: "cancelled" } | { outcome: "selected"; optionId: string }>(
          (resolve) => {
            const timeout = setTimeout(() => {
              console.warn("permission request timed out:", permId);
              clientState.pendingPermissions.delete(permId);
              resolve({ outcome: "cancelled" });
            }, PERMISSION_TIMEOUT_MS);

            clientState.pendingPermissions.set(permId, { jsonRpcId: permId, resolve, timeout });
          },
        );

        // 发送 JSON-RPC 请求给客户端
        sendMsg(ws, {
          jsonrpc: "2.0",
          id: permId,
          method: ACP_METHOD.REQUEST_PERMISSION,
          params: {
            requestId: permId,
            sessionId: params.sessionId,
            options: params.options,
            toolCall: params.toolCall,
          },
        });

        const outcome = await outcomePromise;
        return { outcome };
      },

      async sessionUpdate(params) {
        sendMsg(ws, createNotification(ACP_METHOD.SESSION_UPDATE, params));
      },

      async readTextFile(_params) {
        return { content: "" };
      },

      async writeTextFile(_params) {
        return {};
      },
    };
  }

  function handlePermissionResponse(ws: AcpWs, id: number | string, payload: Record<string, unknown>): void {
    const state = clients.get(ws);
    if (!state) {
      console.warn("permission response from unknown client");
      return;
    }

    // payload 是 {requestId, outcome} 或直接 outcome
    const requestId = (payload.requestId ?? id) as string;
    const pending = state.pendingPermissions.get(requestId);
    if (!pending) {
      console.warn("permission response for unknown request:", requestId);
      return;
    }

    clearTimeout(pending.timeout);
    state.pendingPermissions.delete(requestId);

    const outcome = payload.outcome as Record<string, unknown>;
    if (outcome?.outcome === "cancelled") {
      pending.resolve({ outcome: "cancelled" });
    } else if (outcome?.outcome === "selected" && typeof outcome.optionId === "string") {
      pending.resolve({ outcome: "selected", optionId: outcome.optionId });
    } else {
      pending.resolve({ outcome: "cancelled" });
    }
  }

  // --- Agent lifecycle handlers ---

  async function handleConnect(ws: AcpWs): Promise<void> {
    const state = clients.get(ws);
    if (!state) return;

    // If already connected to a running agent, just resend status
    if (state.connection && state.process && !state.process.killed && state.process.exitCode === null) {
      console.log("agent already connected, resending status");
      sendMsg(ws, {
        type: "status",
        payload: { connected: true, agentInfo: { name: command }, capabilities: state.agentCapabilities },
      });
      return;
    }

    // Kill existing process if any (only if not healthy)
    if (state.process) {
      cancelPendingPermissions(state);
      state.process.kill();
      state.process = null;
      state.connection = null;
    }

    try {
      console.log("spawning agent:", command, args);

      const agentProcess = spawn(command, args, {
        cwd,
        stdio: ["pipe", "pipe", "inherit"],
        env: { ...process.env, ...extraEnv },
      });

      state.process = agentProcess;

      agentProcess.on("exit", (code) => {
        console.log("agent process exited:", code);
        if (state.process === agentProcess) {
          state.process = null;
          state.connection = null;
          state.sessionId = null;
        }
      });

      const input = Writable.toWeb(agentProcess.stdin!) as unknown as WritableStream<Uint8Array>;
      const output = Readable.toWeb(agentProcess.stdout!) as unknown as ReadableStream<Uint8Array>;

      const stream = acp.ndJsonStream(input, output);
      const connection = new acp.ClientSideConnection((_agent) => createClient(ws, state), stream);

      state.connection = connection;

      const initResult = await connection.initialize({
        protocolVersion: acp.PROTOCOL_VERSION,
        clientInfo: { name: "zed", version: "1.0.0" },
        clientCapabilities: {
          fs: { readTextFile: true, writeTextFile: true },
        },
      });

      const agentCaps = initResult.agentCapabilities;
      state.agentCapabilities = agentCaps
        ? {
            _meta: agentCaps._meta,
            loadSession: agentCaps.loadSession,
            mcpCapabilities: agentCaps.mcpCapabilities,
            promptCapabilities: agentCaps.promptCapabilities,
            sessionCapabilities: agentCaps.sessionCapabilities,
          }
        : null;
      state.promptCapabilities = agentCaps?.promptCapabilities ?? null;

      console.log(
        "agent initialized:",
        `protocolVersion=${initResult.protocolVersion}`,
        `loadSession=${!!state.agentCapabilities?.loadSession}`,
        `sessionList=${!!state.agentCapabilities?.sessionCapabilities?.list}`,
        `sessionResume=${!!state.agentCapabilities?.sessionCapabilities?.resume}`,
        `hasMcp=${!!state.agentCapabilities?.mcpCapabilities}`,
      );

      sendMsg(ws, {
        type: "status",
        payload: { connected: true, agentInfo: initResult.agentInfo, capabilities: state.agentCapabilities },
      });

      connection.closed.then(() => {
        console.log("agent connection closed");
        state.connection = null;
        state.sessionId = null;
        sendMsg(ws, { type: "status", payload: { connected: false } });
      });
    } catch (error) {
      console.error("agent connect failed:", (error as Error).message);
      sendMsg(ws, { type: "error", payload: { message: `Failed to connect: ${(error as Error).message}` } });
    }
  }

  async function handleNewSession(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection) {
      console.warn("handleNewSession: not connected to agent");
      sendMsg(ws, createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }

    try {
      const sessionCwd = (params.cwd as string) || cwd;
      const result = await state.connection.newSession({
        cwd: sessionCwd,
        mcpServers: [],
      });

      state.sessionId = result.sessionId;
      state.modelState = result.models ?? null;
      state.modeState = result.modes ?? null;
      console.log("session created:", result.sessionId, "cwd:", sessionCwd);

      sendMsg(
        ws,
        createSuccessResponse(id, {
          sessionId: result.sessionId,
          promptCapabilities: state.promptCapabilities,
          models: state.modelState,
          modes: state.modeState,
        }),
      );
    } catch (error) {
      console.error("session create failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to create session: ${(error as Error).message}`));
    }
  }

  async function handleListSessions(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection) {
      console.warn("handleListSessions: not connected to agent");
      sendMsg(ws, createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }

    if (!state.agentCapabilities?.sessionCapabilities?.list) {
      sendMsg(ws, createErrorResponse(id, -32000, "Listing sessions is not supported by this agent"));
      return;
    }

    try {
      const result = await state.connection.listSessions({
        cwd: params.cwd as string | undefined,
        cursor: params.cursor as string | undefined,
      });

      const MAX_SESSIONS = 20;
      const sessions = result.sessions.slice(0, MAX_SESSIONS);
      console.log("sessions listed:", `total=${result.sessions.length}`, `returned=${sessions.length}`);

      sendMsg(
        ws,
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
      console.error("session list failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to list sessions: ${(error as Error).message}`));
    }
  }

  async function handleLoadSession(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection) {
      console.warn("handleLoadSession: not connected to agent");
      sendMsg(ws, createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }

    if (!state.agentCapabilities?.loadSession) {
      sendMsg(ws, createErrorResponse(id, -32000, "Loading sessions is not supported by this agent"));
      return;
    }

    try {
      const sessionCwd = (params.cwd as string) || cwd;
      const sessionId = params.sessionId as string;
      const result = await state.connection.loadSession({
        sessionId,
        cwd: sessionCwd,
        mcpServers: [],
      });

      state.sessionId = sessionId;
      state.modelState = result.models ?? null;
      state.modeState = result.modes ?? null;
      console.log("session loaded:", sessionId, "cwd:", sessionCwd);

      sendMsg(
        ws,
        createSuccessResponse(id, {
          sessionId,
          promptCapabilities: state.promptCapabilities,
          models: state.modelState,
          modes: state.modeState,
        }),
      );
    } catch (error) {
      console.error("session load failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to load session: ${(error as Error).message}`));
    }
  }

  async function handleResumeSession(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection) {
      console.warn("handleResumeSession: not connected to agent");
      sendMsg(ws, createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }

    if (!state.agentCapabilities?.sessionCapabilities?.resume) {
      sendMsg(ws, createErrorResponse(id, -32000, "Resuming sessions is not supported by this agent"));
      return;
    }

    try {
      const sessionCwd = (params.cwd as string) || cwd;
      const sessionId = params.sessionId as string;
      // @ts-expect-error SDK type mismatch: unstable_resumeSession exists on Agent interface but not resolved
      const result = await state.connection.unstable_resumeSession({
        sessionId,
        cwd: sessionCwd,
      });

      state.sessionId = sessionId;
      state.modelState = result.models ?? null;
      state.modeState = result.modes ?? null;
      console.log("session resumed:", sessionId, "cwd:", sessionCwd);

      sendMsg(
        ws,
        createSuccessResponse(id, {
          sessionId,
          promptCapabilities: state.promptCapabilities,
          models: state.modelState,
          modes: state.modeState,
        }),
      );
    } catch (error) {
      console.error("session resume failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to resume session: ${(error as Error).message}`));
    }
  }

  async function handlePrompt(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection || !state.sessionId) {
      sendMsg(ws, createErrorResponse(id, -32000, "No active session"));
      return;
    }

    try {
      const content = params.content as ContentBlock[];
      const result = await state.connection.prompt({
        sessionId: state.sessionId,
        prompt: content as acp.ContentBlock[],
      });

      console.log("prompt completed, stopReason:", result.stopReason);
      sendMsg(ws, createSuccessResponse(id, result));
    } catch (error) {
      console.error("prompt failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Prompt failed: ${(error as Error).message}`));
    }
  }

  function handleDisconnect(ws: AcpWs): void {
    const state = clients.get(ws);
    if (!state) return;

    if (state.process) {
      state.process.kill();
      state.process = null;
    }
    state.connection = null;
    state.sessionId = null;

    sendMsg(ws, { type: "status", payload: { connected: false } });
  }

  async function handleCancel(ws: AcpWs, id: number | string): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection || !state.sessionId) {
      console.warn("cancel requested but no active session");
      sendMsg(ws, createSuccessResponse(id, { cancelled: false }));
      return;
    }

    console.log("cancel requested, sessionId:", state.sessionId);
    cancelPendingPermissions(state);

    try {
      await state.connection.cancel({ sessionId: state.sessionId });
      console.log("cancel sent, sessionId:", state.sessionId);
      sendMsg(ws, createSuccessResponse(id, { cancelled: true }));
    } catch (error) {
      console.error("cancel failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Cancel failed: ${(error as Error).message}`));
    }
  }

  async function handleSetSessionModel(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection || !state.sessionId) {
      sendMsg(ws, createErrorResponse(id, -32000, "No active session"));
      return;
    }

    if (!state.modelState) {
      sendMsg(ws, createErrorResponse(id, -32000, "Model selection not supported by this agent"));
      return;
    }

    try {
      const modelId = params.modelId as string;
      console.log("setting model, sessionId:", state.sessionId, "modelId:", modelId);
      await state.connection.unstable_setSessionModel({
        sessionId: state.sessionId,
        modelId,
      });
      state.modelState = { ...state.modelState, currentModelId: modelId };
      sendMsg(ws, createSuccessResponse(id, { modelId }));
      console.log("model changed:", modelId);
    } catch (error) {
      console.error("set model failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to set model: ${(error as Error).message}`));
    }
  }

  async function handleSetSessionMode(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection || !state.sessionId) {
      sendMsg(ws, createErrorResponse(id, -32000, "No active session"));
      return;
    }

    if (!state.modeState) {
      sendMsg(ws, createErrorResponse(id, -32000, "Mode selection not supported by this agent"));
      return;
    }

    try {
      const modeId = params.modeId as string;
      await state.connection.setSessionMode({
        sessionId: state.sessionId,
        modeId,
      });
      state.modeState = { ...state.modeState, currentModeId: modeId };
      sendMsg(ws, createSuccessResponse(id, { modeId }));
      console.log("mode changed:", modeId);
    } catch (error) {
      console.error("set mode failed:", (error as Error).message);
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to set mode: ${(error as Error).message}`));
    }
  }

  async function dispatchIncomingMessage(ws: AcpWs, raw: unknown): Promise<void> {
    const msg = decodeJsonWsMessage(raw) as Record<string, unknown>;

    // 传输层消息
    if (isTransportMessage(msg)) {
      switch (msg.type) {
        case "connect":
          await handleConnect(ws);
          break;
        case "disconnect":
          handleDisconnect(ws);
          break;
        case "ping":
          sendMsg(ws, { type: "pong" });
          break;
      }
      return;
    }

    // JSON-RPC 请求
    if (isJsonRpcMessage(msg) && isJsonRpcRequest(msg)) {
      const rpc = msg as unknown as JsonRpcRequest;
      const { id, method, params } = rpc;
      const p = (params ?? {}) as Record<string, unknown>;

      switch (method) {
        case ACP_METHOD.SESSION_NEW:
          await handleNewSession(ws, id, p);
          break;
        case ACP_METHOD.SESSION_PROMPT:
          await handlePrompt(ws, id, p);
          break;
        case ACP_METHOD.SESSION_CANCEL:
          await handleCancel(ws, id);
          break;
        case ACP_METHOD.SESSION_SET_MODEL:
          await handleSetSessionModel(ws, id, p);
          break;
        case ACP_METHOD.SESSION_SET_MODE:
          await handleSetSessionMode(ws, id, p);
          break;
        case ACP_METHOD.SESSION_LIST:
          await handleListSessions(ws, id, p);
          break;
        case ACP_METHOD.SESSION_LOAD:
          await handleLoadSession(ws, id, p);
          break;
        case ACP_METHOD.SESSION_RESUME:
          await handleResumeSession(ws, id, p);
          break;
        default:
          sendMsg(ws, createErrorResponse(id, -32601, `Method not found: ${method}`));
      }
      return;
    }

    // JSON-RPC 响应（permission_response 等）
    if (isJsonRpcMessage(msg) && "result" in msg) {
      const rpcResp = msg as { id: number | string; result: unknown };
      const result = rpcResp.result as Record<string, unknown>;
      handlePermissionResponse(ws, rpcResp.id, result);
      return;
    }

    console.warn("[acp-server] Unknown message format:", msg);
  }

  // --- Runtime-adaptive WS server ---

  const adapter = getAdapter();
  const server = adapter(port, host, {
    open(ws: AcpWs) {
      console.log("client connected");
      const state: ClientState = {
        process: null,
        connection: null,
        sessionId: null,
        pendingPermissions: new Map(),
        agentCapabilities: null,
        promptCapabilities: null,
        modelState: null,
        modeState: null,
        isAlive: true,
      };
      clients.set(ws, state);
    },
    async message(ws: AcpWs, raw: unknown) {
      try {
        await dispatchIncomingMessage(ws, raw);
      } catch (error) {
        if (error instanceof WsPayloadTooLargeError) {
          console.warn("message too large:", error.message);
          ws.close(1009, "message too large");
          return;
        }
        console.error("message error:", (error as Error).message);
        sendMsg(ws, { type: "error", payload: { message: `Error: ${(error as Error).message}` } });
      }
    },
    close(ws: AcpWs) {
      console.log("client disconnected");
      const state = clients.get(ws);
      if (state) {
        cancelPendingPermissions(state);
      }
      handleDisconnect(ws);
      clients.delete(ws);
    },
    pong(ws: AcpWs) {
      const state = clients.get(ws);
      if (state) {
        state.isAlive = true;
      }
    },
  });

  // Heartbeat: periodically ping all connected clients
  heartbeatTimer = setInterval(() => {
    for (const [ws, state] of clients) {
      if (ws.readyState === WS_CLOSED || ws.readyState === WS_CLOSING) {
        clients.delete(ws);
        continue;
      }
      if (!state.isAlive) {
        console.log("heartbeat timeout, closing");
        ws.close();
        continue;
      }
      state.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);

  const displayUrl = `ws://${host === "0.0.0.0" ? "localhost" : host}:${server.port}/ws`;
  console.log(`[acp-server] started on ${displayUrl}, agent: ${command} ${args.join(" ")}`);

  return {
    close() {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      for (const [, cs] of clients) {
        cancelPendingPermissions(cs);
        if (cs.process) cs.process.kill();
      }
      clients.clear();
      server.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

export async function startServer(config: ServerConfig): Promise<void> {
  if (config.rcsUrl) {
    console.log();
    console.log("  \u{1F680} ACP Client Mode (Registry)");
    console.log();
    console.log(`  RCS URL:   ${config.rcsUrl}`);
    console.log(`  Agent:     ${config.command} ${config.args.join(" ")}`);
    console.log(`  Labels:    ${config.labels?.join(",") ?? "(none)"}`);
    console.log();
    console.log("  Press Ctrl+C to stop");
    console.log();
    const handle = createAcpClient(config);
    const shutdown = () => {
      handle.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await new Promise<void>(() => {});
    return;
  }

  const handle = createAcpServer(config);

  const displayUrl = `ws://${config.host === "0.0.0.0" ? "localhost" : config.host}:${config.port}/ws`;

  const agentDisplay = config.args.length > 0 ? `${config.command} ${config.args.join(" ")}` : config.command;

  console.log();
  console.log(`  🚀 ACP Proxy Server`);
  console.log();
  console.log(`  Connection:`);
  console.log(`    URL:   ${displayUrl}`);
  console.log();
  console.log(`  📦 Agent: ${agentDisplay}`);
  console.log(`     CWD:   ${config.cwd}`);
  console.log();
  console.log(`  Press Ctrl+C to stop`);
  console.log();

  const shutdown = () => {
    handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep the process running
  await new Promise<void>(() => {});
}
