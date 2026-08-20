import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { gate } from "../services/agent-file-service";
import { flushPendingBatches } from "../services/file-event-limiter";
import { destroyEnvironmentQueue, type FileEventFrame, subscribe } from "../services/file-event-queue";
import { type FileAuthContext } from "../services/file-types";
import { resetAllStubs, stubEnvironmentRepo, stubRegistry } from "../test-utils/helpers";
import type { WsConnection } from "../transport/ws-types";

// sendFileOpAndWait 属请求发送域（自 handler 拆至 file-ws-requests，setup-mocks 部分
// mock——未配置 stub 时回退真实实现），此处动态 import 触发记账
const fileOpRequests = await import("../transport/file-ws-requests");

// file-ws-handler 由 setup-mocks preload 部分 mock（仅 isFileWsConnected /
// sendFileOpAndWait 可 stub，未配置时回退真实实现），本测试动态 import 后直接使用
// 真实的事件接收逻辑；registry 的 writeRegistryEvent 经 stubRegistry 配置断言告警落库。
// 模块级状态（连接 / 环境集 / 限频窗口）在 beforeEach 通过 closeAllFileWsConnections
// 清理；限频器（file-event-limiter）的窗口按注入时间或真实时间自动重置，
// 各用例使用唯一 envId/machineId 避免跨用例窗口污染。

const ORG_ID = "org-1";
const USER_ID = "user-1";

const authCtx: FileAuthContext = {
  organizationId: ORG_ID,
  userId: USER_ID,
  role: "owner",
  actorId: USER_ID,
  source: "user",
};

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

/** 建立一条已注册的 file-ws 连接（open + register），可携带 environments 声明 */
function openRegisteredWs(
  handler: typeof import("../transport/file-ws-handler"),
  wsId: string,
  machineId: string,
  environments?: string[],
): WsConnection & { _messages: string[] } {
  const ws = createMockWs();
  handler.handleFileWsOpen(ws, wsId);
  const register: Record<string, unknown> = { type: "register", machine_id: machineId };
  if (environments) {
    register.environments = environments;
  }
  handler.handleFileWsMessage(ws, wsId, register);
  return ws;
}

/** 等待队列微任务 flush 与限频器 batch 延迟 flush 完成 */
async function flushEvents() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** 测试期间创建的环境队列（afterEach 销毁） */
const cleanups: string[] = [];
/** 测试期间创建的 tmp workspace 目录（afterEach 删除） */
const tmpDirs: string[] = [];

