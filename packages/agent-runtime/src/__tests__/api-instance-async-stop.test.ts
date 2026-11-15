import { afterEach, expect, spyOn, test } from "bun:test";
import { createApiInstanceRoutes } from "@fenix/agent-runtime/server";
import { resetAllStubs } from "@fenix/platform-sdk/testing";
import type { AgentInstanceRecord } from "../server/repositories/agent-instance";
import {
  agentInstanceRuntimeCoordinator,
  agentInstanceService,
  bindAgentInstanceRuntimeOperations,
  resetAgentInstanceRuntimeOperations,
} from "../server/services/agent-instance-service";
import { setApiInstanceDeps } from "../server/services/api-instance";
import { stubCoreRuntimeFacade } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

function gate() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** 只替换外部运行时停止与持久读取，使用真实路由、授权和生命周期仲裁器。 */
function fixture(temporary = false, foreign = false) {
  const id = `inst_async_stop_${crypto.randomUUID()}`;
  const environmentId = `${temporary ? "temp" : "env"}-${crypto.randomUUID()}`;
  const row: AgentInstanceRecord = {
    id,
    environmentId,
    ownerUserId: "owner",
    creationSource: "api",
    name: "api",
    isDefault: false,
    createdByUserId: "owner",
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const stopping = gate();
  const started = gate();
  let calls = 0;
  let present = true;
  stubCoreRuntimeFacade({ getInstance: () => null });
  bindAgentInstanceRuntimeOperations({
    hasActiveInstance: (instanceId) => instanceId === id && present,
    spawnInstance: async () => {},
    stopInstance: async () => {
      calls++;
      started.resolve();
      await stopping.promise;
      present = false;
    },
  });
  setTestAuth({ organizationId: "org", userId: "owner" });
  setApiInstanceDeps({
    getOwnedInstance: async () => row,
    getEnvironmentById: async () =>
      ({
        id: environmentId,
        userId: "owner",
        organizationId: foreign ? "foreign-org" : "org",
        agentConfigId: "agent",
      }) as never,
    findVisibleAgentConfig: async () => ({ id: "agent" }) as never,
  });
  const app = createApiInstanceRoutes({ authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(), logError: () => {} });
  const stop = () => app.handle(new Request(`http://localhost/api/v1/instances/${id}/stop`, { method: "POST" }));
  const status = async () =>
    (await (await app.handle(new Request(`http://localhost/api/v1/instances/${id}`))).json()).data.status;
  return { id, row, stop, status, stopping, started, calls: () => calls };
}

afterEach(() => {
  setApiInstanceDeps(null);
  resetTestAuth();
  resetAgentInstanceRuntimeOperations();
  resetAllStubs();
});

// 普通与临时实例都在远端尚未停止时返回 202；查询状态仍须反映停止中的事实。
test.each([false, true])("stop accepts before runtime exit for temporary=%s", async (temporary) => {
  const f = fixture(temporary);
  const request = f.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await f.started.promise;
    const response = await Promise.race([
      request,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, 1000);
      }),
    ]);
    expect(response?.status).toBe(202);
    expect(await response?.json()).toEqual({ success: true, data: null });
    expect(await f.status()).toBe("stopping");
    f.stopping.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.status()).toBe("stopped");
  } finally {
    if (timer) clearTimeout(timer);
    f.stopping.resolve();
    await request;
  }
});

// 重复 HTTP 请求复用仲裁器中同一次停止，不能向执行节点发出重复停止操作。
test("repeated accepted stops share the same running lifecycle operation", async () => {
  const f = fixture();
  try {
    const responses = await Promise.all([f.stop(), f.stop()]);
    expect(responses.map((response) => response.status)).toEqual([202, 202]);
    expect(f.calls()).toBe(1);
  } finally {
    f.stopping.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

// 后台停止失败不能变成已停止，也不能产生未处理的 Promise 拒绝。
test("a failed accepted stop remains observable as unknown", async () => {
  const f = fixture();
  try {
    expect((await f.stop()).status).toBe(202);
    f.stopping.reject(new Error("remote stop failed"));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(await f.status()).toBe("unknown");
    expect(agentInstanceService.getRuntimeSnapshot(f.id).lastFailure).toContain("remote stop failed");
  } finally {
    f.stopping.resolve();
  }
});

// 授权失败仍须在受理前拒绝，不能将跨组织停止排进后台。
test("foreign instances are rejected before a stop can be accepted", async () => {
  const f = fixture(false, true);
  expect((await f.stop()).status).toBe(404);
  expect(f.calls()).toBe(0);
});

// 仲裁器在关闭等准入阶段拒绝时，HTTP 不能把未入槽的任务误报成已受理。
test("a runtime rejection before registration remains an HTTP failure", async () => {
  const f = fixture();
  const rejected = spyOn(agentInstanceService, "stopInstanceRuntime").mockRejectedValue(
    new Error("coordinator is shutting down"),
  );
  try {
    const response = await f.stop();
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("INSTANCE_STOP_UNAVAILABLE");
    expect(f.calls()).toBe(0);
  } finally {
    rejected.mockRestore();
  }
});

// 删除门禁尚未释放时停止请求必须明确冲突，不能假装登记了另一项后台任务。
test("a deleting instance rejects a new stop with 409", async () => {
  const f = fixture();
  const deleting = agentInstanceRuntimeCoordinator.deleteRuntime(f.row);
  try {
    await f.started.promise;
    const response = await f.stop();
    expect(response.status).toBe(409);
    expect(f.calls()).toBe(1);
  } finally {
    f.stopping.resolve();
    await deleting;
  }
});
