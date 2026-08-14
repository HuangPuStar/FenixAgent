// src/__tests__/chat-channel-bootstrap.test.ts
// C7 桥接层测试：控制器单例缓存与重置、fake 依赖注入、场景 K（并发受限时先复用、
// 仅新建检查配额）、桥接注入的 authorizeEnvironment 多租户隔离语义。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  getChatChannelController,
  resetChatChannelBootstrap,
  setChatChannelBootstrapDeps,
} from "../services/chat-channel-bootstrap";
import type { WsConnection } from "../transport/ws-types";

type MockWs = WsConnection & {
  messages: string[];
  closed: Array<[number | undefined, string | undefined]>;
};

function createWs(): MockWs {
  return {
    readyState: 1,
    messages: [],
    closed: [],
    send(message: string) {
      this.messages.push(message);
    },
    close(code?: number, reason?: string) {
      this.closed.push([code, reason]);
    },
  };
}

/** 记录型 fake relay handle（无 onMessage：gateway 跳过监听器注册） */
function fakeRelayHandle() {
  return { state: "open", send() {}, close() {} };
}

describe("chat channel bootstrap", () => {
  beforeEach(() => {
    resetChatChannelBootstrap();
    setChatChannelBootstrapDeps(null);
  });

  afterEach(() => {
    resetChatChannelBootstrap();
    setChatChannelBootstrapDeps(null);
  });

  // 控制器必须单例缓存：SessionChannel 构造时向 DocManager 注册权限请求回调
  // （单槽位装配点），重复构造会覆盖前者导致权限超时迁移失效
  test("getChatChannelController returns the same singleton until reset", () => {
    const first = getChatChannelController();
    const second = getChatChannelController();
    expect(second).toBe(first);

    resetChatChannelBootstrap();
    const third = getChatChannelController();
    expect(third).not.toBe(first);
  });

  // fake 依赖注入后必须重建控制器才生效（resetChatChannelBootstrap 语义）
  test("injected fake dependencies take effect after reset", async () => {
    const ensureRunningCalls: string[] = [];
    setChatChannelBootstrapDeps({
      environmentRepo: {
        getById: async () => ({ id: "env-1", organizationId: "org-1", machineName: "Agent", userId: "user-1" }),
      } as never,
      ensureRunning: (async (userId: string) => {
        ensureRunningCalls.push(userId);
        return { instance: { id: "instance-1" }, status: "spawned" };
      }) as never,
      connectAgentRelay: (async () => fakeRelayHandle()) as never,
    });

    const controller = getChatChannelController();
    const ws = createWs();
    await controller.gateway.handleOpen(ws, "yjs_1", "user-1", "env-1", "rcs-1");

    expect(ws.closed).toHaveLength(0);
    expect(ensureRunningCalls).toEqual(["user-1"]);
    controller.gateway.handleClose("yjs_1");
  });

  // 场景 K：同一 agent 的第二个会话打开时先复用运行实例，不再次 spawn；
  // 配额检查只发生在新建分支（由宿主 ensureRunning 承担，桥接层不得绕过）
  test("reuses a running instance via ensureRunning before spawning a new one", async () => {
    const spawnedAgents: string[] = [];
    const reusedAgents: string[] = [];
    let ensureRunningCalls = 0;
    setChatChannelBootstrapDeps({
      environmentRepo: {
        getById: async () => ({ id: "env-1", organizationId: "org-1", machineName: "Agent", userId: "user-1" }),
      } as never,
      ensureRunning: (async (_userId: string, agentId: string) => {
        ensureRunningCalls += 1;
        if (spawnedAgents.includes(agentId)) {
          reusedAgents.push(agentId);
          return { instance: { id: `instance-${agentId}` }, status: "reused" };
        }
        spawnedAgents.push(agentId);
        return { instance: { id: `instance-${agentId}` }, status: "spawned" };
      }) as never,
      connectAgentRelay: (async () => fakeRelayHandle()) as never,
    });

    const controller = getChatChannelController();
    const firstWs = createWs();
    await controller.gateway.handleOpen(firstWs, "yjs_1", "user-1", "agent-1", "rcs-1");
    expect(firstWs.closed).toHaveLength(0);

    const secondWs = createWs();
    await controller.gateway.handleOpen(secondWs, "yjs_2", "user-1", "agent-1", "rcs-2");
    expect(secondWs.closed).toHaveLength(0);

    expect(ensureRunningCalls).toBe(2);
    expect(spawnedAgents).toEqual(["agent-1"]);
    expect(reusedAgents).toEqual(["agent-1"]);

    controller.gateway.handleClose("yjs_1");
    controller.gateway.handleClose("yjs_2");
  });

  // 多租户隔离：个人环境（无组织）被非 owner 用户打开时，桥接层纵深防御必须
  // 拒绝，且不得触达实例生命周期（ensureRunning 不被调用）
  test("rejects a personal environment opened by another user before ensureRunning", async () => {
    const ensureRunningCalls: string[] = [];
    setChatChannelBootstrapDeps({
      environmentRepo: {
        getById: async () => ({ id: "env-1", organizationId: null, machineName: "Agent", userId: "user-a" }),
      } as never,
      ensureRunning: (async () => {
        ensureRunningCalls.push("called");
        return { instance: { id: "instance-1" }, status: "spawned" };
      }) as never,
    });

    const controller = getChatChannelController();
    const ws = createWs();
    await controller.gateway.handleOpen(ws, "yjs_1", "user-b", "env-1", "rcs-1");

    expect(ws.closed).toEqual([[4003, "unauthorized"]]);
    expect(ensureRunningCalls).toHaveLength(0);
  });

  // 组织环境的访问权由路由 authContext 决定，桥接层纵深防御必须放行组织环境
  test("allows an organization environment regardless of the opening user", async () => {
    setChatChannelBootstrapDeps({
      environmentRepo: {
        getById: async () => ({ id: "env-1", organizationId: "org-1", machineName: "Agent", userId: "user-a" }),
      } as never,
      ensureRunning: (async () => ({ instance: { id: "instance-1" }, status: "spawned" })) as never,
      connectAgentRelay: (async () => fakeRelayHandle()) as never,
    });

    const controller = getChatChannelController();
    const ws = createWs();
    await controller.gateway.handleOpen(ws, "yjs_1", "user-b", "env-1", "rcs-1");

    expect(ws.closed).toHaveLength(0);
    controller.gateway.handleClose("yjs_1");
  });
});
