import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WsConnection } from "../transport/ws-types";

// file-ws-handler 未被 setup-mocks preload mock（仅 registry/registry-heartbeat 等被 mock），
// 测试直接动态 import 真实模块；模块级 Map 状态在 beforeEach/afterAll 通过
// closeAllFileWsConnections 清理，避免测试间状态泄漏。

// sendFileOpAndWait / BusyError 属请求发送域（自 handler 拆至 file-ws-requests，与
// handler 同被 setup-mocks 部分 mock——未配置 stub 时回退真实实现），此处动态 import
const fileOpRequests = await import("../transport/file-ws-requests");

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

/** 从发送帧中解析 file_op 的 request_id（模拟机器端回执时需要） */
function parseRequestIds(ws: WsConnection & { _messages: string[] }): string[] {
  return ws._messages
    .map((line) => JSON.parse(line) as { type?: string; request_id?: string })
    .filter((m) => m.type === "file_op" && m.request_id)
    .map((m) => m.request_id as string);
}

beforeEach(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

afterAll(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

describe("P0-1 心跳巡检", () => {
  test("lastClientActivity 超时后 sweep 清理索引、reject pending 并 close 连接", async () => {
    // 僵尸连接（活跃时间拨老超过 90s 阈值）应被巡检回收：pending 立即失败、索引清理、连接关闭
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_zombie", "mach_zombie");
    const pending = fileOpRequests.sendFileOpAndWait("mach_zombie", "list", { path: "/" }).catch((e) => e);

    // 注入未来时间 now（等效于把 lastClientActivity 拨老到 120s 前），90s 阈值判定为僵尸
    handler.sweepFileWsConnections(90_000, Date.now() + 120_000);

    const err = await pending;
    expect(err).toBeInstanceOf(Error);
    // W12a 读重试契约（§7.2）：zombie reject 属 closed 类可恢复失败，读操作自动重试一次；
    // 机器索引已清理 → 重试快速失败（No active file-ws connection），不悬挂至 60s 超时
    expect((err as Error).message).toContain("No active file-ws connection");
    expect(handler.isFileWsConnected("mach_zombie")).toBe(false);
    expect(ws.close).toHaveBeenCalled();
    // 回收后再次发起操作立即失败（无活跃连接），不再占用 pending 槽位
    await expect(fileOpRequests.sendFileOpAndWait("mach_zombie", "list", { path: "/" })).rejects.toThrow(
      "No active file-ws connection",
    );
  });

  test("活跃连接（keep_alive 更新时间戳）不被 sweep 误杀", async () => {
    // keep_alive 帧更新 lastClientActivity，巡检不应回收仍在活跃的连接（防灰度误杀）
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_active", "mach_active");
    handler.handleFileWsMessage(ws, "ws_active", { type: "keep_alive" });

    handler.sweepFileWsConnections(90_000);

    expect(handler.isFileWsConnected("mach_active")).toBe(true);
    expect(ws.close).not.toHaveBeenCalled();
  });
});

describe("P0-2 背压", () => {
  test("单连接并发 100 个请求：第 65 个起同步拒绝 busy，前 64 个正常登记", async () => {
    // 单连接 pending 上限 64：第 65 个请求起应立即收到 BusyError，不得无界登记
    const handler = await import("../transport/file-ws-handler");
    const { BusyError } = fileOpRequests;
    openRegisteredWs(handler, "ws_busy", "mach_busy");

    const requests: Promise<unknown>[] = [];
    for (let i = 0; i < 100; i++) {
      requests.push(fileOpRequests.sendFileOpAndWait("mach_busy", "list", { path: `/f${i}` }));
    }

    const busyErrors = await Promise.all(requests.slice(64).map((p) => p.catch((e) => e)));
    for (const err of busyErrors) {
      expect(err).toBeInstanceOf(BusyError);
      expect(err).toHaveProperty("code", "busy");
    }

    // 前 64 个仍挂起等待机器端，未被 busy 拒绝；清理后以 server shutdown 结束
    handler.closeAllFileWsConnections();
    const settled = await Promise.allSettled(requests.slice(0, 64));
    for (const r of settled) {
      expect(r.status).toBe("rejected");
    }
  });

  test("全局 pending 满 1024 后新连接请求被拒（busy）", async () => {
    // 全局 pending 上限 1024：占满后即使新连接自身无 pending，第一个请求也应被拒
    const handler = await import("../transport/file-ws-handler");
    const { BusyError } = fileOpRequests;

    // 16 个连接各 64 个 pending，恰好占满全局 1024 槽位
    const all: Promise<unknown>[] = [];
    for (let i = 0; i < 16; i++) {
      openRegisteredWs(handler, `ws_g_${i}`, `mach_g_${i}`);
      for (let j = 0; j < 64; j++) {
        all.push(fileOpRequests.sendFileOpAndWait(`mach_g_${i}`, "list", { path: `/g${i}/${j}` }));
      }
    }

    openRegisteredWs(handler, "ws_g_17", "mach_g_17");
    const err = await fileOpRequests.sendFileOpAndWait("mach_g_17", "list", { path: "/x" }).catch((e) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect(err).toHaveProperty("message", expect.stringContaining("global"));

    handler.closeAllFileWsConnections();
    const settled = await Promise.allSettled(all);
    for (const r of settled) {
      expect(r.status).toBe("rejected");
    }
  });

  test("busy 拒绝不占用槽位；机器端回执释放后新请求可继续登记", async () => {
    // 计数一致性：busy 拒绝不得残留计数；file_op_result 回执释放槽位后新请求应可再次登记
    const handler = await import("../transport/file-ws-handler");
    const { BusyError } = fileOpRequests;
    const ws = openRegisteredWs(handler, "ws_release", "mach_release");

    const requests: Promise<unknown>[] = [];
    for (let i = 0; i < 66; i++) {
      requests.push(fileOpRequests.sendFileOpAndWait("mach_release", "list", { path: `/f${i}` }));
    }
    // 第 65、66 个请求被 busy 拒绝（单连接上限 64）
    expect(await requests[65].catch((e) => e)).toBeInstanceOf(BusyError);

    // 模拟机器端回执释放 2 个 pending 槽位，前 2 个请求正常 resolve
    const ids = parseRequestIds(ws);
    expect(ids).toHaveLength(64);
    for (const requestId of ids.slice(0, 2)) {
      handler.handleFileWsMessage(ws, "ws_release", {
        type: "file_op_result",
        request_id: requestId,
        status: "ok",
        data: { ok: true },
      });
    }
    expect(await requests[0]).toEqual({ status: "ok", data: { ok: true } });
    expect(await requests[1]).toEqual({ status: "ok", data: { ok: true } });

    // 槽位释放后（剩余 62 个 pending），新请求可再次登记：清理时以 server shutdown 结束而非 busy
    const again = fileOpRequests.sendFileOpAndWait("mach_release", "list", { path: "/again" }).catch((e) => e);
    handler.closeAllFileWsConnections();
    const againErr = await again;
    expect(againErr).toBeInstanceOf(Error);
    expect((againErr as Error).message).toContain("server shutdown");

    // 消费全部请求避免 unhandled rejection：[0]/[1] fulfilled（回执），[2..63] shutdown，[64]/[65] busy
    const settled = await Promise.allSettled(requests);
    expect(settled[0].status).toBe("fulfilled");
    expect(settled[64].status).toBe("rejected");
    expect((settled[64] as PromiseRejectedResult).reason).toBeInstanceOf(BusyError);
  });
});

describe("P0-3 替换早退修复", () => {
  test("同 machineId 二次 register：旧连接 pending 立即结束（aborted → 读操作自动迁移重发），不悬挂至超时", async () => {
    // 替换早退修复（先 reject 再删登记）仍是本测试守护的核心；W12a 读重试契约
    // （§7.3 迁移语义）下，读操作收到 aborted 后自动以新 request_id 在新连接重发，
    // 不再直接以 aborted 结束——若早退修复被回退，旧 pending 会悬挂至 60s 超时
    // （测试 5s 超时即失败），清理时以 server shutdown 结束
    const handler = await import("../transport/file-ws-handler");
    const wsOld = openRegisteredWs(handler, "ws_old", "mach_replace");
    const oldPending = fileOpRequests.sendFileOpAndWait("mach_replace", "list", { path: "/" }).catch((e) => e);

    // 同 machineId 新连接注册 → 触发替换
    const wsNew = openRegisteredWs(handler, "ws_new", "mach_replace");

    // 替换瞬间：旧连接被关闭、索引指向新连接
    expect(wsOld.close).toHaveBeenCalledWith(1000, "replaced by new connection");
    expect(handler.isFileWsConnected("mach_replace")).toBe(true);

    // 旧 wsId 的 close 回调此时 entry 已删除（早退）也无影响：pending 已在替换时 reject
    handler.handleFileWsClose(wsOld, "ws_old");

    // 新连接上的请求正常登记（不被误伤）
    const newPending = fileOpRequests.sendFileOpAndWait("mach_replace", "list", { path: "/new" }).catch((e) => e);

    // 让出微任务：oldPending 的 aborted → 自动重试（迁移重发到新连接）先于清理执行，
    // 否则 closeAll 清空索引后重试会立即失败（No active file-ws connection）
    await Promise.resolve();
    // 清理：旧 pending（已自动重发到新连接）与新 pending 一起以 server shutdown 结束
    handler.closeAllFileWsConnections();
    expect((await oldPending) as Error).toHaveProperty("message", expect.stringContaining("server shutdown"));
    expect((await newPending) as Error).toHaveProperty("message", expect.stringContaining("server shutdown"));
    expect(wsNew.close).toHaveBeenCalled();
  });
});
