import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { NotFoundError } from "@fenix/platform-sdk";
import { stubDb } from "@fenix/platform-sdk/testing";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import { createWebFsRoutes } from "../routes/web/fs";
import {
  initializeMachineModuleConfig,
  stubFileWsTransport,
  stubMachineConfig,
  stubMachineEnvironment,
  stubMachineEnvironmentRecord,
} from "../testing";
import {
  machineFileWsIndex,
  pendingRequestCount,
  rejectAllPendingRequests,
  rejectPendingForWsId,
  removePending,
  sendFileOpAndWait,
} from "../transport/file-ws-requests";
import type { FileWsConnectionEntry, WsConnection } from "../transport/ws-types";

const ENV_ID = "env-tree-wait";
const MACHINE_ID = "mach-tree-wait";
const routes = createWebFsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });
const originalSetTimeout = globalThis.setTimeout;
let now = 0;
let waits: number[];
let onPoll: () => void;
let restoreClock: () => void;
let restoreTimers: () => void;

/** 仅推进连接轮询的 100ms 定时器，文件操作与路由的其他计时器仍使用真实时间。 */
function installPollingClock(): void {
  const clock = spyOn(performance, "now").mockImplementation(() => now);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay === 100) {
      waits.push(delay);
      now += delay;
      onPoll();
      return originalSetTimeout(handler, 0, ...args);
    }
    return originalSetTimeout(handler, delay, ...args);
  });
  restoreClock = () => clock.mockRestore();
  restoreTimers = () => timers.mockRestore();
}

/** 通过真实 Web 路由观察同一次 HTTP 请求的最终状态。 */
function request(path = "/fs/tree", init?: RequestInit): Promise<Response> {
  return routes.handle(new Request(`http://localhost/environments/${ENV_ID}${path}`, init));
}

/** 在发送边界建立连接；回执沿真实 pending 清理路径返回。 */
function connectFileWs(wsId: string, onSend?: () => boolean): string[] {
  const frames: string[] = [];
  const ws: WsConnection = {
    readyState: 1,
    close() {},
    send(data) {
      const raw = String(data);
      frames.push(raw);
      const frame = JSON.parse(raw) as { request_id: string };
      queueMicrotask(() => {
        if (onSend?.() === false) return;
        removePending(frame.request_id)?.resolve({ status: "ok", data: { paths: ["user/recovered.txt"] } });
      });
    },
  };
  const entry: FileWsConnectionEntry = { ws, wsId, machineId: MACHINE_ID, openTime: 0, lastClientActivity: 0 };
  machineFileWsIndex.set(MACHINE_ID, entry);
  return frames;
}

beforeEach(() => {
  now = 0;
  waits = [];
  onPoll = () => {};
  initializeMachineModuleConfig();
  stubMachineConfig({ defaultMachineId: MACHINE_ID });
  stubMachineEnvironmentRecord({ id: ENV_ID, organizationId: "org-tree-wait", userId: "user-tree-wait" });
  setTestAuth({
    user: { id: "user-tree-wait", email: "tree@example.test", name: "tree" },
    authContext: { organizationId: "org-tree-wait", userId: "user-tree-wait", role: "owner" },
  });
  stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }) });
  stubFileWsTransport({
    isFileWsConnected: () => machineFileWsIndex.get(MACHINE_ID)?.ws.readyState === 1,
    sendFileOpAndWait,
  });
  installPollingClock();
});

afterEach(() => {
  restoreTimers();
  restoreClock();
  rejectAllPendingRequests(new Error("test cleanup"));
  machineFileWsIndex.clear();
  resetTestAuth();
});

// 健康连接应保持即时读取，不能让正常首屏也固定等待两秒。
test("取树在连接健康时直接返回 200，不安排连接轮询", async () => {
  const frames = connectFileWs("ws-healthy");
  const response = await request();
  expect(response.status).toBe(200);
  expect(waits).toEqual([]);
  expect(frames).toHaveLength(1);
  expect(JSON.parse(frames[0])).not.toHaveProperty("connectionWaitDeadline");
  expect(pendingRequestCount()).toBe(0);
});

