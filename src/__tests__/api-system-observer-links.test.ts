// src/__tests__/api-system-observer-links.test.ts
// GET /api/system/observer/acp-link 的鉴权 / 结构 / integrity 单测（实现计划 §6.2，文档 §7.2）。
//
// 基建约定：process.env.RCS_SYSTEM_API_KEYS 在 beforeEach 设置、afterEach 恢复；
// setObserverServiceDeps(fake) 注入来源（getEnvironment 走默认 → stubEnvironmentRepo 控制权威表）；
// 直接对路由 app 发 Request 断言状态码与响应结构。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  acpLinkProvider,
  type ObserverServiceDeps,
  observerService,
  setObserverServiceDeps,
} from "../services/observer";
import { resetAllStubs } from "../test-utils/helpers";
import type { AcpConnectionSnapshot } from "../types/store";

const apiSystemObserverRoutes = (await import("../routes/api/system-observer")).default;

function request(path: string, init?: RequestInit) {
  return apiSystemObserverRoutes.handle(new Request(`http://localhost${path}`, init));
}

/** machine 连接快照（machineId 可空，模拟注册前/后）。 */
function makeMachine(overrides: Partial<AcpConnectionSnapshot> = {}): AcpConnectionSnapshot {
  return {
    wsId: "ws_m1",
    userId: "__machine__",
    agentId: null,
    boundEnvId: null,
    machineId: "mach_x",
    isMachine: true,
    openTime: 1000,
    capabilities: null,
    ...overrides,
  };
}

/** 默认 fake deps：来源为空、machine 解析为空、名称解析为空；测试按需覆盖。 */
function makeFakeDeps(overrides: Partial<ObserverServiceDeps> = {}): Partial<ObserverServiceDeps> {
  return {
    listAcpWsConnections: () => [],
    listExternalRelayEntries: () => [],
    listChatClients: () => [],
    getAgentConfigById: async () => null,
    getDefaultMachineId: () => null,
    getInstanceName: async () => undefined,
    listOrganizationNamesByIds: async () => new Map(),
    listUserNamesByIds: async () => new Map(),
    listAgentConfigNamesByIds: async () => new Map(),
    listMachineNamesByIds: async () => new Map(),
    ...overrides,
  };
}

describe("API System Observer", () => {
  const originalKeys = process.env.RCS_SYSTEM_API_KEYS;

  beforeEach(() => {
    resetAllStubs();
    process.env.RCS_SYSTEM_API_KEYS = "sys-key-1";
    setObserverServiceDeps(makeFakeDeps());
  });

  afterEach(() => {
    setObserverServiceDeps(null);
    process.env.RCS_SYSTEM_API_KEYS = originalKeys;
    // test 5 摘除了 acp-link provider，复位时重新注册，避免影响后续用例
    observerService.register(acpLinkProvider);
  });

  // 未携带系统级 key 时，系统观察面应拒绝访问。
  test("无 key 请求返回 401", async () => {
    const res = await request("/api/system/observer/acp-link");
    const json = await res.json();
    expect(res.status).toBe(401);
    expect(json).toEqual({ error: { code: "UNAUTHORIZED", message: "Invalid system API key" } });
  });

  // 错误 key / 错误 query token 同样应被拒绝。
  test("错 key 与错 query token 返回 401", async () => {
    const headerRes = await request("/api/system/observer/acp-link", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(headerRes.status).toBe(401);

    const queryRes = await request("/api/system/observer/acp-link?token=wrong-key");
    expect(queryRes.status).toBe(401);
  });

  // 有效 key + fake deps：返回 { success, data }，data 含 kind/total/trees.{byEntity,byOrg}/integrity。
  test("有效 key 返回 acp-link 观察视图", async () => {
    setObserverServiceDeps(makeFakeDeps({ listAcpWsConnections: () => [makeMachine()] }));

    const res = await request("/api/system/observer/acp-link", {
      headers: { Authorization: "Bearer sys-key-1" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      success: boolean;
      data: {
        kind: string;
        total: number;
        trees: { byEntity: unknown[]; byOrg: unknown[] };
        integrity: { checked: number; mismatched: number; mismatchedItems: unknown[] };
        names: Record<string, Record<string, string>>;
      };
    };
    expect(json.success).toBe(true);
    expect(json.data.kind).toBe("acp-link");
    expect(json.data.total).toBe(1);
    expect(json.data.trees.byEntity).toEqual([
      { machineId: "mach_x", count: 1, leaves: [{ id: "acp-ws:ws_m1", source: "acp-ws", roleId: "mach_x" }] },
    ]);
    expect(json.data.trees.byOrg).toEqual([]);
    expect(json.data.integrity).toEqual({ checked: 1, mismatched: 0, mismatchedItems: [] });
    // names 字典存在（fake deps 名称解析为空），角色键完整
    expect(json.data.names).toEqual({
      organizationId: {},
      userId: {},
      agentConfigId: {},
      instanceId: {},
      machineId: {},
    });
  });

  // 一致性命中：machine 注册前（machineId=null）→ verified=false → mismatched=1 且明细含 kind+id。
  test("integrity 命中：mismatched 与 mismatchedItems", async () => {
    setObserverServiceDeps(makeFakeDeps({ listAcpWsConnections: () => [makeMachine({ machineId: null })] }));

    const res = await request("/api/system/observer/acp-link", {
      headers: { Authorization: "Bearer sys-key-1" },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      data: { integrity: { checked: number; mismatched: number; mismatchedItems: { kind: string; id: string }[] } };
    };
    expect(json.data.integrity.checked).toBe(1);
    expect(json.data.integrity.mismatched).toBe(1);
    expect(json.data.integrity.mismatchedItems).toEqual([{ kind: "acp-link", id: "acp-ws:ws_m1" }]);
  });

  // Provider 摘除后请求应 404（kind 未注册），错误响应为通用 NOT_FOUND。
  test("Provider 摘除后请求返回 404", async () => {
    observerService.unregister("acp-link");

    const res = await request("/api/system/observer/acp-link", {
      headers: { Authorization: "Bearer sys-key-1" },
    });
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
