/**
 * 同 server epoch 的网络重连回归。
 *
 * 用真实 `createAcpClient`、真实 `InstanceManager` 与本地受控子进程驱动，
 * 只把 WebSocket 换成内存实现并注入本地引擎 handler（不替换任何业务实现）。
 * 覆盖重复重连后的 PID/runtimeGeneration/session 身份保持、跨 epoch clean-slate、
 * 服务端拒绝实例的严格停止，以及旧连接被 fence 后的事件隔离。
 */

import { afterEach, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec } from "@fenix/plugin-sdk";
import { type EngineHandler, InstanceManager } from "../client/instance-manager.js";
import { createAcpClient, type ServerConfig } from "../server.js";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  drop(): void {
    this.readyState = 3;
    this.onclose?.(new CloseEvent("close", { code: 1006, reason: "transient network loss" }));
  }

  message(payload: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
  }
}

const realWebSocket = globalThis.WebSocket;
const originalCleanSlate = InstanceManager.prototype.cleanSlate;

let handle: ReturnType<typeof createAcpClient> | undefined;
let child: ChildProcess | undefined;
let manager: InstanceManager | undefined;
let cleanSlateCalls = 0;
let engineStopCalls = 0;
const tempDirs: string[] = [];

afterEach(async () => {
  await handle?.close().catch(() => {});
  handle = undefined;
  InstanceManager.prototype.cleanSlate = originalCleanSlate;
  globalThis.WebSocket = realWebSocket;
  FakeWebSocket.instances = [];
  if (child?.exitCode === null) child.kill("SIGKILL");
  child = undefined;
  manager = undefined;
  cleanSlateCalls = 0;
  engineStopCalls = 0;
  for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function mainSockets(): FakeWebSocket[] {
  return FakeWebSocket.instances.filter((socket) => socket.url.includes("/acp/ws"));
}

async function until(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !predicate()) await Bun.sleep(10);
  expect(predicate()).toBe(true);
}

/** 解析客户端发出的帧；`sent` 是 JSON 字符串，测试里的对象载荷走同一入口。 */
function parseFrame(frame: unknown): Record<string, unknown> {
  return JSON.parse(typeof frame === "string" ? frame : JSON.stringify(frame)) as Record<string, unknown>;
}

/** 安装本地受控引擎：注册、重连、stop、进程生命周期都走生产实现，只替换子进程命令。 */
function installEngine(target: InstanceManager): void {
  const handler: EngineHandler = {
    async prepareWorkspace() {},
    async startInstance({ state }) {
      child = spawn(
        process.execPath,
        ["-e", "process.stdin.resume(); process.stdin.on('end',()=>process.exit(0)); setInterval(()=>{},1000);"],
        { stdio: ["pipe", "ignore", "ignore"] },
      );
      state.process = child;
      return { capabilities: {} };
    },
    async stopInstance() {
      engineStopCalls += 1;
    },
  };
  (target as unknown as { handlers: Map<string, EngineHandler> }).handlers.set("peri", handler);
}

const launchSpec: AgentLaunchSpec = {
  organizationId: "org",
  userId: "user",
  env: {},
  agent: { name: "reconnect", prompt: "" },
  model: { provider: "test", protocol: "openai", model: "test" },
  skills: [],
  mcpServers: [],
};

async function createClient(rcsUrl: string): Promise<void> {
  const cwd = await mkdtemp(join(tmpdir(), "acp-same-epoch-"));
  tempDirs.push(cwd);
  const config: ServerConfig = {
    port: 19315,
    host: "127.0.0.1",
    command: "unused-test-handler",
    args: [],
    cwd,
    rcsUrl,
    machineId: "mach-same-epoch",
    rcsSecret: "test-fixture",
    agentType: "peri",
  };
  handle = createAcpClient(config);
}

/** 首次注册 + 启动一个真实子进程，返回当前 manager 与主连接。 */
async function bootstrapRunningInstance(epoch: string): Promise<{ socket: FakeWebSocket; pid: number }> {
  // 只借用 cleanSlate 的调用时机拿到 client 内部 manager；cleanSlate 仍是生产实现。
  InstanceManager.prototype.cleanSlate = async function (this: InstanceManager) {
    manager = this;
    cleanSlateCalls += 1;
    return originalCleanSlate.call(this);
  };
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  await createClient("ws://registry.invalid");
  await until(() => mainSockets().length === 1);
  const first = mainSockets()[0];
  first.open();
  const register = parseFrame(first.sent[0]);
  expect(register.server_epoch).toBeUndefined();
  expect(register.instances).toBeUndefined();

  first.message({
    type: "registered",
    machine_id: "mach-same-epoch",
    protocol_version: 2,
    server_epoch: epoch,
    clean_slate_required: true,
  });
  await until(() => manager !== undefined);
  installEngine(manager as InstanceManager);
  await manager?.prepare("inst-running", launchSpec, "peri", 3, epoch);
  await manager?.start("inst-running", () => {});
  manager?.setSessionId("inst-running", "ses-1");
  await Bun.sleep(20);
  expect(child?.exitCode).toBeNull();
  expect(manager?.hasInstance("inst-running")).toBe(true);
  return { socket: first, pid: child?.pid ?? 0 };
}

/** 网络断开并等待生产重连调度创建下一条主连接。 */
async function reconnect(previous: FakeWebSocket): Promise<FakeWebSocket> {
  const before = mainSockets().length;
  previous.drop();
  await until(() => mainSockets().length > before);
  const next = mainSockets()[mainSockets().length - 1];
  next.open();
  return next;
}

// 同 epoch 重复重连只恢复观察：PID、runtimeGeneration、session 身份保持不变，且从未 stop 实例。
test("same-epoch reconnect preserves pid, runtime generation and session identity", async () => {
  const { socket: first, pid } = await bootstrapRunningInstance("epoch-live");
  expect(pid).toBeGreaterThan(0);

  let current = first;
  for (let attempt = 0; attempt < 2; attempt++) {
    current = await reconnect(current);
    const register = parseFrame(current.sent[0]);
    expect(register.server_epoch).toBe("epoch-live");
    const inventory = register.instances as Array<Record<string, unknown>>;
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      instance_uid: "inst-running",
      instance_id: "inst-running",
      runtime_generation: 3,
      server_epoch: "epoch-live",
      session_id: "ses-1",
      process_alive: true,
    });

    current.message({
      type: "registered",
      machine_id: "mach-same-epoch",
      protocol_version: 2,
      server_epoch: "epoch-live",
      clean_slate_required: false,
      reconcile: {
        accepted_instances: [{ instance_uid: "inst-running", runtime_generation: 3 }],
        rejected_instances: [],
      },
    });
    await until(() => current.sent.some((frame) => parseFrame(frame).type === "reconcile_confirmed"));

    expect(child?.exitCode).toBeNull();
    expect(child?.pid).toBe(pid);
    expect(engineStopCalls).toBe(0);
    expect(manager?.hasInstance("inst-running")).toBe(true);
    expect(manager?.getRuntimeFence("inst-running")).toEqual({ runtimeGeneration: 3, serverEpoch: "epoch-live" });
    expect(manager?.getSessionId("inst-running")).toBe("ses-1");
  }

  // 旧连接的迟到帧不能影响新 owner：即使携带 clean-slate 也必须被忽略。
  const cleanSlateCallsBeforeStaleFrame = cleanSlateCalls;
  first.message({
    type: "registered",
    machine_id: "mach-same-epoch",
    protocol_version: 2,
    server_epoch: "epoch-live",
    clean_slate_required: true,
  });
  await Bun.sleep(20);
  expect(cleanSlateCalls).toBe(cleanSlateCallsBeforeStaleFrame);
  expect(child?.exitCode).toBeNull();
  expect(engineStopCalls).toBe(0);

  // 恢复后显式 stop 仍按原 fence 生效。
  await manager?.stop("inst-running", 3, "epoch-live");
  expect(engineStopCalls).toBe(1);
  expect(manager?.hasInstance("inst-running")).toBe(false);
});

