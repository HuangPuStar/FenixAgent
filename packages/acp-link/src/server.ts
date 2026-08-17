import { type ChildProcess, spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { createCcbHandler } from "@fenix/ccb";
import { createClaudeCodeHandler } from "@fenix/claude-code";
import { createOpencodeHandler } from "@fenix/opencode";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { handleFileOp } from "./client/file-operations.js";
import { type AgentType, type EngineHandler, InstanceManager } from "./client/instance-manager.js";
import { SessionManager } from "./client/session-manager.js";
import { initRegistry } from "./client/workspace-registry.js";
import { extractModelState, extractModeState } from "./config-options-utils.js";
import { createElicitationHandler, type ElicitationHandler } from "./elicitation.js";
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
import { createReconnectScheduler } from "./reconnect-scheduler.js";
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
  /** Agent 类型：opencode（默认）、ccb、claude-code */
  agentType?: AgentType;
  /** 支持的引擎类型列表，注册时上报给 RCS */
  supportedEngineTypes?: { type: string; cliPath?: string }[];
  /** 用户指定的机器显示名称，可选 */
  name?: string;
  /** 客户端指定的 machine id（可选），用于固定 machine 标识 */
  machineId?: string;
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
  /** AskUserQuestion 提问处理器（interactive_question 帧发出/答案回传/超时/取消） */
  elicitation: ElicitationHandler;
  agentCapabilities: AgentCapabilities | null;
  promptCapabilities: PromptCapabilities | null;
  modelState: SessionModelState | null;
  modeState: {
    availableModes: Array<{
      id: string;
      name: string;
      description?: string | null;
    }>;
    currentModeId: string;
  } | null;
  isAlive: boolean;
  /** 会话标题本地覆盖缓存。agent 可能不支持 session_info_update，因此需本地维护 */
  titleOverrides: Map<string, string | null>;
}

// Heartbeat interval for WebSocket ping/pong (30 seconds)
const HEARTBEAT_INTERVAL_MS = 30_000;

function cancelPendingPermissions(clientState: ClientState): void {
  for (const [, pending] of clientState.pendingPermissions) {
    clearTimeout(pending.timeout);
    pending.resolve({ outcome: "cancelled" });
  }
  clientState.pendingPermissions.clear();
}

// ---------------------------------------------------------------------------
// Node identity persistence: 持久化 machine_id 避免重复注册
// ---------------------------------------------------------------------------

const NODE_ID_FILENAME = ".acp-link-node-id";

/** 从 cwd 加载持久化的 node_id（上次注册时服务器分配的 machine_id） */
async function loadNodeId(cwd: string): Promise<string | null> {
  try {
    const id = (await readFile(join(cwd, NODE_ID_FILENAME), "utf-8")).trim();
    return id || null;
  } catch {
    return null;
  }
}

/** 将 node_id 持久化到 cwd，后续重连时携带以精确匹配已有 machine 记录 */
async function saveNodeId(cwd: string, machineId: string): Promise<void> {
  try {
    await writeFile(join(cwd, NODE_ID_FILENAME), machineId, "utf-8");
  } catch (err) {
    console.error("[acp-client] Failed to persist node_id:", err);
  }
}

// ---------------------------------------------------------------------------
// Registry helpers: build register message for RCS client mode
// ---------------------------------------------------------------------------

export function buildRegisterMessage(config: ServerConfig, nodeId?: string | null): object {
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

  const msg: Record<string, unknown> = {
    type: "register",
    agent_name: config.command,
    name: config.name ?? null,
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
    supported_engine_types: config.supportedEngineTypes ?? [
      { type: "opencode" },
      ...(process.env.CLAUDE_CODE_CLI_PATH ? [{ type: "claude-code", cliPath: process.env.CLAUDE_CODE_CLI_PATH }] : []),
    ],
    tenant_id: config.tenantId ?? null,
    user_id: config.userId ?? null,
  };

  // 携带持久化的 node_id，服务端据此精确匹配已有记录，避免重复注册
  if (nodeId) {
    msg.node_id = nodeId;
  }

  // 客户端指定的 machine id，用于固定机器标识
  if (config.machineId) {
    msg.machine_id = config.machineId;
  }

  return msg;
}

// ---------------------------------------------------------------------------
// Client mode: connects to RCS registry as WebSocket client
// ---------------------------------------------------------------------------

