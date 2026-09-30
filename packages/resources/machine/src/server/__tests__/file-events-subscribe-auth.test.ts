// `/web/file-events` 订阅鉴权的连接级用例：归属判定已上移到文件域门面（§3.2），端点只剩协议映射。
//
// 为什么单独一份：判定上移后，端点还剩两件事要证明——拒绝时**显式回** `subscribe_error` 帧（而不是静默丢弃、
// 也不是关闭连接），以及非权限类故障不被误报成 forbidden；同时正向路径必须仍然建立订阅（守卫没有过宽）。
// 本文件用 mock WS 驱动 handler 层：薄壳只做 Elysia WS 适配与 session 认证，订阅/拒绝/生命周期逻辑都在
// handler，行为差异在此可见。门面自己的判据（跨组织 / 非本人 → not_found）由 `machine-file-facade.test.ts`
// 覆盖，两者合起来说明「路由不再自行判定」没有把不可见的环境放进来。
//
// 模块级状态：`activeClients`（服务级连接计数）跨用例存活，`afterEach` 必须 closeAllFileEventsClients；
// 环境队列同样按 envId 泄漏，逐个 destroy。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import type { MachineEnvironmentRecord } from "../environment-port";
import { closeAllFileEventsClients, handleFileEventsOpen } from "../routes/web/file-events";
import { destroyEnvironmentQueue, publishFileEvent } from "../services/file-event-queue";
import { initializeMachineModuleConfig, stubMachineEnvironment } from "../testing";
import type { WsConnection } from "../transport/ws-types";

const ORG_ID = "org-1";
const USER_ID = "user-1";
/** 订阅者上下文：宿主的请求认证结果经 `toFileEventsAuth` 投影后的两个字段。 */
const AUTH = { organizationId: ORG_ID, userId: USER_ID };

/** 单元用例里出现过的环境（afterEach 销毁其队列，避免跨用例带走订阅者与缓冲）。 */
const usedEnvironments: string[] = [];

/** mock WS：记录发出的帧，供断言拒绝帧与事件帧。 */
function createMockWs(): WsConnection & { messages: string[] } {
  const messages: string[] = [];
  return {
    readyState: 1,
    send: (data: string) => messages.push(data),
    close: () => {},
    messages,
  } as unknown as WsConnection & { messages: string[] };
}

/** 把一条环境记录表达成生产归属规则（缺失 / 跨组织 / agent 绑定环境非本人 → NotFoundError）。 */
function stubOwnershipRule(records: MachineEnvironmentRecord[]): void {
  stubMachineEnvironment({
    getOwnedEnvironment: async (environmentId, organizationId, userId) => {
      const record = records.find((item) => item.id === environmentId);
      if (!record || record.organizationId !== organizationId) throw new NotFoundError("环境不存在");
      if (record.agentConfigId && record.userId !== userId) throw new NotFoundError("环境不存在");
      return record;
    },
  });
}

/** 打开连接并订阅给定环境；返回 mock WS（订阅处理是异步的，等待由调用方经返回值 await）。 */
async function subscribe(environments: string[]): Promise<WsConnection & { messages: string[] }> {
  usedEnvironments.push(...environments);
  const ws = createMockWs();
  const client = handleFileEventsOpen(ws, AUTH, 200);
  if (!client) throw new Error("mock WS 应通过认证与连接数检查");
  await client.handleMessage({ type: "subscribe", environments });
  return ws;
}

/** 等待事件队列的微任务 fan-out 完成（与 file-ws-events.test.ts 同法）。 */
async function flushEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** 解析 mock WS 收到的全部帧。 */
function framesOf(ws: { messages: string[] }): Record<string, unknown>[] {
  return ws.messages.map((message) => JSON.parse(message) as Record<string, unknown>);
}

beforeEach(() => {
  initializeMachineModuleConfig();
});

afterEach(() => {
  closeAllFileEventsClients();
  for (const envId of usedEnvironments.splice(0)) {
    destroyEnvironmentQueue(envId);
  }
});

describe("file-events 订阅鉴权（判定在门面，端点为协议映射）", () => {
  // 正向路径：本人环境订阅后必须真收到事件——否则「拒绝」类断言可能因为订阅从未建立而假绿。
  test("本人 environment 订阅成功后收到该环境的事件帧", async () => {
    const envId = "evt-auth-own";
    stubOwnershipRule([{ id: envId, organizationId: ORG_ID, userId: USER_ID }]);

    const ws = await subscribe([envId]);
    expect(ws.messages).toEqual([]);

    publishFileEvent(envId, { type: "file_changed", path: "user/a.txt", kind: "write", source: "user" });
    await flushEvents();

    expect(framesOf(ws)).toEqual([
      { type: "file_changed", environment_id: envId, path: "user/a.txt", kind: "write", source: "user" },
    ]);
  });

  // 跨组织：显式回 subscribe_error（协议要求，订阅方据此提示无权限），且不建立订阅——后续该环境的事件不下发。
  test("跨组织的 environment 回 subscribe_error 且不建立订阅", async () => {
    const envId = "evt-auth-cross-org";
    stubOwnershipRule([{ id: envId, organizationId: "org-2", userId: USER_ID }]);

    const ws = await subscribe([envId]);
    expect(framesOf(ws)).toEqual([{ type: "subscribe_error", environment_id: envId, code: "forbidden" }]);

    publishFileEvent(envId, { type: "file_changed", path: "user/a.txt", kind: "write", source: "user" });
    await flushEvents();

    expect(framesOf(ws)).toEqual([{ type: "subscribe_error", environment_id: envId, code: "forbidden" }]);
  });

  // 非本人：agent 绑定的环境属个人 workspace，共享 agent 不等于共享 workspace，同样只能回 subscribe_error。
  test("非本人的 environment 回 subscribe_error", async () => {
    const envId = "evt-auth-other-owner";
    stubOwnershipRule([{ id: envId, organizationId: ORG_ID, userId: "user-2", agentConfigId: "ac-1" }]);

    const ws = await subscribe([envId]);

    expect(framesOf(ws)).toEqual([{ type: "subscribe_error", environment_id: envId, code: "forbidden" }]);
  });

  // 存储 / 环境读取故障不是权限问题：不能回 forbidden（会把「服务挂了」误导成「你没权限」），
  // 也不能建立订阅——只保留诊断日志，订阅方表现为收不到确认（与迁移前一致）。
  test("归属校验故障（非权限类）不回 subscribe_error 且不建立订阅", async () => {
    const envId = "evt-auth-storage-error";
    stubMachineEnvironment({
      getOwnedEnvironment: async () => {
        throw new Error("environment store unavailable");
      },
    });

    const ws = await subscribe([envId]);
    expect(ws.messages).toEqual([]);

    publishFileEvent(envId, { type: "file_changed", path: "user/a.txt", kind: "write", source: "user" });
    await flushEvents();

    expect(ws.messages).toEqual([]);
  });
});