// 服务端换 epoch 后不得继承旧 runtime：仍走 clean-slate 并停止全部实例。
test("cross-epoch reconnect still performs clean slate and stops the running instance", async () => {
  const { socket: first } = await bootstrapRunningInstance("epoch-old");
  const next = await reconnect(first);
  const register = parseFrame(next.sent[0]);
  expect(register.server_epoch).toBe("epoch-old");

  next.message({
    type: "registered",
    machine_id: "mach-same-epoch",
    protocol_version: 2,
    server_epoch: "epoch-new",
    clean_slate_required: true,
  });

  await until(() => engineStopCalls === 1);
  await until(() => manager?.hasInstance("inst-running") === false);
  expect(cleanSlateCalls).toBe(2);
  expect(child?.exitCode).not.toBeNull();
  expect(manager?.getRuntimeFence("inst-running")).toBeNull();
});

// 主服务拒绝归属的实例必须严格停止，不能因为「同 epoch」而留在本机成为孤儿进程。
test("reconcile rejection stops the unowned instance", async () => {
  const { socket: first } = await bootstrapRunningInstance("epoch-live");
  const next = await reconnect(first);
  next.message({
    type: "registered",
    machine_id: "mach-same-epoch",
    protocol_version: 2,
    server_epoch: "epoch-live",
    clean_slate_required: false,
    reconcile: {
      accepted_instances: [],
      rejected_instances: [{ instance_uid: "inst-running", reason: "runtime_missing" }],
    },
  });

  await until(() => next.sent.some((frame) => parseFrame(frame).type === "reconcile_confirmed"));
  const confirmation = next.sent.map(parseFrame).find((frame) => frame.type === "reconcile_confirmed");
  expect(confirmation?.instances).toEqual([]);
  expect(engineStopCalls).toBe(1);
  expect(child?.exitCode).not.toBeNull();
  expect(manager?.hasInstance("inst-running")).toBe(false);
});
