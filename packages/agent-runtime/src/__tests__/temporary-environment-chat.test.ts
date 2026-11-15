import { afterEach, beforeEach, expect, test } from "bun:test";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { createAgentRuntimeModule } from "../runtime";
import {
  bindTemporaryEnvironmentStop,
  temporaryEnvironmentLifecycle,
} from "../server/services/temporary-environment-state";
import { stubCoreRuntimeFacade, stubEnvironmentRepo } from "../server/testing";
import { connectAgentRelay } from "../server/transport/agent-relay";
import { openAgentSession, setAgentChatServiceDeps } from "../services/agent-chat-service";
import { releaseAgentExecutions } from "../services/agent-execution-admission";
import { releaseAgentSessionTurns } from "../services/agent-session-admission";

const instance = {
  id: "inst_temp_chat",
  environmentId: "temp-chat",
  ownerUserId: "user",
  creationSource: "api" as const,
  name: "api",
  isDefault: false,
  createdByUserId: "user",
  createdAt: new Date(),
  updatedAt: new Date(),
};
beforeEach(() => {
  stubDb({ update: () => ({ set: () => ({ where: async () => ({ rowCount: 1 }) }) }) });
});
afterEach(() => {
  setAgentChatServiceDeps(null);
  releaseAgentExecutions(instance.id);
  releaseAgentSessionTurns(instance.id);
  createAgentRuntimeModule();
  resetAllStubs();
});
// 实际 PromptTurn 等待必须在 TTL 触发时结束，不等待底层严格停止确认。
test("expiry interrupts an active prompt before physical stop finishes", async () => {
  const operations = Reflect.get(temporaryEnvironmentLifecycle, "operations") as ReadonlyMap<
    string,
    ReadonlySet<AbortController>
  >;
  let expiresAt = new Date(Date.now() + 60000),
    finishStop!: () => void;
  const stopping = new Promise<void>((r) => {
    finishStop = r;
  });
  const methods: string[] = [];
  let receive: ((message: EngineRelayMessage) => void) | undefined;
  const handle: EngineRelayHandle = {
    state: "open",
    ready: Promise.resolve(),
    close() {},
    onMessage(listener) {
      receive = listener;
      return () => {
        receive = undefined;
      };
    },
    send(message) {
      const rpc = message as unknown as { method?: string; id?: number };
      if (rpc.method) methods.push(rpc.method);
      if (rpc.method === "session/new")
        receive?.({ type: "json-rpc", payload: { jsonrpc: "2.0", id: rpc.id, result: { sessionId: "ses_temp" } } });
    },
  };
  stubEnvironmentRepo({ getById: async () => ({ id: instance.environmentId, expiresAt }) });
  bindTemporaryEnvironmentStop(async () => {
    await stopping;
    receive?.({ type: "relay_closed" });
  });
  setAgentChatServiceDeps({
    resolveApiAgentInstance: async () => ({
      agentConfigId: "123e4567-e89b-12d3-a456-426614174000",
      environmentId: instance.environmentId,
      instance,
    }),
    ensureInstanceRuntime: async () => {},
    connectAgentRelay: async () => handle,
  });
  const { turn } = await openAgentSession({
    organizationId: "org",
    userId: "user",
    agentConfigId: "123e4567-e89b-12d3-a456-426614174000",
    instanceId: instance.id,
    startSource: "interactive",
  });
  expect(operations.get(instance.environmentId)?.size).toBe(1);
  turn.prompt([{ type: "text", text: "long task" }]);
  const next = turn.events()[Symbol.asyncIterator]().next();
  expiresAt = new Date(0);
  const expired = temporaryEnvironmentLifecycle.expire(instance.environmentId);
  expect((await next).done).toBe(true);
  expect(methods).toContain("session/cancel");
  finishStop();
  await expired;
  await turn.dispose();
  expect(receive).toBeUndefined();
  expect(operations.has(instance.environmentId)).toBe(false);
});
// 到期释放底层消费者前须通知上层，否则外部 ACP WebSocket 会失去监听且悬挂。
test("expiry notifies and closes an already connected relay consumer", async () => {
  let expiresAt = new Date(Date.now() + 60000),
    closed = false;
  const handle: EngineRelayHandle = {
    state: "open",
    close() {
      closed = true;
    },
    send() {},
    onMessage() {
      return () => {};
    },
  };
  stubEnvironmentRepo({ getById: async () => ({ id: instance.environmentId, expiresAt }) });
  bindTemporaryEnvironmentStop(async () => {});
  stubCoreRuntimeFacade({
    getInstance: () =>
      ({
        instanceId: instance.id,
        nodeId: "machine",
        status: "running",
        launchSpec: { environmentId: instance.environmentId },
      }) as never,
    connectInstanceRelay: async () => handle,
  });
  const relay = await connectAgentRelay(instance.id, "");
  const messages: EngineRelayMessage[] = [];
  const removedMessages: EngineRelayMessage[] = [];
  relay.onMessage?.((message) => messages.push(message));
  const unsubscribe = relay.onMessage?.((message) => removedMessages.push(message));
  unsubscribe?.();
  expiresAt = new Date(0);
  await temporaryEnvironmentLifecycle.expire(instance.environmentId);
  expect(closed).toBe(true);
  expect(messages).toEqual([{ type: "relay_closed", payload: { code: "environment_expired" } }]);
  expect(removedMessages).toEqual([]);
});