// 复现首屏碰到换链窗口，后端应在原 HTTP 请求内等到通道注册再返回成功。
test("文件通道在 300ms 恢复时，原取树请求返回 200", async () => {
  onPoll = () => {
    if (now === 300) connectFileWs("ws-recovered");
  };
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ success: true, data: { paths: ["user/recovered.txt"] } });
  expect(waits).toEqual([100, 100, 100]);
  expect(pendingRequestCount()).toBe(0);
});

// 持续离线不能无限等待，也不能伪装成空目录或回退到本地 workspace。
test("通道持续离线时检查至 2000ms 后返回原有 503", async () => {
  const response = await request();
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ error: { type: "file_service_unavailable" } });
  expect(now).toBe(2000);
  expect(waits).toEqual(Array(20).fill(100));
  expect(pendingRequestCount()).toBe(0);
});

// 两秒边界上的注册仍可立即放行，无须额外等待一个轮询周期。
test("通道恰好在 2000ms 就绪时取树成功", async () => {
  onPoll = () => {
    if (now === 2000) connectFileWs("ws-boundary");
  };
  expect((await request()).status).toBe(200);
  expect(now).toBe(2000);
  expect(waits).toHaveLength(20);
});

// 发送后的换链应复用既有的一次读重试，等待新连接期间不能增加机器执行次数。
test("首轮等待后发送时断连，恢复重试与首轮共用两秒预算", async () => {
  let firstFrames: string[] = [];
  let retryFrames: string[] = [];
  onPoll = () => {
    if (now === 700) {
      firstFrames = connectFileWs("ws-first", () => {
        machineFileWsIndex.delete(MACHINE_ID);
        rejectPendingForWsId("ws-first", new Error("Connection closed (wsId=ws-first)"));
        return false;
      });
    }
    if (now === 1200) retryFrames = connectFileWs("ws-retry");
  };
  expect((await request()).status).toBe(200);
  expect(now).toBe(1200);
  expect(firstFrames).toHaveLength(1);
  expect(retryFrames).toHaveLength(1);
  expect(pendingRequestCount()).toBe(0);
});

// 发送失败后的等待不能重新计算两秒，否则多次换链会使单次请求不断延长。
test("发送后断连且超过原截止时间未恢复，仍在 2000ms 返回 503", async () => {
  let frames: string[] = [];
  onPoll = () => {
    if (now === 1500) {
      frames = connectFileWs("ws-budget", () => {
        machineFileWsIndex.delete(MACHINE_ID);
        rejectPendingForWsId("ws-budget", new Error("Connection closed (wsId=ws-budget)"));
        return false;
      });
    }
  };
  expect((await request()).status).toBe(503);
  expect(now).toBe(2000);
  expect(frames).toHaveLength(1);
  expect(waits).toHaveLength(20);
  expect(pendingRequestCount()).toBe(0);
});

// 配置错误和权限拒绝无需等待连接，必须保留原错误分类与隔离边界。
test("机器配置不存在与跨组织访问均立即拒绝，不进行连接轮询", async () => {
  stubDb({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) });
  expect((await request()).status).toBe(422);
  stubMachineEnvironment({
    getOwnedEnvironment: async () => {
      throw new NotFoundError("环境不存在");
    },
  });
  expect((await request()).status).toBe(404);
  expect(waits).toEqual([]);
});

// 等待策略只属于 tree；列目录与写文件仍立即报错，写操作不得自动重发。
test("非取树操作不等待离线通道", async () => {
  expect((await request("/fs?path=user")).status).toBe(503);
  expect(
    (
      await request("/fs/user/a.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      })
    ).status,
  ).toBe(503);
  expect(waits).toEqual([]);
});

// 一次离线请求耗尽预算后不能影响后续请求，避免模块共享截止时间导致持续失败。
test("首次等待超时后，新取树请求仍拥有独立的两秒预算", async () => {
  expect((await request()).status).toBe(503);
  onPoll = () => {
    if (now === 2300) connectFileWs("ws-next-request");
  };
  expect((await request()).status).toBe(200);
  expect(now).toBe(2300);
});
