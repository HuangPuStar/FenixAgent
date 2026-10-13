// src/__tests__/api-system-observer-links.test.ts
// GET /api/system/observer/acp-link 的结构 / integrity 单测（实现计划 §6.2，文档 §7.2）。
//
// 基建约定：`setObserverServiceDeps(fake)` 注入来源与权威回查（environment 也走同一 seam 的
// `getEnvironment`），直接对路由 app 发 Request 断言状态码与响应结构。
// 鉴权不在本文件覆盖：守卫由宿主注入，包内只能注入放行替身（见 `./guard-stubs`）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import { createApiSystemObserverRoutes } from "../server/routes/api/system-observer";
import {
  type AcpConnectionSnapshot,
  acpLinkProvider,
  observerService,
  setObserverServiceDeps,
} from "../server/services/observer";
import { createStubSystemApiGuardPlugin } from "./guard-stubs";
import { makeFakeDeps } from "./observer-fixtures";

const apiSystemObserverRoutes = createApiSystemObserverRoutes({
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});

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

describe("API System Observer", () => {
  beforeEach(() => {
    resetAllStubs();
    setObserverServiceDeps(makeFakeDeps());
  });

  afterEach(() => {
    setObserverServiceDeps(null);
    // 下方的用例摘除了 acp-link provider，复位时重新注册，避免影响后续用例
    observerService.register(acpLinkProvider);
  });

  // fake deps 下返回 { success, data }，data 含 kind/total/trees.{byEntity,byOrg}/integrity。
  test("返回 acp-link 观察视图", async () => {
    setObserverServiceDeps(makeFakeDeps({ listAcpWsConnections: () => [makeMachine()] }));

    const res = await request("/api/system/observer/acp-link");
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

    const res = await request("/api/system/observer/acp-link");
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

    const res = await request("/api/system/observer/acp-link");
    expect(res.status).toBe(404);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("NOT_FOUND");
  });
});
