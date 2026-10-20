import { afterEach, expect, test } from "bun:test";
import { type AgentInstanceRecord, type EnvironmentRecord, getBoundAgentRuntime } from "@fenix/agent-runtime/runtime";
import { resetAgentRuntimePort, stubAgentRuntimePort } from "@fenix/agent-runtime/server/testing";
import type { EngineRelayHandle, EngineRelayMessage } from "@fenix/plugin-sdk";
import { cleanupSpawnedInstances } from "../server/services/workflow";
import { AgentChatSessionAdapter, createAgentChatTransport } from "../server/services/workflow/agent-chat-transport";
import {
  acquireInstanceLease,
  clearInstanceLeases,
  hasActiveInstanceLease,
  releaseInstanceLease,
} from "../server/services/workflow/instance-lease";

const now = new Date();
const environment: EnvironmentRecord = {
  id: "env",
  name: "agent",
  userId: "owner",
  organizationId: "org",
  description: null,
  workspacePath: "unused",
  agentConfigId: null,
  secret: "fixture",
  machineName: null,
  directory: null,
  branch: null,
  gitRepoUrl: null,
  workerType: "acp",
  capabilities: null,
  status: "active",
  username: null,
  autoStart: true,
  lastPollAt: null,
  createdAt: now,
  updatedAt: now,
};
const instance: AgentInstanceRecord = {
  id: "instance",
  environmentId: "env",
  ownerUserId: "owner",
  creationSource: "workflow",
  name: "primary",
  isDefault: false,
  createdByUserId: "owner",
  createdAt: now,
  updatedAt: now,
};

function setupRelay() {
  const listeners = new Set<(message: EngineRelayMessage) => void>();
  const sent: Array<Record<string, unknown>> = [];
  const handle: EngineRelayHandle = {
    state: "open",
    close() {},
    send(message) {
      sent.push(message as unknown as Record<string, unknown>);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return { handle, sent, listeners };
}

afterEach(() => {
  resetAgentRuntimePort();
  clearInstanceLeases();
});

// 预先取消的工作流必须在解析环境和启动实例之前被拒绝。
test("pre-aborted workflow connect performs no runtime work", async () => {
  let lookedUp = false;
  const runtime = getBoundAgentRuntime();
  stubAgentRuntimePort({
    observe: {
      ...runtime.observe,
      async listEnvironmentRecordsByOrganization() {
        lookedUp = true;
        return [environment];
      },
    },
  });
  const cancellation = new AbortController();
  cancellation.abort();
  await expect(
    createAgentChatTransport("org").connect("agent", { userId: "owner", signal: cancellation.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(lookedUp).toBe(false);
});

// 连接期间取消必须立即结算等待，迟到租约只归还自身，不能发出 session/new 或 prompt。
test("workflow connect cancellation reclaims a late relay lease without sending ACP", async () => {
  const runtime = getBoundAgentRuntime();
  const relay = setupRelay();
  let finish!: (handle: EngineRelayHandle) => void;
  let entered!: () => void;
  const connecting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = 0;
  relay.handle.close = () => {
    closed++;
  };
  stubAgentRuntimePort({
    observe: {
      ...runtime.observe,
      async listEnvironmentRecordsByOrganization() {
        return [environment];
      },
    },
    async findOrCreateWorkflowInstanceWithStatus() {
      return { instance, created: false };
    },
    async ensureInstanceRuntime() {},
    session: {
      ...runtime.session,
      connectRelay() {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      },
    },
  });
  const cancellation = new AbortController();
  const pending = createAgentChatTransport("org").connect("agent", { userId: "owner", signal: cancellation.signal });
  await connecting;
  cancellation.abort();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  finish(relay.handle);
  await Promise.resolve();
  await Promise.resolve();
  expect(closed).toBe(1);
  expect(relay.sent).toHaveLength(0);
  expect(hasActiveInstanceLease(instance.id)).toBe(false);
});

// 执行开始前取消不能发送 prompt，执行中取消和静默超时都要把取消请求送达本 turn。
test("workflow execute refuses pre-aborted prompt and cancels silent active turns", async () => {
  const runtime = getBoundAgentRuntime();
  for (const mode of ["pre", "active", "timeout"]) {
    const relay = setupRelay();
    const chatSession = runtime.session.createAgentSession({ instanceId: "instance", relayHandle: relay.handle });
    const turn = runtime.session.createPromptTurn(chatSession, "ses-workflow");
    const adapter = new AgentChatSessionAdapter(turn, chatSession, 10);
    const cancellation = new AbortController();
    if (mode === "pre") cancellation.abort();
    const pending = adapter.execute({ prompt: "run", signal: cancellation.signal });
    if (mode === "active") cancellation.abort();
    await expect(pending).rejects.toThrow();
    expect(relay.sent.map((request) => request.method)).toEqual(
      mode === "pre" ? [] : ["session/prompt", "session/cancel"],
    );
    await adapter.dispose();
    if (mode !== "pre") {
      for (const listener of relay.listeners) {
        listener({
          type: "event",
          payload: { jsonrpc: "2.0", id: relay.sent[0].id, result: { stopReason: "cancelled" } },
        });
      }
    }
  }
});

// 另一 run 正在 ensure 时创建者 cleanup 必须跳过；连接失败或取消只归还自身租约。
test("workflow cleanup protects pending ensure and releases its lease on failure or cancellation", async () => {
  for (const mode of ["failure", "cancellation"] as const) {
    const runtime = getBoundAgentRuntime();
    let entered!: () => void;
    const ensuring = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let resolveEnsure!: () => void;
    let rejectEnsure!: (error: Error) => void;
    const blockedEnsure = new Promise<void>((resolve, reject) => {
      resolveEnsure = resolve;
      rejectEnsure = reject;
    });
    let stops = 0;
    stubAgentRuntimePort({
      observe: {
        ...runtime.observe,
        async listEnvironmentRecordsByOrganization() {
          return [environment];
        },
      },
      async findOrCreateWorkflowInstanceWithStatus() {
        return { instance, created: false };
      },
      ensureInstanceRuntime() {
        entered();
        return blockedEnsure;
      },
      async stopInstance() {
        stops++;
        return { ok: true };
      },
    });
    const cancellation = new AbortController();
    const pending = createAgentChatTransport("org").connect("agent", {
      userId: "owner",
      signal: cancellation.signal,
    });
    const outcome = pending.catch((error: unknown) => error);
    await ensuring;
    expect(await cleanupSpawnedInstances(new Set([instance.id]), "org")).toEqual([instance.id]);
    expect(stops).toBe(0);
    acquireInstanceLease(instance.id);
    const failure = new Error("ensure failed");
    if (mode === "failure") rejectEnsure(failure);
    else cancellation.abort(failure);
    expect(await outcome).toBe(failure);
    expect(hasActiveInstanceLease(instance.id)).toBe(true);
    releaseInstanceLease(instance.id);
    expect(hasActiveInstanceLease(instance.id)).toBe(false);
    expect(await cleanupSpawnedInstances(new Set([instance.id]), "org")).toEqual([]);
    expect(stops).toBe(1);
    resolveEnsure();
  }
});
