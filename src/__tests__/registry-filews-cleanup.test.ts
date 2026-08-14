import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { AuthContext } from "../plugins/auth";
import { resetAllStubs, stubDb } from "../test-utils/helpers";
import type { WsConnection } from "../transport/ws-types";

// registry.ts 被 setup-mocks preload mock（REGISTRY_KEYS），本测试需要真实 deleteMachine /
// writeRegistryEvent 实现：Bun 的模块 mock 按解析后路径匹配，带 query 的 specifier（?real）
// 会解析为独立实例、绕过 mock 注册表；该实例内部导入的 ../db 仍走 stubDb（Proxy 实时转发），
// file-ws-handler 不被 preload mock（真实模块），因此"stubDb → deleteMachine → handler 清理"
// 整条链路均为真实代码。`?real` 仅用于测试入口，生产代码不受影响。
// @ts-expect-error -- TS 无法解析带 query 的 specifier（Bun 运行时支持），原因见上方注释
const realRegistry = await import("../services/registry?real");

// sendFileOpAndWait 属请求发送域（自 handler 拆至 file-ws-requests，setup-mocks 部分
// mock——未配置 stub 时回退真实实现），此处动态 import 发起真实 pending
const requests = await import("../transport/file-ws-requests");

const ORG_ID = "org-1";
const USER_ID = "user-1";

const authCtx: AuthContext = { organizationId: ORG_ID, userId: USER_ID, role: "owner" };

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
  handler: typeof import("../transport/file-ws-handler"),
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
  resetAllStubs();
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

afterAll(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

describe("deleteMachine 退役清理（P0-5 / D18）", () => {
  // 退役机器必须立即切断 file-ws：pending 被 reject、索引清理、连接 close，并写 retired 事件
  test("删除后 file-ws 连接关闭、pending 拒绝、retired 事件落库", async () => {
    const handler = await import("../transport/file-ws-handler");
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
    // retired 事件落库：values 携带 machineId + type + detail
    expect(insert).toHaveBeenCalledTimes(1);
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ machineId: "mach_retire", type: "retired", detail: { reason: "machine deleted" } }),
    );
  });

  // 无活跃 file-ws 的机器删除时清理函数为空操作，不抛错且事件正常落库
  test("无 file-ws 连接的机器删除不抛错且事件正常落库", async () => {
    const valuesMock = mock(async () => {});
    const insert = mock(() => ({ values: valuesMock }));
    stubDeleteMachineDb({ id: "mach_idle", status: "offline" }, insert);

    const result = await realRegistry.deleteMachine(authCtx, "mach_idle");

    expect(result).toEqual({ deleted: true });
    expect(valuesMock).toHaveBeenCalledWith(expect.objectContaining({ machineId: "mach_idle", type: "retired" }));
  });
});

describe("writeRegistryEvent 通用落库导出", () => {
  // 通用落库导出（W1 degraded 钩子 / W7 告警复用）：生成 evt_ id 并插入 registryEvent
  test("写入 registryEvent：id 前缀 evt_、type/detail 透传", async () => {
    const valuesMock = mock(async () => {});
    stubDb({ insert: mock(() => ({ values: valuesMock })) });

    await realRegistry.writeRegistryEvent("mach_evt", "degraded", { reason: "idle timeout" });

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