beforeEach(async () => {
  resetAllStubs();
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

afterEach(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
  for (const envId of cleanups.splice(0)) {
    destroyEnvironmentQueue(envId);
  }
  for (const dir of tmpDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  delete process.env.WORKSPACE_ROOT;
  setConfig({ defaultMachineId: undefined });
});

afterAll(async () => {
  const handler = await import("../transport/file-ws-handler");
  handler.closeAllFileWsConnections();
});

describe("file-ws 事件接收（W7，§7.5）", () => {
  // 机器端 file_changed 帧：声明环境内的变更应发布到事件队列，source 原样透传
  test("file_changed 帧发布到队列（声明环境内）", async () => {
    const handler = await import("../transport/file-ws-handler");
    const envId = "evt-env-1";
    cleanups.push(envId);
    openRegisteredWs(handler, "ws_evt", "mach_evt", [envId]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));

    handler.handleFileWsMessage(createMockWs(), "ws_evt", {
      type: "file_changed",
      environment_id: envId,
      path: "user/a.txt",
      kind: "write",
      source: "agent",
      actor_id: "inst-1",
    });
    await flushEvents();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "file_changed",
      environment_id: envId,
      path: "user/a.txt",
      kind: "write",
      source: "agent",
      actor_id: "inst-1",
    });
    unsub();
  });

  // 忽略依赖与构建目录：这些路径不进入限频器或订阅流，避免事件风暴触发文件树全量刷新
  test("忽略 node_modules、.git 与构建产物目录的单帧和批量事件", async () => {
    const handler = await import("../transport/file-ws-handler");
    const envId = "evt-env-ignored-paths";
    cleanups.push(envId);
    openRegisteredWs(handler, "ws_ignored", "mach_ignored", [envId]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));

    handler.handleFileWsMessage(createMockWs(), "ws_ignored", {
      type: "file_changed",
      environment_id: envId,
      path: "packages/app/node_modules/react/index.js",
      kind: "write",
      source: "agent",
    });
    handler.handleFileWsMessage(createMockWs(), "ws_ignored", {
      type: "file_changed_batch",
      environment_id: envId,
      changes: [
        { path: ".git/index", kind: "write", source: "agent" },
        { path: "web/dist/assets/app.js", kind: "write", source: "agent" },
        { path: "apps/site/.next/cache/data", kind: "write", source: "agent" },
        { path: "packages\\api\\coverage\\report.json", kind: "write", source: "agent" },
        { path: "src/keep.ts", kind: "write", source: "agent" },
      ],
    });
    await flushEvents();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ environment_id: envId, path: "src/keep.ts" });
    unsub();
  });

  // 突发合并（D20 修复）：1s 窗口内连发 50 条，仅前 20 条逐条下发，
  // 其余 30 条合并为一条 file_changed_batch（增量语义），绝不允许退化为 invalidate_all
  test("连发 50 事件合并为 batch 而非全量失效", async () => {
    const handler = await import("../transport/file-ws-handler");
    const envId = "evt-env-burst";
    cleanups.push(envId);
    openRegisteredWs(handler, "ws_burst", "mach_burst", [envId]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));

    for (let i = 0; i < 50; i++) {
      handler.handleFileWsMessage(createMockWs(), "ws_burst", {
        type: "file_changed",
        environment_id: envId,
        path: `user/f-${i}.txt`,
        kind: "write",
        source: "agent",
      });
    }
    await flushEvents();
    // 根治 flaky：显式注入 batch flush（限频器导出），替代依赖 250ms 定时器真实
    // 触发的轮询等待——全量测试并发负载下定时器可能滞后，固定/轮询等待均不可靠
    flushPendingBatches(envId);
    await flushEvents();

    expect(frames.filter((f) => f.type === "file_changed")).toHaveLength(20);
    const batches = frames.filter((f) => f.type === "file_changed_batch");
    expect(batches).toHaveLength(1);
    if (batches[0]?.type === "file_changed_batch") {
      expect(batches[0].changes).toHaveLength(30);
    }
    // 关键断言：突发绝不退化为 invalidate_all（D20 语义倒挂修复）
    expect(frames.some((f) => f.type === "invalidate_all")).toBe(false);
    unsub();
  });

  // 未声明环境：严格模式下必须丢弃事件并落库 registryEvent 告警，不静默
  test("未声明环境的事件被丢弃并写 registryEvent 告警", async () => {
    const registryEventSpy = mock(async () => {});
    stubRegistry({ writeRegistryEvent: registryEventSpy });
    const handler = await import("../transport/file-ws-handler");
    const declaredEnv = "evt-env-declared";
    cleanups.push(declaredEnv);
    openRegisteredWs(handler, "ws_rej", "mach_rej", [declaredEnv]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(declaredEnv, (f) => frames.push(f));

    handler.handleFileWsMessage(createMockWs(), "ws_rej", {
      type: "file_changed",
      environment_id: "evt-env-other",
      path: "user/x.txt",
      kind: "write",
      source: "agent",
    });
    await flushEvents();

    expect(frames).toHaveLength(0);
    // W11 起 register 宽松放行也落 registryEvent（unknown_machine_lenient，测试环境无 core node），
    // 事件拒绝告警为其中一条；按类型定位断言，不依赖调用顺序
    expect(registryEventSpy).toHaveBeenCalledTimes(2);
    const rejectionCall = registryEventSpy.mock.calls.find(
      (call: unknown[]) => call[1] === "file_changed_environment_rejected",
    ) as unknown as [string, string, Record<string, unknown>] | undefined;
    expect(rejectionCall).toBeDefined();
    expect(rejectionCall?.[0]).toBe("mach_rej");
    expect(rejectionCall?.[2]).toEqual({ environment_id: "evt-env-other" });
    unsub();
  });

  // 旧机器端 register 无 environments：宽松模式放行事件（兼容过渡），且不写拒绝告警
  test("register 无 environments 宽松放行且不告警", async () => {
    const registryEventSpy = mock(async () => {});
    stubRegistry({ writeRegistryEvent: registryEventSpy });
    const handler = await import("../transport/file-ws-handler");
    const envId = "evt-env-lenient";
    cleanups.push(envId);
    openRegisteredWs(handler, "ws_len", "mach_len");
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));

    handler.handleFileWsMessage(createMockWs(), "ws_len", {
      type: "file_changed",
      environment_id: envId,
      path: "user/y.txt",
      kind: "write",
      source: "agent",
    });
    await flushEvents();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ environment_id: envId, path: "user/y.txt" });
    // 事件放行，不得出现"事件被拒绝"类告警；W11 起 register 宽松放行自身会落一条
    // unknown_machine_lenient（测试环境无 core node），不属于事件拒绝告警
    const rejected = registryEventSpy.mock.calls.some(
      (call: unknown[]) => call[1] === "file_changed_environment_rejected",
    );
    expect(rejected).toBe(false);
    unsub();
  });

  // file_op 记账：声明 env-a 后 file_op 首现 env-b → 记账登记 → env-b 事件放行
  test("file_op 首现环境记账后事件放行（声明与记账合并为权威集）", async () => {
    const handler = await import("../transport/file-ws-handler");
    const envA = "evt-env-acct-a";
    const envB = "evt-env-acct-b";
    cleanups.push(envA, envB);
    openRegisteredWs(handler, "ws_acct", "mach_acct", [envA]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envB, (f) => frames.push(f));

    // 发送 file_op（mock ws 不回执，pending 悬挂；记账在登记 pending 前同步完成）
    fileOpRequests.sendFileOpAndWait("mach_acct", "list", { path: "/", environmentId: envB }).catch(() => {});
    handler.handleFileWsMessage(createMockWs(), "ws_acct", {
      type: "file_changed",
      environment_id: envB,
      path: "user/z.txt",
      kind: "write",
      source: "agent",
    });
    await flushEvents();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ environment_id: envB, path: "user/z.txt" });
    unsub();
  });

  // environment_declared 增量声明：后续该环境事件放行（跨仓库协议扩展的服务端侧）
  test("environment_declared 增量声明后事件放行", async () => {
    const handler = await import("../transport/file-ws-handler");
    const envA = "evt-env-inc-a";
    const envB = "evt-env-inc-b";
    cleanups.push(envA, envB);
    openRegisteredWs(handler, "ws_inc", "mach_inc", [envA]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envB, (f) => frames.push(f));

    handler.handleFileWsMessage(createMockWs(), "ws_inc", {
      type: "environment_declared",
      environments: [envB],
    });
    handler.handleFileWsMessage(createMockWs(), "ws_inc", {
      type: "file_changed",
      environment_id: envB,
      path: "user/w.txt",
      kind: "write",
      source: "agent",
    });
    await flushEvents();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ environment_id: envB, path: "user/w.txt" });
    unsub();
  });

  // 机器端 file_changed_batch 帧：整帧环境校验后逐条走同一限频器
  test("file_changed_batch 帧逐条发布", async () => {
    const handler = await import("../transport/file-ws-handler");
    const envId = "evt-env-batch-in";
    cleanups.push(envId);
    openRegisteredWs(handler, "ws_bin", "mach_bin", [envId]);
    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));

    handler.handleFileWsMessage(createMockWs(), "ws_bin", {
      type: "file_changed_batch",
      environment_id: envId,
      changes: [
        { path: "user/b1.txt", kind: "write", source: "agent" },
        { path: "user/b2.txt", kind: "delete", source: "agent" },
      ],
    });
    await flushEvents();

    expect(frames.filter((f) => f.type === "file_changed")).toHaveLength(2);
    unsub();
  });
});

