import { createDeterministicRcsSessionId, decodeYjsSyncFrame, encodeYjsStateVectorFrame } from "@fenix/chat-channel";
import { DocManager, getSessionInfo } from "@fenix/chat-channel/server";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import * as Y from "yjs";
import { createAcpRoutes } from "../routes/acp";
import type { AcpRouteDependencies } from "../routes/dependencies";
import type { EnvironmentRecord } from "../runtime";
import {
  getChatChannelController,
  resetChatChannelBootstrap,
  setChatChannelBootstrapDeps,
} from "../server/services/chat-channel-bootstrap";
import { bindFileWsPort, resetFileWsPort } from "../server/services/file-ws-port";
import { initializeAgentRuntimeModuleConfig, stubEnvironmentRepo } from "../server/testing";
import {
  createStubAgentRuntimeAuthGuardPlugin,
  createStubAuthenticateRequest,
  resetTestAuth,
  setTestAuth,
} from "./guard-stubs";

interface RouteSocket {
  data: { request: Request; params: { agentId: string } };
  readyState: number;
  send(data: string): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
}
interface RouteHooks {
  open(ws: RouteSocket): Promise<void>;
  message(ws: RouteSocket, data: unknown): void;
  close(ws: RouteSocket): void;
}
interface RouteView {
  method: string;
  path: string;
  hooks: RouteHooks;
}

/** 等待可观察协议事件；失败由有界 deadline 说明，避免固定睡眠误判异步时序。 */
export async function eventually(check: () => boolean): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() >= deadline) throw new Error("Timed out waiting for route protocol event");
    await Bun.sleep(1);
  }
}

