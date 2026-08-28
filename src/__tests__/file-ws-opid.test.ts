import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import type { WsConnection } from "../transport/ws-types";

// W12a（P2-15 帧侧 + P2-18）：op_id 幂等帧 / 读重试矩阵 / 机器级熔断 / 审计字段。
// file-ws-handler 未被 setup-mocks preload mock（仅 isFileWsConnected / sendFileOpAndWait
// 可 stub，未配置时回退真实实现），本测试动态 import 后使用真实实现；
// 重试/熔断逻辑在 file-op-retry（handler 的编排入口），熔断时钟经 setFileOpCircuitClock
// 注入以便推进 30s 熔断期。模块级状态在 beforeEach 通过 closeAllFileWsConnections
// （含熔断状态清理）与 resetFileOpCircuitClock 隔离。

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

interface FileOpFrame {
  type: "file_op";
  request_id: string;
  operation: string;
  params: Record<string, unknown>;
  op_id?: string;
  actor_id?: string;
  source?: string;
}

/** 从发送帧中解析全部 file_op 帧（按发送顺序） */
function parseFileOpFrames(ws: WsConnection & { _messages: string[] }): FileOpFrame[] {
  return ws._messages.map((line) => JSON.parse(line) as FileOpFrame).filter((m) => m.type === "file_op");
}

beforeEach(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
  const retry = await import("../transport/file-op-retry");
  retry.resetFileOpCircuitClock();
  retry.resetFileOpCircuitStates();
});

afterAll(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
  const retry = await import("../transport/file-op-retry");
  retry.resetFileOpCircuitClock();
});

describe("§7.2 帧协议扩展（op_id / actor_id / source）", () => {
  test("写操作帧注入 op_id / actor_id / source，回执正常 resolve", async () => {
    // P2-18 审计字段 + 幂等键必须出现在写操作帧上；机器端回执后正常返回结果
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_opid_w", "mach_opid_w");

    const pending = fileOpRequests.sendFileOpAndWait(
      "mach_opid_w",
      "write",
      { path: "/a.txt", content: "x", environmentId: "env-opid-w" },
      undefined,
      { opId: "op-w-1", actorId: "user-1", source: "user" },
    );

    const frames = parseFileOpFrames(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      operation: "write",
      op_id: "op-w-1",
      actor_id: "user-1",
      source: "user",
    });

    handler.handleFileWsMessage(ws, "ws_opid_w", {
      type: "file_op_result",
      request_id: frames[0].request_id,
      status: "ok",
      data: { size: 1 },
    });
    await expect(pending).resolves.toEqual({ status: "ok", data: { size: 1 } });
  });

  test("不传 options 时帧与现状完全一致（无 op_id/actor_id/source，向后兼容）", async () => {
    // W16 等现有调用不传第 5 参数：帧必须不出现新字段，保证向后兼容
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_opid_legacy", "mach_opid_legacy");

    const pending = fileOpRequests.sendFileOpAndWait("mach_opid_legacy", "write", {
      path: "/a.txt",
      content: "x",
      environmentId: "env-opid-legacy",
    });

    const frames = parseFileOpFrames(ws);
    expect(frames).toHaveLength(1);
    expect(frames[0]).not.toHaveProperty("op_id");
    expect(frames[0]).not.toHaveProperty("actor_id");
    expect(frames[0]).not.toHaveProperty("source");
    handler.closeAllFileWsConnections();
    await pending.catch(() => {});
  });
});

describe("§7.2 读重试矩阵", () => {
  test("读操作 timeout 后自动重发一次：新 request_id 复用 op_id", async () => {
    // 读操作超时视为可恢复：自动重试 1 次（总执行 ≤2 次），重试帧复用 op_id 供机器端去重
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_opid_r", "mach_opid_r");

    const pending = fileOpRequests.sendFileOpAndWait(
      "mach_opid_r",
      "read",
      { path: "/a.txt", environmentId: "env-opid-r" },
      30,
      { opId: "op-r-1" },
    );
    await expect(pending).rejects.toThrow("file_op timeout");

    const frames = parseFileOpFrames(ws);
    expect(frames).toHaveLength(2);
    expect(frames[0].op_id).toBe("op-r-1");
    expect(frames[1].op_id).toBe("op-r-1");
    expect(frames[0].request_id).not.toBe(frames[1].request_id);
  });

  test("写操作 timeout 不自动重试（只发一帧，调用方带 op_id 重发幂等）", async () => {
    // 写操作超时直接失败返回：自动重试会放大"已执行但结果丢失"的重复写风险，
    // 重发由调用方决策（§7.3：写操作直接失败，调用方重发时幂等去重）
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_opid_wt", "mach_opid_wt");

    const pending = fileOpRequests.sendFileOpAndWait(
      "mach_opid_wt",
      "write",
      { path: "/a.txt", content: "x", environmentId: "env-opid-wt" },
      30,
      { opId: "op-w-t" },
    );
    await expect(pending).rejects.toThrow("file_op timeout");
    expect(parseFileOpFrames(ws)).toHaveLength(1);
  });

  test("busy 不重试：背压拒绝直接返回 BusyError，且不发帧", async () => {
    // busy 是瞬时容量问题（429 语义）：重试必然再次 busy，直接抛 BusyError 供上层退避
    const handler = await import("../transport/file-ws-handler");
    const { BusyError } = fileOpRequests;
    const ws = openRegisteredWs(handler, "ws_opid_busy", "mach_opid_busy");

    const requests: Promise<unknown>[] = [];
    for (let i = 0; i < 65; i++) {
      requests.push(fileOpRequests.sendFileOpAndWait("mach_opid_busy", "read", { path: `/f${i}` }));
    }

    const err = await requests[64].catch((e) => e);
    expect(err).toBeInstanceOf(BusyError);
    expect(err).toHaveProperty("code", "busy");
    // 第 65 个请求在发送前被拒，帧数保持 64（不重试、不登记）
    expect(parseFileOpFrames(ws)).toHaveLength(64);
    handler.closeAllFileWsConnections();
    await Promise.allSettled(requests);
  });

  test("机器端 status:error 不重试：直接返回执行错误，并视为机器存活信号", async () => {
    // 机器端正常回执执行错误（EACCES 等）说明机器活着：不重试，且熔断计数被重置
    const handler = await import("../transport/file-ws-handler");
    const ws = openRegisteredWs(handler, "ws_opid_err", "mach_opid_err");

    const pending = fileOpRequests.sendFileOpAndWait(
      "mach_opid_err",
      "read",
      { path: "/secret", environmentId: "env-opid-err" },
      200,
      { opId: "op-r-err" },
    );
    const frames = parseFileOpFrames(ws);
    expect(frames).toHaveLength(1);

    handler.handleFileWsMessage(ws, "ws_opid_err", {
      type: "file_op_result",
      request_id: frames[0].request_id,
      status: "error",
      error: "EACCES: /secret",
    });

    const result = await pending;
    expect(result).toEqual({ status: "error", error: "EACCES: /secret" });
    expect(parseFileOpFrames(ws)).toHaveLength(1);
  });
});

