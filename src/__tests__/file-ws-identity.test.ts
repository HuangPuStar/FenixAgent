import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { setConfig } from "../config";
import { resetAllStubs, stubCoreBootstrap, stubRegistry } from "../test-utils/helpers";
import type { WsConnection } from "../transport/ws-types";

// file-ws-handler 由 setup-mocks preload 部分 mock（仅 isFileWsConnected /
// sendFileOpAndWait 可 stub，未配置时回退真实实现），本测试动态 import 后使用真实
// register 对账逻辑；core-bootstrap 的 getCoreRuntime 与 registry 的 writeRegistryEvent
// 经 stubCoreBootstrap / stubRegistry 注入（lazy mock，调用时解析）。
// 告警断言走 registry_event 落库（§7.4 可观测）：测试模式下 pino level=silent，
// logger.warn 无输出，registryEvent 是唯一可断言的告警通道（与 W7 测试同模式）。
// 模块级连接状态在 beforeEach/afterEach 通过 closeAllFileWsConnections 清理。

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

/** open 连接（不 register），返回 mock ws */
function openWs(
  handler: typeof import("../transport/file-ws-handler"),
  wsId: string,
): WsConnection & { _messages: string[] } {
  const ws = createMockWs();
  handler.handleFileWsOpen(ws, wsId);
  return ws;
}

/** 从发送帧中解析 type 序列（断言 registered 帧是否送达） */
function sentTypes(ws: WsConnection & { _messages: string[] }): string[] {
  return ws._messages.map((line) => (JSON.parse(line) as { type?: string }).type as string);
}

beforeEach(async () => {
  resetAllStubs();
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

afterEach(async () => {
  // 恢复宽松默认：config 为模块级共享对象，严格模式用例必须复位避免泄漏
  setConfig({ fileWsIdentityStrict: undefined });
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

afterAll(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

describe("W11 身份绑定（§7.1，P2-14）", () => {
  test("严格模式 + 未知 machine（getNode 为 null）：close 4404 且不注册、不广播 registered", async () => {
    // 对账查询面是 core runtime node 注册（registerRemoteNode 产物）：getNode 查无此机
    // → 严格模式必须 close(4404, "unknown_machine")，不得登记进 machineFileWsIndex
    stubCoreBootstrap({ getCoreRuntime: () => ({ getNode: () => null }) });
    const registryEventSpy = mock(async () => {});
    stubRegistry({ writeRegistryEvent: registryEventSpy });
    setConfig({ fileWsIdentityStrict: true });
    const handler = await import("../transport/file-ws-handler");

    const ws = openWs(handler, "ws_strict_unknown");
    handler.handleFileWsMessage(ws, "ws_strict_unknown", { type: "register", machine_id: "mach_ghost" });

    expect(ws.close).toHaveBeenCalledWith(4404, "unknown_machine");
    expect(sentTypes(ws)).not.toContain("registered");
    expect(handler.isFileWsConnected("mach_ghost")).toBe(false);
    // §7.4 可观测：4404 拒绝落库 registryEvent，管理面可见
    expect(registryEventSpy).toHaveBeenCalledTimes(1);
    const [machineId, type] = registryEventSpy.mock.calls[0] as unknown as [string, string];
    expect(machineId).toBe("mach_ghost");
    expect(type).toBe("unknown_machine_rejected");
  });

  test("严格模式 + 已知 machine（getNode 有值）：正常注册放行", async () => {
    // 对账通过（该 machine 已完成 acp-ws 注册链，node 存在于 core runtime）→
    // 严格模式下也必须放行：不得误杀合法机器
    stubCoreBootstrap({
      getCoreRuntime: () => ({ getNode: () => ({ id: "mach_known", mode: "remote", status: "online" }) }),
    });
    const registryEventSpy = mock(async () => {});
    stubRegistry({ writeRegistryEvent: registryEventSpy });
    setConfig({ fileWsIdentityStrict: true });
    const handler = await import("../transport/file-ws-handler");

    const ws = openWs(handler, "ws_strict_known");
    handler.handleFileWsMessage(ws, "ws_strict_known", { type: "register", machine_id: "mach_known" });

    expect(ws.close).not.toHaveBeenCalled();
    expect(sentTypes(ws)).toContain("registered");
    expect(handler.isFileWsConnected("mach_known")).toBe(true);
    // 合法机器不产生任何告警事件
    expect(registryEventSpy).not.toHaveBeenCalled();
  });

  test("宽松模式（默认）+ 未知 machine：放行注册 + 告警落库", async () => {
    // 两阶段过渡软开关默认 false：getNode 查无此机（含服务端重启后 file-ws 先于
    // acp-ws 到达的时序窗口）时放行 + 告警，不硬阻塞旧机器端
    stubCoreBootstrap({ getCoreRuntime: () => ({ getNode: () => null }) });
    const registryEventSpy = mock(async () => {});
    stubRegistry({ writeRegistryEvent: registryEventSpy });
    const handler = await import("../transport/file-ws-handler");

    const ws = openWs(handler, "ws_lenient");
    handler.handleFileWsMessage(ws, "ws_lenient", { type: "register", machine_id: "mach_late" });

    expect(ws.close).not.toHaveBeenCalled();
    expect(sentTypes(ws)).toContain("registered");
    expect(handler.isFileWsConnected("mach_late")).toBe(true);
    // 告警断言：registryEvent 记录宽松放行（unknown_machine_lenient）
    expect(registryEventSpy).toHaveBeenCalledTimes(1);
    const [machineId, type] = registryEventSpy.mock.calls[0] as unknown as [string, string];
    expect(machineId).toBe("mach_late");
    expect(type).toBe("unknown_machine_lenient");
  });

  test("宽松模式（显式 false）+ 未知 machine：行为与默认一致", async () => {
    // 显式 RCS_FILE_WS_IDENTITY_STRICT=false 时同样放行，覆盖 env 显式配置路径
    stubCoreBootstrap({ getCoreRuntime: () => undefined });
    setConfig({ fileWsIdentityStrict: false });
    const handler = await import("../transport/file-ws-handler");

    const ws = openWs(handler, "ws_lenient_explicit");
    handler.handleFileWsMessage(ws, "ws_lenient_explicit", { type: "register", machine_id: "mach_late2" });

    expect(ws.close).not.toHaveBeenCalled();
    expect(sentTypes(ws)).toContain("registered");
    expect(handler.isFileWsConnected("mach_late2")).toBe(true);
  });
});