/** 用真实路由 hooks、入站队列和 ChatController 验证接缝；只替换认证、仓储和 Agent 进程。 */
export async function createYjsRouteFixture(
  bigHistory = false,
  syncEnabled = false,
  authenticateRequest: AcpRouteDependencies["authenticateRequest"] = createStubAuthenticateRequest(),
) {
  initializeAgentRuntimeModuleConfig();
  resetChatChannelBootstrap();
  setTestAuth({ organizationId: "org-route", userId: "user-route" });
  const environment: EnvironmentRecord = {
    id: "env-route",
    name: "route",
    description: null,
    workspacePath: "/unused",
    agentConfigId: null,
    secret: "",
    machineName: null,
    directory: null,
    branch: null,
    gitRepoUrl: null,
    workerType: "acp",
    capabilities: null,
    status: "active",
    username: null,
    userId: "user-route",
    organizationId: "org-route",
    autoStart: true,
    lastPollAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
  stubEnvironmentRepo({ getById: async () => environment });
  const manager = new DocManager({ acpBatchWindowMs: 0 });
  const rcsSessionId = createDeterministicRcsSessionId(environment.id, "user-route", "instance-route");
  const chat = await manager.openChat(rcsSessionId);
  const session = await manager.openSession("user-route", environment.id, rcsSessionId);
  getSessionInfo(session.ydoc).set("sessionId", "ses-a");
  if (bigHistory) chat.ydoc.getText("history").insert(0, "x".repeat(9 * 1024 * 1024));
  const cached = new Map<string, Y.Doc>();
  for (const [name, doc] of [
    [`chat:${rcsSessionId}`, chat.ydoc],
    [`session:${rcsSessionId}`, session.ydoc],
  ] as const) {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(doc));
    cached.set(name, copy);
  }
  chat.ydoc.getText("history").insert(chat.ydoc.getText("history").length, "tail");
  const sent: Record<string, unknown>[] = [];
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  const frames: Array<string | Uint8Array> = [];
  const closes: Array<{ code?: number; reason?: string }> = [];
  const errors: unknown[] = [];
  const emit = async (message: EngineRelayMessage) => {
    await Promise.all([...listeners].map((listener) => listener(message)));
  };
  setChatChannelBootstrapDeps({
    docManager: manager,
    ensureRunning: async () => "instance-route",
    getRuntimeIdentity: () => JSON.stringify(["route-test", 1]),
    connectAgentRelay: async () => ({
      state: "open",
      send: (message) => {
        sent.push(message as unknown as Record<string, unknown>);
        if (message.type === "connect")
          void emit({ type: "status", payload: { connected: true, capabilities: { loadSession: true } } });
      },
      onMessage: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: () => {},
    }),
    resolveWorkspacePath: () => "/workspace",
    refreshInstanceEnvironment: async () => {},
    markInstanceRelayAttached: () => {},
    markInstanceRelayDetached: () => {},
    touchInstanceActivity: () => {},
    log: () => {},
    logError: (_message, error) => {
      errors.push(error);
    },
    maxClients: () => 20,
    chatSyncProtocol: () => ({ enabled: syncEnabled, sealGraceMs: 2_000, retireGraceMs: 30_000 }),
    snapshotPersist: () => ({ intervalMs: 2_000, idleMs: 500, ttlSeconds: 600 }),
    sessionTitleStore: () => ({ read: async () => ({}), write: async () => {}, delete: async () => {} }),
  });
  bindFileWsPort({
    checkWsMessageSize: (value, limit) =>
      (typeof value === "string" ? Buffer.byteLength(value) : value.byteLength) > limit,
    checkParsedObjectSize: (value, limit) =>
      typeof value === "object" && !(value instanceof Uint8Array) && Buffer.byteLength(JSON.stringify(value)) > limit,
    estimateWsMessageBytes: () => 0,
    formatFileWsCloseLog: () => "",
    handleFileWsOpen: () => {},
    handleFileWsClose: () => {},
    handleFileWsMessage: () => {},
    parseFileWsMessage: () => [],
  });
  const app = createAcpRoutes({
    authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
    authenticateRequest,
  });
  const route = (app.routes as unknown as RouteView[]).find(
    (entry) => entry.method === "WS" && entry.path === "/acp/yjs/:agentId",
  );
  if (!route) throw new Error("Missing YJS WebSocket route");
  const hooks = route.hooks;
  const controller = getChatChannelController();
  let replyGeneration: string | null = chat.generation;
  let reply = true;
  const socket: RouteSocket = {
    data: {
      request: new Request(
        `http://localhost/acp/yjs/${environment.id}?instanceUid=instance-route&rcsSessionId=${rcsSessionId}&acpSessionId=ses-a`,
      ),
      params: { agentId: environment.id },
    },
    readyState: 1,
    send(data) {
      frames.push(data);
      const message = JSON.parse(data) as { type: string; docs?: Array<{ docName: string }> };
      if (message.type === "yjs:sync-request" && reply) sendVectors(message.docs?.map((doc) => doc.docName));
    },
    sendBinary(data) {
      frames.push(data);
      const frame = decodeYjsSyncFrame(data);
      if (frame?.type === "update") {
        const target = cached.get(frame.docName);
        if (target) Y.applyUpdate(target, frame.update);
      }
    },
    close(code, reason) {
      closes.push({ code, reason });
      this.readyState = 3;
    },
  };
  function sendVectors(names = [...cached.keys()]) {
    for (const name of names) {
      const doc = cached.get(name);
      if (doc)
        hooks.message(
          socket,
          encodeYjsStateVectorFrame(name, replyGeneration ?? chat.generation, Y.encodeStateVector(doc)),
        );
    }
  }
  const text = () =>
    frames
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const commandIds = new Map<string, string>();
  const commandId = (label: string) => {
    let id = commandIds.get(label);
    if (!id) {
      id = `${controller.sessionChannel.getCommandEpoch()}.${crypto.randomUUID()}`;
      commandIds.set(label, id);
    }
    return id;
  };
  const action = (message: Record<string, unknown>) =>
    hooks.message(socket, JSON.stringify({ ...message, commandId: commandId(String(message.commandId)) }));
  const ack = (id: string) =>
    text().some(
      (frame) => frame.type === "action_ack" && frame.commandId === commandId(id) && frame.status === "committed",
    );
  return {
    app,
    manager,
    controller,
    rcsSessionId,
    chat,
    session,
    cached,
    sent,
    frames,
    closes,
    errors,
    text,
    action,
    commandId,
    ack,
    sendVectors,
    open: () => hooks.open(socket),
    disconnect: () => {
      socket.readyState = 3;
      hooks.close(socket);
    },
    setReply: (enabled: boolean, generation = chat.generation) => {
      reply = enabled;
      replyGeneration = generation;
    },
    respond: (id: unknown, result: Record<string, unknown>) =>
      emit({ type: "agent_message", payload: { jsonrpc: "2.0", id, result } }),
    async dispose() {
      hooks.close(socket);
      controller.legacyGenerationWatcher.stop();
      await manager.closeAll();
      for (const doc of cached.values()) doc.destroy();
      resetChatChannelBootstrap();
      setChatChannelBootstrapDeps(null);
      resetFileWsPort();
      resetTestAuth();
    },
  };
}
