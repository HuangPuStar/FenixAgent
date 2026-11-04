import { afterEach, expect, test } from "bun:test";
import type { EngineRelayHandle } from "@fenix/plugin-sdk";
import { createAcpRoutes } from "../routes/acp";
import { bindFileWsPort } from "../server/services/file-ws-port";
import { initializeAgentRuntimeModuleConfig } from "../server/testing";
import { setExternalRelayDeps } from "../server/transport/relay/external-relay";
import { createStubAgentRuntimeAuthGuardPlugin } from "./guard-stubs";

/** Exercise the real socket callbacks while replacing only authentication and the remote Agent. */
function fixture() {
  initializeAgentRuntimeModuleConfig();
  bindFileWsPort({
    checkWsMessageSize: () => false,
    checkParsedObjectSize: () => false,
    estimateWsMessageBytes: () => 0,
    formatFileWsCloseLog: () => "closed",
    handleFileWsOpen: () => {},
    handleFileWsMessage: () => {},
    handleFileWsClose: () => {},
    parseFileWsMessage: () => [],
  });
  let authenticate!: () => void;
  const authentication = new Promise<void>((resolve) => {
    authenticate = resolve;
  });
  let emit: ((message: { type: string; payload?: unknown }) => void) | undefined;
  const relay: EngineRelayHandle = {
    state: "open",
    close() {},
    onMessage(listener) {
      emit = listener;
      listener({ type: "status", payload: { connected: true } });
      return () => {
        emit = undefined;
      };
    },
    send(message) {
      const rpc = message as unknown as { jsonrpc?: string; id: number; method: string; params?: { cwd?: string } };
      // A real ACP peer accepts bare JSON-RPC, not transport wrappers.
      if (rpc.jsonrpc === "2.0")
        emit?.({ jsonrpc: "2.0", id: rpc.id, result: { sessionId: "ses-live", cwd: rpc.params?.cwd } } as unknown as {
          type: string;
        });
    },
  };
  setExternalRelayDeps({
    getEnvironmentById: async () => ({
      id: "env-live",
      userId: "user-live",
      organizationId: "org-live",
      agentConfigId: "agent-live",
    }),
    canUseAgent: async () => true,
    resolveWorkspacePath: () => "/trusted/workspace",
    getRunningInstancesByEnvironment: () => [
      {
        id: "inst-live",
        userId: "user-live",
        port: 0,
        pid: null,
        status: "running",
        command: "",
        error: null,
        apiKey: "",
        createdAt: new Date(),
        environmentId: "env-live",
      },
    ],
    getOwnedInstance: async () => ({
      id: "inst-live",
      ownerUserId: "user-live",
      environmentId: "env-live",
      name: "primary",
      creationSource: "api",
      isDefault: true,
      createdByUserId: "user-live",
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
    connectAgentRelay: async () => relay,
    markRelayAttached: () => {},
    markRelayDetached: () => {},
    touchActivity: () => {},
  });
  const app = createAcpRoutes({
    authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
    authenticateRequest: async () => {
      await authentication;
      return { user: { id: "user-live" }, authContext: { userId: "user-live", organizationId: "org-live" } };
    },
  });
  app.listen({ hostname: "127.0.0.1", port: 0 });
  const messages: Array<{ id?: number; type?: string; result?: unknown }> = [];
  const socket = new WebSocket(`ws://127.0.0.1:${app.server!.port}/acp/relay/env-live?instanceId=inst-live`);
  socket.onmessage = (event) => messages.push(JSON.parse(String(event.data)));
  return { app, socket, messages, authenticate };
}

/** Poll an observable socket result with a bounded deadline. */
async function eventually(predicate: () => boolean) {
  const deadline = Date.now() + 1000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
  expect(predicate()).toBe(true);
}
afterEach(() => setExternalRelayDeps(null));

// 客户端在 WS open 后立即发帧，异步认证不得使首个 session/new 永久丢失。
test("external ACP buffers the first frame during authentication", async () => {
  const h = fixture();
  try {
    await new Promise<void>((resolve) => (h.socket.onopen = () => resolve()));
    h.socket.send(JSON.stringify({ jsonrpc: "2.0", id: 41, method: "session/new", params: { cwd: "/untrusted" } }));
    await Bun.sleep(30);
    expect(h.messages).toHaveLength(0);
    h.authenticate();
    await eventually(() => h.messages.some((message) => message.id === 41));
    expect(h.messages.find((message) => message.id === 41)?.result).toEqual({
      sessionId: "ses-live",
      cwd: "/trusted/workspace",
    });
  } finally {
    h.authenticate();
    h.socket.close();
    await h.app.stop(true);
  }
});

// 包裹请求在协议边界还原 JSON-RPC，实际 ACP peer 才能识别并回复。
test("external ACP unwraps transport envelopes for the Agent peer", async () => {
  const h = fixture();
  try {
    h.authenticate();
    await eventually(() => h.messages.some((message) => message.type === "status"));
    h.socket.send(
      JSON.stringify({
        type: "acp",
        payload: { jsonrpc: "2.0", id: 42, method: "session/new", params: { cwd: "/untrusted" } },
      }),
    );
    await eventually(() => h.messages.some((message) => message.id === 42));
    expect(h.messages.find((message) => message.id === 42)?.result).toEqual({
      sessionId: "ses-live",
      cwd: "/trusted/workspace",
    });
  } finally {
    h.authenticate();
    h.socket.close();
    await h.app.stop(true);
  }
});