export function createAcpClient(config: ServerConfig): { close: () => void } {
  if (!config.rcsUrl) {
    throw new Error("rcsUrl is required for client mode");
  }

  const cwd = config.cwd || process.cwd();
  const sessionMgr = new SessionManager(config.command, 5, config.cwd || process.cwd());
  const handlers: Record<string, EngineHandler> = {
    opencode: createOpencodeHandler(config.command, config.args),
    ccb: createCcbHandler(),
    "claude-code": createClaudeCodeHandler(),
  };
  const instanceMgr = new InstanceManager(handlers, config.cwd || process.cwd(), config.agentType ?? "opencode");

  // 从磁盘加载 workspace 映射（acp-link 重启后恢复）
  initRegistry(cwd).catch((err) => {
    console.error("[acp-client] Failed to load workspace registry:", err);
  });
  const url = `${config.rcsUrl}/acp/ws?secret=${encodeURIComponent(config.rcsSecret ?? "")}`;
  let ws: WebSocket | null = null;
  let fileWs: WebSocket | null = null;
  let fileWsHeartbeat: ReturnType<typeof setInterval> | null = null;
  let fileWsReconnectAttempt = 0;
  let fileWsReconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttempt = 0;
  const MAX_RECONNECT_MS = 30_000;
  const MAX_FILE_WS_RECONNECT_MS = 30_000;
  let manualClose = false;
  // 持久化的 node_id，首次注册后由服务器分配，后续重连携带以精确匹配
  let cachedNodeId: string | null = null;
  // 实例 start 完成前到达的 connect 帧缓存（instId → payload）。
  // relay 的 connect 帧只在实例 dispatcher 就绪后才会被消费；若在前端建连
  // （spawn + connection.initialize 耗时秒级）期间到达，会被静默丢弃，
  // 导致 status（含 capabilities）永不发送、前端能力信息缺失（"not supported"）。
  // start 成功后补发缓存帧，保证能力信息最终到达前端。
  const pendingConnects = new Map<string, unknown>();

  function setupSessionCallbacks(): void {
    sessionMgr.on("session_data", (sessionId: string, payload: unknown) => {
      if (ws && ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "session_data",
            session_id: sessionId,
            payload,
          }),
        );
      }
    });
    sessionMgr.on("session_ended", (sessionId: string, exitCode: number) => {
      if (ws && ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "session_ended",
            session_id: sessionId,
            reason: `exit code ${exitCode}`,
          }),
        );
      }
    });
    sessionMgr.on("session_error", (sessionId: string, error: string) => {
      if (ws && ws.readyState === 1) {
        ws.send(
          JSON.stringify({
            type: "session_error",
            session_id: sessionId,
            error,
          }),
        );
      }
    });
  }

  setupSessionCallbacks();

  function connect(): void {
    if (manualClose) return;
    ws = new WebSocket(url);

    ws.onopen = () => {
      reconnectAttempt = 0;
      ws!.send(JSON.stringify(buildRegisterMessage(config, cachedNodeId)));

      // 重连后：为所有存活的子进程发送 session_resumed
      for (const sessionId of sessionMgr.getAliveSessionIds()) {
        ws!.send(
          JSON.stringify({
            type: "session_resumed",
            session_id: sessionId,
          }),
        );
      }
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data as string);
        switch (msg.type) {
          case "registered": {
            console.log("[acp-client] registered successfully, machineId:", msg.machine_id);
            // 持久化服务器分配的 machine_id 作为 node_id，后续重连精确匹配
            if (msg.machine_id && msg.machine_id !== cachedNodeId) {
              cachedNodeId = msg.machine_id;
              saveNodeId(cwd, msg.machine_id).catch(() => {});
            }
            heartbeatTimer = setInterval(() => {
              if (ws && ws.readyState === 1) {
                ws.send(JSON.stringify({ type: "heartbeat" }));
              }
            }, 30000);

            // Reset file-ws reconnect state on fresh registration
            if (fileWsReconnectTimer) {
              clearTimeout(fileWsReconnectTimer);
              fileWsReconnectTimer = null;
            }
            fileWsReconnectAttempt = 0;

            // Establish file-ws connection
            // Close existing file-ws before creating a new one (prevents leak on re-register)
            if (fileWs) {
              // Detach onclose to prevent stale handler from scheduling reconnect
              fileWs.onclose = null;
              fileWs.onerror = null;
              try {
                fileWs.close();
              } catch {
                /* ignore */
              }
              fileWs = null;
            }
            if (fileWsHeartbeat) {
              clearInterval(fileWsHeartbeat);
              fileWsHeartbeat = null;
            }
            const fileWsUrl = `${config.rcsUrl}/acp/file-ws?secret=${encodeURIComponent(config.rcsSecret ?? "")}`;
            const connectFileWs = () => {
              fileWsReconnectTimer = null;
              if (manualClose) return;
              try {
                fileWs = new WebSocket(fileWsUrl);
              } catch (err) {
                console.error("[acp-client] Failed to create file-ws:", err);
                return;
              }
              fileWs.onopen = () => {
                console.log("[acp-client] file-ws connected, registering...");
                if (fileWs && fileWs.readyState === 1) {
                  fileWs.send(
                    JSON.stringify({
                      type: "register",
                      machine_id: msg.machine_id,
                    }),
                  );
                }
                fileWsHeartbeat = setInterval(() => {
                  if (fileWs && fileWs.readyState === 1) {
                    fileWs.send(
                      JSON.stringify({
                        type: "keep_alive",
                      }),
                    );
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
                fileWs = null;
                if (!manualClose) {
                  fileWsReconnectAttempt++;
                  const rawDelay = Math.min(1000 * 2 ** (fileWsReconnectAttempt - 1), MAX_FILE_WS_RECONNECT_MS);
                  // Full jitter: randomize between 50%–100% of raw delay
                  const delay = Math.round(rawDelay * (0.5 + Math.random() * 0.5));
                  console.log(
                    `[acp-client] file-ws disconnected, reconnecting in ${delay}ms (attempt ${fileWsReconnectAttempt})`,
                  );
                  fileWsReconnectTimer = setTimeout(connectFileWs, delay);
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

            // 旧 SessionManager 路径（向后兼容）
            if (launchSpec) {
              console.log(`[acp-client] session_start with launch_spec for ${sessionId}`);
              if (msg.agent_prompt) {
                sessionMgr.setSystemPrompt?.(msg.agent_prompt as string);
              }
              sessionMgr.startSession(sessionId, launchSpec as Record<string, unknown>).then((result) => {
                if (ws && ws.readyState === 1) {
                  if (result === "started") {
                    const caps = sessionMgr.getCapabilities?.() ?? {};
                    ws.send(
                      JSON.stringify({
                        type: "session_started",
                        session_id: sessionId,
                        payload: {
                          capabilities: caps,
                        },
                      }),
                    );
                  } else if (result === "queued") {
                    ws.send(
                      JSON.stringify({
                        type: "session_queued",
                        session_id: sessionId,
                      }),
                    );
                  } else {
                    ws.send(
                      JSON.stringify({
                        type: "session_error",
                        session_id: sessionId,
                        error: "spawn failed",
                      }),
                    );
                  }
                }
              });
            } else {
              console.log("[acp-client] session_start (legacy) for", sessionId);
              if (msg.agent_prompt) {
                sessionMgr.setSystemPrompt?.(msg.agent_prompt as string);
              }
              sessionMgr.startSession(sessionId).then((result) => {
                if (ws && ws.readyState === 1) {
                  if (result === "started") {
                    const caps = sessionMgr.getCapabilities?.() ?? {};
                    ws.send(
                      JSON.stringify({
                        type: "session_started",
                        session_id: sessionId,
                        payload: {
                          capabilities: caps,
                        },
                      }),
                    );
                  } else if (result === "queued") {
                    ws.send(
                      JSON.stringify({
                        type: "session_queued",
                        session_id: sessionId,
                      }),
                    );
                  } else {
                    ws.send(
                      JSON.stringify({
                        type: "session_error",
                        session_id: sessionId,
                        error: "spawn failed",
                      }),
                    );
                  }
                }
              });
            }
            break;
          }
          case "session_data": {
            const instId = (msg.instance_id as string) ?? (msg.session_id as string);
            if (instId && instanceMgr.hasInstance(instId)) {
              const dispatcher = instanceMgr.getDispatcher(instId);
              if (dispatcher) await dispatcher.handleMessage(msg.payload);
            } else {
              sessionMgr.sendData(msg.session_id as string, msg.payload);
            }
            break;
          }
          case "session_end": {
            const instId = (msg.instance_id as string) ?? (msg.session_id as string);
            if (instId && instanceMgr.hasInstance(instId)) {
              instanceMgr.stop(instId);
            } else {
              sessionMgr.endSession(msg.session_id as string);
            }
            break;
          }
          case "prepare": {
            const instId = msg.instance_id as string;
            const launchSpec = msg.launch_spec as AgentLaunchSpec;
            const engineType = msg.engine_type as string | undefined;
            try {
              // InstanceManager 支持多引擎，传入 engine_type 即可切换引擎
              await instanceMgr.prepare(instId, launchSpec, engineType);
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
              // start 统一走 InstanceManager（稳定路径）
              const relaySend = (msgObj: unknown) => {
                if (ws && ws.readyState === 1) {
                  const sessId = instanceMgr.getSessionId(instId) ?? instId;
                  ws.send(
                    JSON.stringify({
                      type: "relay",
                      instance_id: instId,
                      session_id: sessId,
                      payload: msgObj,
                    }),
                  );
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
              // 补发 start 完成前缓存的 connect 帧：dispatcher 此刻已就绪，
              // 重放后回传 status（含 capabilities），避免前端能力信息永久缺失。
              const pendingConnect = pendingConnects.get(instId);
              if (pendingConnect) {
                pendingConnects.delete(instId);
                const dispatcher = instanceMgr.getDispatcher(instId);
                if (dispatcher) {
                  try {
                    await dispatcher.handleMessage(pendingConnect);
                  } catch (err) {
                    ws!.send(
                      JSON.stringify({
                        type: "relay",
                        instance_id: instId,
                        session_id: instanceMgr.getSessionId(instId) ?? instId,
                        payload: createErrorResponse(null, -32603, (err as Error).message),
                      }),
                    );
                  }
                }
              }
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
            // 回写前端 session_id 到实例 state，使 relaySend 回传时使用正确的会话标识
            if (sessId) {
              instanceMgr.setSessionId(instId, sessId);
            }
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
              } else if ((relayPayload as { type?: string })?.type === "connect") {
                // dispatcher 尚未就绪（实例仍在 start：spawn 子进程 + initialize 握手）：
                // connect 帧必须先缓存，start 完成后补发，否则 status 永不发送。
                // 仅缓存 connect（幂等握手），其余消息在 dispatcher 就绪前没有消费者，直接忽略。
                pendingConnects.set(instId, relayPayload);
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

      // 主 WS 断连时一并清理 file-ws 状态，防止 file-ws 作为"僵尸"存活
      if (fileWsReconnectTimer) {
        clearTimeout(fileWsReconnectTimer);
        fileWsReconnectTimer = null;
      }
      if (fileWsHeartbeat) {
        clearInterval(fileWsHeartbeat);
        fileWsHeartbeat = null;
      }
      if (fileWs) {
        fileWs.onclose = null;
        fileWs.onerror = null;
        try {
          fileWs.close();
        } catch {
          /* ignore */
        }
        fileWs = null;
      }
      fileWsReconnectAttempt = 0;

      if (manualClose) return;

      // 提供有意义的断连原因提示
      if (event.code === 4003) {
        reconnectScheduler.cancel();
        console.error(
          `[acp-client] 认证失败: ${event.reason || "secret 不匹配"}，请检查 RCS_SECRET 与服务端 REGISTRY_SECRET 是否一致`,
        );
        manualClose = true;
        return;
      }

      scheduleReconnect("close");
    };

    ws.onerror = () => {
      // Node.js WebSocket 在连接不上服务端时可能只触发 error，不触发 close。
      // 因此 error 也必须进入重连调度，否则服务端重启后 Runtime 会永久离线。
      scheduleReconnect("error");
    };
  }

  const reconnectScheduler = createReconnectScheduler({ connect });

  function scheduleReconnect(reason: "close" | "error"): void {
    if (manualClose) return;
    const delay = Math.min(1000 * 2 ** reconnectAttempt, MAX_RECONNECT_MS);
    const scheduled = reconnectScheduler.schedule(delay);
    if (!scheduled) return;
    reconnectAttempt++;
    console.log(`[acp-client] disconnected (${reason}), reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);
  }

  // 先加载持久化的 node_id，完成后建立连接（确保首次注册即带上 node_id）
  loadNodeId(cwd)
    .then((id) => {
      cachedNodeId = id;
      if (!manualClose) connect();
    })
    .catch(() => {
      if (!manualClose) connect();
    });

  return {
    close: () => {
      manualClose = true;
      if (fileWsReconnectTimer) {
        clearTimeout(fileWsReconnectTimer);
        fileWsReconnectTimer = null;
      }
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (fileWsHeartbeat) clearInterval(fileWsHeartbeat);
      if (fileWs) {
        fileWs.onclose = null;
        fileWs.onerror = null;
        fileWs.close();
      }
      reconnectScheduler.cancel();
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

  /** requestPermission 等待前端响应的超时毫秒数 */
  const PERMISSION_TIMEOUT_MS = 30_000;

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
      // 与 remote 路径（spawnAcpAgent）行为对齐：发送 permission_request 到前端，等待用户响应。
      // Bun WS 的 async handler 在每次 await 时会 yield 到事件循环，不会阻塞后续 WS 消息处理，
      // 因此不会出现死锁——前端权限响应作为新的 WS 消息到达时，由独立的事件迭代处理。
      async requestPermission(params: Record<string, unknown>) {
        const sessionId = (params?.sessionId as string) ?? "";
        const toolCall = (params?.toolCall as Record<string, unknown>) ?? {};
        const toolCallId = (toolCall?.toolCallId as string) ?? "";
        const title = (toolCall?.title as string) ?? `OpenCode tool: ${toolCallId}`;
        const reqOptions = Array.isArray(params?.options) ? (params.options as acp.PermissionOption[]) : [];

        const requestId = `perm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const frontendOptions =
          reqOptions.length > 0
            ? reqOptions
            : [
                { kind: "allow_once" as const, name: "Allow Once", optionId: "allow_once" },
                { kind: "reject_once" as const, name: "Deny", optionId: "reject_once" },
              ];

        const outcome = await new Promise<acp.RequestPermissionOutcome>((resolve) => {
          const timer = setTimeout(() => {
            clientState.pendingPermissions.delete(requestId);
            resolve({ outcome: "cancelled" });
          }, PERMISSION_TIMEOUT_MS);
          clientState.pendingPermissions.set(requestId, {
            jsonRpcId: requestId,
            resolve,
            timeout: timer,
          });

          sendMsg(ws, {
            type: "permission_request",
            payload: {
              sessionId,
              requestId,
              options: frontendOptions,
              toolCall: { toolCallId, title },
              toolName: title,
              description: title,
            },
          });
        });

        return { outcome };
      },

      // AskUserQuestion：委托公共 elicitation handler（解析 schema、发帧、
      // 60s 超时空答案、control_response 回传均在其中，见 elicitation.ts）
      unstable_createElicitation: (params) => clientState.elicitation.handle(params),

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
      pending.resolve({
        outcome: "selected",
        optionId: outcome.optionId,
      });
    } else {
      pending.resolve({ outcome: "cancelled" });
    }
  }

  // --- session/update 通知处理 ---

  /** 处理从 WS 客户端发来的 JSON-RPC 通知（无 id），如 session/update */
  async function handleNotification(
    ws: AcpWs,
    msg: { method: string; params: Record<string, unknown> },
  ): Promise<void> {
    const state = clients.get(ws);
    if (!state) return;

    // 处理 session_info_update：本地缓存标题
    if (msg.method === ACP_METHOD.SESSION_UPDATE) {
      const sessionId = msg.params.sessionId as string | undefined;
      const update = msg.params.update as Record<string, unknown> | undefined;
      if (sessionId && update?.sessionUpdate === "session_info_update") {
        const title = update.title as string | null | undefined;
        if (title !== undefined) {
          state.titleOverrides.set(sessionId, title);
        }
      }
    }

    // 转发通知给 agent
    if (state.connection) {
      try {
        const conn = state.connection as unknown as {
          connection: { agent: { notify: (m: string, p: unknown) => Promise<void> } };
        };
        await conn.connection.agent.notify(msg.method, msg.params);
      } catch (error) {
        console.warn("[acp-server] Failed to forward notification:", msg.method, String(error));
      }
    }
  }

  // --- session/rename 请求处理 ---

  async function handleRenameSession(ws: AcpWs, id: number | string, params: Record<string, unknown>): Promise<void> {
    const state = clients.get(ws);
    if (!state?.connection) {
      sendMsg(ws, createErrorResponse(id, -32000, "Not connected to agent"));
      return;
    }

    const sessionId = params.sessionId as string;
    const title = (params.title as string) ?? "";

    try {
      // 本地缓存标题（agent 可能不支持 session_info_update，因此需本地维护）
      state.titleOverrides.set(sessionId, title);

      // 通过 session/update 通知转发 rename 给 agent
      const conn = state.connection as unknown as {
        connection: { agent: { notify: (m: string, p: unknown) => Promise<void> } };
      };
      await conn.connection.agent.notify("session/update", {
        sessionId,
        update: { sessionUpdate: "session_info_update", title },
      });
      sendMsg(ws, createSuccessResponse(id, { sessionId, title }));
    } catch (error) {
      sendMsg(ws, createErrorResponse(id, -32603, `Failed to rename session: ${(error as Error).message}`));
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
        payload: {
          connected: true,
          agentInfo: { name: command },
          capabilities: state.agentCapabilities,
        },
      });
      return;
    }

    // Kill existing process if any (only if not healthy)
    if (state.process) {
      cancelPendingPermissions(state);
      state.elicitation.cancelAll();
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

      // biome-ignore lint/suspicious/noExplicitAny: Bun.ChildProcessByStdio 不继承 EventEmitter，需 cast 监听 exit
      (agentProcess as any).on("exit", (code: number | null) => {
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
          // 声明支持 form 模式 elicitation（AskUserQuestion）：ACP 要求 client 在
          // initialize 时声明 elicitation capability，agent 才会发送 elicitation/create；
          // 工厂已实现 unstable_createElicitation（缺失 handler 时声明会导致 -32601）
          elicitation: { form: {} },
        },
      });

      const agentCaps = initResult.agentCapabilities;
      // 透传 SDK 返回的全部 capabilities，包括 configOptions 等未知字段
      state.agentCapabilities = agentCaps ?? null;
      state.promptCapabilities = agentCaps?.promptCapabilities ?? null;

      console.log(
        "agent initialized:",
        `protocolVersion=${initResult.protocolVersion}`,
        `loadSession=${!!state.agentCapabilities?.loadSession}`,
        `sessionList=${!!state.agentCapabilities?.sessionCapabilities?.list}`,
        `sessionResume=${!!state.agentCapabilities?.sessionCapabilities?.resume}`,
        `hasMcp=${!!state.agentCapabilities?.mcpCapabilities}`,
        // 本机已声明 elicitation.form capability：agent 可发送 elicitation/create
        `elicitationForm=true`,
      );

      sendMsg(ws, {
        type: "status",
        payload: {
          connected: true,
          agentInfo: initResult.agentInfo,
          capabilities: state.agentCapabilities,
        },
      });

      connection.closed.then(() => {
        console.log("agent connection closed");
        state.connection = null;
        state.sessionId = null;
        sendMsg(ws, { type: "status", payload: { connected: false } });
      });
    } catch (error) {
      console.error("agent connect failed:", (error as Error).message);
      sendMsg(ws, {
        type: "error",
        payload: {
          message: `Failed to connect: ${(error as Error).message}`,
        },
      });
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
      state.modelState = extractModelState(result.configOptions);
      state.modeState = result.modes ?? extractModeState(result.configOptions);
      console.log("session created:", result.sessionId, "cwd:", sessionCwd);

      sendMsg(
        ws,
        createSuccessResponse(id, {
          ...result,
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
      // 应用本地标题覆盖（agent 可能不支持 session_info_update）
      const withOverrides = result.sessions.map((s: acp.SessionInfo) => {
        const override = state.titleOverrides.get(s.sessionId);
        if (override !== undefined) {
          return { ...s, title: override };
        }
        return s;
      });
      // 过滤掉标题为空或以 "New session" 开头的会话（与 acp-dispatcher/session-manager 保持一致）
      const filtered = withOverrides.filter(
        (s: acp.SessionInfo) => s.title?.trim() && !s.title.trim().toLowerCase().startsWith("new session"),
      );
      const sessions = filtered.slice(0, MAX_SESSIONS);
      console.log(
        "sessions listed:",
        `total=${result.sessions.length}`,
        `filtered=${filtered.length}`,
        `returned=${sessions.length}`,
      );

      sendMsg(
        ws,
        createSuccessResponse(id, {
          sessions: sessions.map((s: acp.SessionInfo) => ({
            ...s,
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
      state.modelState = extractModelState(result.configOptions);
      state.modeState = result.modes ?? extractModeState(result.configOptions);
      console.log("session loaded:", sessionId, "cwd:", sessionCwd);
      console.log("session load result:", result);
      sendMsg(
        ws,
        createSuccessResponse(id, {
          ...result,
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
      state.modelState = extractModelState(result.configOptions);
      state.modeState = result.modes ?? extractModeState(result.configOptions);
      console.log("session resumed:", sessionId, "cwd:", sessionCwd);

      sendMsg(
        ws,
        createSuccessResponse(id, {
          ...result,
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
      const promptText = content
        .filter((c) => c.type === "text")
        .map((c) => (c as { text: string }).text)
        .join(" ");
      // 优先按请求携带的 sessionId 路由（并发 run 各自会话）；
      // yjs 前端 translator 的 prompt 不带 sessionId，fallback 到连接级当前会话，保持向后兼容
      const promptSessionId = (params.sessionId as string | undefined) ?? state.sessionId;
      console.log("[acp-server] prompt:", {
        sessionId: promptSessionId,
        id,
        text: promptText.slice(0, 200),
        blocks: content.length,
      });
      const result = await state.connection.prompt({
        sessionId: promptSessionId,
        prompt: content as acp.ContentBlock[],
      });

      console.log("[acp-server] prompt completed:", JSON.stringify(result).slice(0, 500));
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
    state.elicitation.cancelAll();

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

      // 校验 modelId 是否在 availableModels 中
      const availableIds = state.modelState!.availableModels.map((m) => m.modelId);
      if (!availableIds.includes(modelId)) {
        console.warn(
          `[acp-server] setSessionModel: modelId "${modelId}" not in availableModels, ` +
            `rejecting. Available: ${availableIds.join(", ")}`,
        );
        sendMsg(ws, createErrorResponse(id, -32602, `Model "${modelId}" is not available`));
        return;
      }

      console.log("setting model, sessionId:", state.sessionId, "modelId:", modelId);
      await state.connection.setSessionConfigOption?.({
        sessionId: state.sessionId,
        configId: "model",
        value: modelId,
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
        case "control_response": {
          // AskUserQuestion 答案回传（translator 构造的传输帧，非 JSON-RPC）：
          // request_id = questionId，extra.answers = 选中选项 label 数组（按问题顺序）。
          // 与 acp-dispatcher.ts:194 handleTransportMessage 消费形态对齐。
          const state = clients.get(ws);
          if (state) {
            const requestId = (msg.request_id as string) ?? "";
            if (!state.elicitation.resolve(requestId, (msg.extra ?? {}) as Record<string, unknown>)) {
              console.warn("question response for unknown request:", requestId);
            }
          }
          break;
        }
        case "cancel_pending_permissions": {
          // 前端 relay 断连时，主服务通过 relay handle 发送此消息，
          // 通知 acp-link server 立即取消所有待决权限请求，避免 agent 等待 30s 超时。
          const state = clients.get(ws);
          if (state) {
            cancelPendingPermissions(state);
            state.elicitation.cancelAll();
          }
          break;
        }
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
        case ACP_METHOD.SESSION_RENAME:
          await handleRenameSession(ws, id, p);
          break;
        default:
          sendMsg(ws, createErrorResponse(id, -32601, `Method not found: ${method}`));
      }
      return;
    }

    // JSON-RPC 通知（有 method 但无 id），如 session/update
    if (isJsonRpcMessage(msg) && msg.method && msg.id === undefined) {
      await handleNotification(ws, msg as { method: string; params: Record<string, unknown> });
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
        elicitation: createElicitationHandler((payload) => sendMsg(ws, { type: "interactive_question", payload })),
        agentCapabilities: null,
        promptCapabilities: null,
        modelState: null,
        modeState: null,
        isAlive: true,
        titleOverrides: new Map(),
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
        sendMsg(ws, {
          type: "error",
          payload: { message: `Error: ${(error as Error).message}` },
        });
      }
    },
    close(ws: AcpWs) {
      console.log("client disconnected");
      const state = clients.get(ws);
      if (state) {
        cancelPendingPermissions(state);
        state.elicitation.cancelAll();
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
        cs.elicitation.cancelAll();
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