describe("register 广播 invalidate_all（W7，§7.3 治理三件套）", () => {
  // 抖动归零后，register 声明环境的失效帧应在广播后到达订阅队列
  test("register 成功后广播声明环境的 invalidate_all", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const handler = await import("../transport/file-ws-handler");
      const envId = "evt-env-inv-1";
      cleanups.push(envId);
      const frames: FileEventFrame[] = [];
      const unsub = subscribe(envId, (f) => frames.push(f));

      openRegisteredWs(handler, "ws_inv", "mach_inv", [envId]);
      await flushEvents();

      expect(frames.some((f) => f.type === "invalidate_all" && f.environment_id === envId)).toBe(true);
      unsub();
    } finally {
      Math.random = originalRandom;
    }
  });

  // 机器级限频 ≤2 条/s：同 1s 窗口内第 3 次 register 广播被合并跳过
  test("机器级 invalidate_all 限频 2 条/s，超限广播被跳过", async () => {
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
      const handler = await import("../transport/file-ws-handler");
      const envA = "evt-env-inv-a";
      const envB = "evt-env-inv-b";
      const envC = "evt-env-inv-c";
      cleanups.push(envA, envB, envC);
      const framesA: FileEventFrame[] = [];
      const framesB: FileEventFrame[] = [];
      const framesC: FileEventFrame[] = [];
      const unsubA = subscribe(envA, (f) => framesA.push(f));
      const unsubB = subscribe(envB, (f) => framesB.push(f));
      const unsubC = subscribe(envC, (f) => framesC.push(f));

      // 连续三次 register（同机器替换连接），第 3 次落在同一 1s 限频窗口内
      openRegisteredWs(handler, "ws_l1", "mach_limit", [envA]);
      openRegisteredWs(handler, "ws_l2", "mach_limit", [envB]);
      openRegisteredWs(handler, "ws_l3", "mach_limit", [envC]);
      await flushEvents();

      expect(framesA.some((f) => f.type === "invalidate_all")).toBe(true);
      expect(framesB.some((f) => f.type === "invalidate_all")).toBe(true);
      // 第 3 次被机器级限频合并，env-c 不应收到失效帧
      expect(framesC.some((f) => f.type === "invalidate_all")).toBe(false);
      unsubA();
      unsubB();
      unsubC();
    } finally {
      Math.random = originalRandom;
    }
  });
});