describe("§7.2 机器级熔断器", () => {
  test("连续 3 次超时 → 熔断 30s：熔断期内快速失败 CircuitOpenError，不发帧；到期恢复", async () => {
    // 僵尸机器连续 3 次 timeout 后熔断：后续请求立即快速失败（503 语义），
    // 不再占用全局 pending 槽位；30s 后自动关闭允许试探
    const handler = await import("../transport/file-ws-handler");
    const retry = await import("../transport/file-op-retry");
    const clock = { now: Date.now() };
    retry.setFileOpCircuitClock(() => clock.now);

    const ws = openRegisteredWs(handler, "ws_opid_c", "mach_opid_c");
    for (let i = 0; i < 3; i++) {
      await expect(
        fileOpRequests.sendFileOpAndWait("mach_opid_c", "read", { path: `/x${i}`, environmentId: "env-opid-c" }, 10),
      ).rejects.toThrow("file_op timeout");
    }

    // 熔断已打开：状态记录到期时间（now + 30s）
    const state = retry.getFileOpCircuitState("mach_opid_c");
    expect(state?.openUntil ?? 0).toBeGreaterThan(clock.now);

    // 熔断期内请求快速失败：不发帧、不等待超时
    const framesBefore = parseFileOpFrames(ws).length;
    const err = await fileOpRequests
      .sendFileOpAndWait("mach_opid_c", "read", { path: "/y", environmentId: "env-opid-c" }, 10_000)
      .catch((e) => e);
    expect(err).toBeInstanceOf(retry.CircuitOpenError);
    expect(err).toHaveProperty("code", "circuit_open");
    expect(parseFileOpFrames(ws)).toHaveLength(framesBefore);

    // 时钟推进 31s → 熔断到期自动关闭，请求恢复发送（新失败重新积累计数）
    clock.now += 31_000;
    const resumed = fileOpRequests.sendFileOpAndWait(
      "mach_opid_c",
      "read",
      { path: "/z", environmentId: "env-opid-c" },
      10,
    );
    await expect(resumed).rejects.toThrow("file_op timeout");
    expect(parseFileOpFrames(ws).length).toBeGreaterThan(framesBefore);
  });

  test("中途成功重置连续失败计数：失败-成功-再失败不会触发熔断", async () => {
    // 成功（含机器端 status:error 回执）是机器存活的证据：连续失败计数必须重置，
    // 否则历史失败会累计误熔断健康机器
    const handler = await import("../transport/file-ws-handler");
    const retry = await import("../transport/file-op-retry");
    const ws = openRegisteredWs(handler, "ws_opid_reset", "mach_opid_reset");

    // 第一次：超时失败（计数 1）
    await expect(
      fileOpRequests.sendFileOpAndWait("mach_opid_reset", "read", { path: "/a", environmentId: "env-opid-reset" }, 10),
    ).rejects.toThrow("file_op timeout");

    // 第二次：成功回执（计数重置）
    const p2 = fileOpRequests.sendFileOpAndWait(
      "mach_opid_reset",
      "read",
      { path: "/b", environmentId: "env-opid-reset" },
      200,
    );
    const frames = parseFileOpFrames(ws);
    handler.handleFileWsMessage(ws, "ws_opid_reset", {
      type: "file_op_result",
      request_id: frames[frames.length - 1].request_id,
      status: "ok",
      data: { content: "ok" },
    });
    await expect(p2).resolves.toEqual({ status: "ok", data: { content: "ok" } });

    // 第三次、第四次：连续失败（计数重新从 1 → 2），未达阈值 3，不熔断
    for (let i = 0; i < 2; i++) {
      await expect(
        fileOpRequests.sendFileOpAndWait(
          "mach_opid_reset",
          "read",
          { path: `/c${i}`, environmentId: "env-opid-reset" },
          10,
        ),
      ).rejects.toThrow("file_op timeout");
    }
    const state = retry.getFileOpCircuitState("mach_opid_reset");
    expect(state?.consecutiveFailures).toBe(2);
    expect(state?.openUntil ?? 0).toBe(0);
  });
});
