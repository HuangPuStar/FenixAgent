import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { stubDb } from "@fenix/platform-sdk/testing";
import { writeRegistryEvent } from "../server/repositories/registry-event";
import { initializeMachineModuleConfig } from "../server/testing";
import type { WsConnection } from "../server/transport/ws-types";
import type { MachineRequestAuth } from "../server/types/auth";

// 经包根入口取真实的 deleteMachine 与请求发送域实现：本测试要覆盖「stubDb → deleteMachine →
// file-ws 连接清理与 pending 拒绝」整条真实链路，句柄替换（setRegistryRouteDeps 等）只用于路由层，
// 这里不经过路由。
const realRegistry = await import("@fenix/resource-machine/server");

// sendFileOpAndWait 属请求发送域（自 handler 拆至 file-ws-requests），此处发起真实 pending 请求
const requests = await import("@fenix/resource-machine/server");

const ORG_ID = "org-1";
const USER_ID = "user-1";

const authCtx: MachineRequestAuth = { organizationId: ORG_ID, userId: USER_ID, role: "owner" };

function createMockWs(readyState = 1): WsConnection & { _messages: string[] } {
  const messages: string[] = [];
  const ws = {
    readyState,
    send: mock((data: string) => {
      messages.push(data);
    }),
    close: mock(() => {}),
    _messages: messages,
  } as unknown as WsConnection & { _messages: string[] };
  return ws;
}

/** 建立一条已注册的 file-ws 连接（open + register），返回 mock ws */
function openRegisteredWs(
  handler: typeof import("@fenix/resource-machine/server"),
  wsId: string,
  machineId: string,
): WsConnection & { _messages: string[] } {
  const ws = createMockWs();
  handler.handleFileWsOpen(ws, wsId);
  handler.handleFileWsMessage(ws, wsId, { type: "register", machine_id: machineId });
  return ws;
}

/**
 * 构造 deleteMachine 所需的 stubDb：三次 select 依次返回
 * machine 记录（非 online）、agentConfig 引用（空）、organization 记录（空 metadata）。
 */
function stubDeleteMachineDb(machineRecord: { id: string; status: string }, insert: ReturnType<typeof mock>): void {
  stubDb({
    select: mock()
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ limit: async () => [machineRecord] }) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ limit: async () => [] }) }),
      }))
      .mockImplementationOnce(() => ({
        from: () => ({ where: () => ({ limit: async () => [{}] }) }),
      })),
    delete: mock(() => ({ where: () => {} })),
    insert,
  });
}

beforeEach(async () => {
  // 初始化基础设施（真实 deleteMachine / writeRegistryEvent 都要读 DB，未初始化会直接抛错）
  initializeMachineModuleConfig();
  const handler = await import("@fenix/resource-machine/server");
  handler.closeAllFileWsConnections();
});

afterAll(async () => {
  const handler = await import("@fenix/resource-machine/server");
  handler.closeAllFileWsConnections();
});

describe("deleteMachine 退役清理（P0-5 / D18）", () => {
  // 退役机器必须立即切断 file-ws，并按既有时序尝试调用 retired 事件写入。
  test("删除后 file-ws 连接关闭、pending 拒绝并尝试写入 retired 事件", async () => {
    const handler = await import("@fenix/resource-machine/server");
    const ws = openRegisteredWs(handler, "ws_retire", "mach_retire");
    const pending = requests.sendFileOpAndWait("mach_retire", "list", { path: "/" }).catch((e) => e);

    const valuesMock = mock(async () => {});
    const insert = mock(() => ({ values: valuesMock }));
    stubDeleteMachineDb({ id: "mach_retire", status: "offline" }, insert);

    const result = await realRegistry.deleteMachine(authCtx, "mach_retire");

    expect(result).toEqual({ deleted: true });
    // file-ws 索引已清理：isFileWsConnected 必须为 false，不再有请求路由到退役机器
    expect(handler.isFileWsConnected("mach_retire")).toBe(false);
    // 悬挂的 pending 必须被 reject（而不是等待 60s 超时）
    const err = await pending;
    expect((err as Error).message).toContain("machine retired");
    expect(ws.close).toHaveBeenCalled();
    // retired 事件写入尝试必须携带 machineId、type 和 detail；不代表真实 FK 下能成功归档。
    expect(insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "mach_retire", type: "retired", detail: { reason: "machine deleted" } }),
    );
  });

  // 无活跃 file-ws 时，即使 retired 事件写入失败，已完成的机器删除仍返回成功。
  test("无 file-ws 连接时 retired 事件写入失败不改变删除结果", async () => {
    const valuesMock = mock(async () => {
      throw new Error("retired event write failed");
    });
    const insert = mock(() => ({ values: valuesMock }));
    stubDeleteMachineDb({ id: "mach_idle", status: "offline" }, insert);

    const result = await realRegistry.deleteMachine(authCtx, "mach_idle");

    expect(result).toEqual({ deleted: true });
    // best-effort 写入失败被 deleteMachine 捕获，但调用参数仍必须正确。
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ machineId: "mach_idle", type: "retired" }));
  });
});

describe("registry event repository", () => {
  // repository 通用落库能力（W1 degraded 钩子 / W7 告警复用）：生成 evt_ id 并插入 registryEvent
  test("写入 registryEvent：id 前缀 evt_、type/detail 透传", async () => {
    const valuesMock = mock(async () => {});
    stubDb({ insert: mock(() => ({ values: valuesMock })) });

    await writeRegistryEvent("mach_evt", "degraded", { reason: "idle timeout" });

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evt_/),
        machineId: "mach_evt",
        type: "degraded",
        detail: { reason: "idle timeout" },
      }),
    );
  });
});