describe("本地写路径事件发布（W7，§4.3）", () => {
  // 本地写操作成功（source 由认证上下文注入）必须走同一限频合并器发布，不得跳过
  test("本地 service 写操作发布 source:user 事件", async () => {
    const envId = "evt-env-local";
    cleanups.push(envId);
    stubEnvironmentRepo({
      getById: async () => ({ id: envId, organizationId: ORG_ID, userId: USER_ID }),
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "file-ws-events-"));
    tmpDirs.push(workspaceRoot);
    process.env.WORKSPACE_ROOT = workspaceRoot;
    setConfig({ defaultMachineId: undefined });

    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));
    const fs = gate(envId, authCtx);

    await fs.write("user/x.txt", "hi");
    await flushEvents();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: "file_changed",
      environment_id: envId,
      path: "user/x.txt",
      kind: "write",
      source: "user",
      actor_id: USER_ID,
    });
    unsub();
  });

  // rename 事件的 to 字段应携带目标路径（契约字段，供订阅方局部更新）
  test("本地 rename 发布带 to 字段的事件", async () => {
    const envId = "evt-env-local-rename";
    cleanups.push(envId);
    stubEnvironmentRepo({
      getById: async () => ({ id: envId, organizationId: ORG_ID, userId: USER_ID }),
    });
    const workspaceRoot = await mkdtemp(join(tmpdir(), "file-ws-events-"));
    tmpDirs.push(workspaceRoot);
    process.env.WORKSPACE_ROOT = workspaceRoot;
    setConfig({ defaultMachineId: undefined });

    const frames: FileEventFrame[] = [];
    const unsub = subscribe(envId, (f) => frames.push(f));
    const fs = gate(envId, authCtx);

    await fs.write("user/old.txt", "x");
    await fs.rename("user/old.txt", "user/new.txt");
    await flushEvents();

    const renameFrame = frames.find((f) => f.type === "file_changed" && "kind" in f && f.kind === "rename");
    expect(renameFrame).toMatchObject({ type: "file_changed", path: "user/old.txt", to: "user/new.txt" });
    unsub();
  });
});
