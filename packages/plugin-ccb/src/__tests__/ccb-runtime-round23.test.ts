import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentLaunchSpec, EngineRelayHandle } from "@fenix/plugin-sdk";
import type { AcpLinkProcessManager, ManagedAcpLinkProcess } from "../process/acp-link-process-manager";
import type { PortAllocator } from "../process/port-allocator";
import { type CcbRuntimeDependencies, createCcbRuntime, type RuntimeInstanceState } from "../runtime/ccb-runtime";

const workspaceRoot = join(tmpdir(), `ccb-runtime-round23-${process.pid}`);
let previousWorkspaceRoot: string | undefined;

beforeEach(() => {
  previousWorkspaceRoot = process.env.WORKSPACE_ROOT;
  process.env.WORKSPACE_ROOT = workspaceRoot;
});

afterEach(async () => {
  if (previousWorkspaceRoot === undefined) {
    delete process.env.WORKSPACE_ROOT;
  } else {
    process.env.WORKSPACE_ROOT = previousWorkspaceRoot;
  }
  await rm(workspaceRoot, { recursive: true, force: true });
});

function launchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "round23-org",
    userId: "round23-user",
    environmentId: "round23-env",
    env: { FEATURE: "enabled" },
    agent: { name: "round23-agent", prompt: "test prompt" },
    model: {
      provider: "test",
      protocol: "openai",
      baseUrl: "https://example.test",
      apiKey: "test-key",
      model: "test-model",
    },
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

type RuntimeFakes = {
  dependencies: CcbRuntimeDependencies;
  allocated: number[];
  released: number[];
  starts: string[];
  stops: string[];
  prepared: string[];
};

function createFakes(overrides: Partial<CcbRuntimeDependencies> = {}): RuntimeFakes {
  const allocated: number[] = [];
  const released: number[] = [];
  const starts: string[] = [];
  const stops: string[] = [];
  const prepared: string[] = [];
  let nextPort = 9400;
  const portAllocator = {
    allocate: async () => {
      const port = nextPort;
      nextPort += 1;
      allocated.push(port);
      return port;
    },
    release: (port: number) => released.push(port),
  } as unknown as PortAllocator;
  const processManager = {
    start: async ({ instanceId, port }: { instanceId: string; port: number }): Promise<ManagedAcpLinkProcess> => {
      starts.push(instanceId);
      return { instanceId, port, token: `token-${instanceId}`, status: "running" };
    },
    stop: async (instanceId: string) => stops.push(instanceId),
  } as unknown as AcpLinkProcessManager;

  return {
    allocated,
    released,
    starts,
    stops,
    prepared,
    dependencies: {
      accessWorkspace: async () => {},
      installSkills: async () => [],
      buildRuntimeConfig: () => ({ env: { CONFIGURED: "yes" } }),
      prepareWorkspaceEnvironment: async (workspace) => prepared.push(workspace),
      portAllocator,
      processManager,
      ...overrides,
    },
  };
}

function openRelay(onClose?: () => void): EngineRelayHandle {
  let state: "open" | "closed" = "open";
  return {
    get state() {
      return state;
    },
    send: () => {},
    close: () => {
      state = "closed";
      onClose?.();
    },
  };
}

async function prepare(runtime: ReturnType<typeof createCcbRuntime>, instanceId = "instance"): Promise<void> {
  await runtime.prepareEnvironment({ instanceId, launchSpec: launchSpec({ environmentId: `env-${instanceId}` }) });
}

async function start(runtime: ReturnType<typeof createCcbRuntime>, instanceId = "instance"): Promise<void> {
  await prepare(runtime, instanceId);
  await runtime.startInstance({ instanceId });
}

describe("ccb-runtime 注入式生命周期", () => {
  // 未 prepare 的实例不允许启动，避免无 workspace 的进程资源泄漏。
  test("拒绝在 prepare 前启动", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await expect(runtime.startInstance({ instanceId: "missing" })).rejects.toThrow("must be prepared");
  });

  // prepare 使用内存依赖后记录 prepared 状态和配置快照。
  test("prepare 保存状态和配置", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    await prepare(runtime);
    const state = runtime.getInstanceState("instance");
    expect(state?.status).toBe("prepared");
    expect(state?.runtimeConfig).toEqual({ env: { CONFIGURED: "yes" } });
    expect(fakes.prepared).toHaveLength(1);
  });

  // prepare 复制 env，调用方后续修改不污染已保存的实例状态。
  test("prepare 隔离 launchSpec env 副本", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    const spec = launchSpec({ environmentId: "env-copy", env: { ORIGINAL: "yes" } });
    await runtime.prepareEnvironment({ instanceId: "copy", launchSpec: spec });
    spec.env!.ORIGINAL = "changed";
    expect(runtime.getInstanceState("copy")?.env).toEqual({ ORIGINAL: "yes" });
  });

  // prepare 支持缺省 env，并将其归一化为空对象。
  test("prepare 将缺省 env 归一化", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await runtime.prepareEnvironment({
      instanceId: "empty-env",
      launchSpec: launchSpec({ environmentId: "empty-env", env: undefined }),
    });
    expect(runtime.getInstanceState("empty-env")?.env).toEqual({});
  });

  // environmentId 参与 workspace 隔离，两个实例不会复用目录状态。
  test("prepare 为不同环境生成隔离 workspace", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await runtime.prepareEnvironment({ instanceId: "one", launchSpec: launchSpec({ environmentId: "one" }) });
    await runtime.prepareEnvironment({ instanceId: "two", launchSpec: launchSpec({ environmentId: "two" }) });
    expect(runtime.getInstanceState("one")?.workspace).not.toBe(runtime.getInstanceState("two")?.workspace);
  });

  // 无 environmentId 时 workspace 退回到组织和用户层级。
  test("prepare 在缺少 environmentId 时使用用户 workspace", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await runtime.prepareEnvironment({ instanceId: "no-env", launchSpec: launchSpec({ environmentId: undefined }) });
    expect(runtime.getInstanceState("no-env")?.workspace).toMatch(/round23-org[/\\]round23-user$/);
  });

  // 注入 prepare 钩子失败时保留错误文本，供上层诊断。
  test("prepare 钩子失败标记 error", async () => {
    const fakes = createFakes({ prepareEnvironment: async () => Promise.reject(new Error("prepare failed")) });
    const runtime = createCcbRuntime(fakes.dependencies);
    await expect(prepare(runtime, "prepare-error")).rejects.toThrow("prepare failed");
    expect(runtime.getInstanceState("prepare-error")?.status).toBe("error");
    expect(runtime.getInstanceState("prepare-error")?.error).toBe("prepare failed");
  });

  // 已运行实例重新 prepare 失败时必须保留 running 状态。
  test("运行中 prepare 失败不丢失运行状态", async () => {
    let shouldFail = false;
    const fakes = createFakes({
      prepareEnvironment: async () => shouldFail && Promise.reject(new Error("refresh failed")),
    });
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime, "refresh");
    shouldFail = true;
    await expect(prepare(runtime, "refresh")).rejects.toThrow("refresh failed");
    expect(runtime.getInstanceState("refresh")?.status).toBe("running");
  });

  // start 分配端口并把 fake 进程信息保存到实例状态。
  test("start 分配端口并保存进程", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime);
    const state = runtime.getInstanceState("instance");
    expect(state?.status).toBe("running");
    expect(state?.port).toBe(9400);
    expect(state?.token).toBe("token-instance");
    expect(fakes.starts).toEqual(["instance"]);
  });

  // 重复 start 必须复用已运行实例，不重复申请端口或创建进程。
  test("重复 start 保持幂等", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime);
    await runtime.startInstance({ instanceId: "instance" });
    expect(fakes.allocated).toEqual([9400]);
    expect(fakes.starts).toEqual(["instance"]);
  });

  // start 后钩子失败时释放已分配端口并清理进程状态。
  test("start 钩子失败释放资源", async () => {
    const fakes = createFakes({ startInstance: async () => Promise.reject(new Error("start hook failed")) });
    const runtime = createCcbRuntime(fakes.dependencies);
    await prepare(runtime);
    await expect(runtime.startInstance({ instanceId: "instance" })).rejects.toThrow("start hook failed");
    expect(fakes.released).toEqual([9400]);
    expect(runtime.getInstanceState("instance")?.process).toBeNull();
    expect(runtime.getInstanceState("instance")?.port).toBeNull();
  });

  // 分配端口失败时不调用 fake 进程管理器。
  test("端口分配失败不会启动进程", async () => {
    const fakes = createFakes({
      portAllocator: {
        allocate: async () => Promise.reject(new Error("no port")),
        release: () => {},
      } as unknown as PortAllocator,
    });
    const runtime = createCcbRuntime(fakes.dependencies);
    await prepare(runtime);
    await expect(runtime.startInstance({ instanceId: "instance" })).rejects.toThrow("no port");
    expect(fakes.starts).toEqual([]);
    expect(runtime.getInstanceState("instance")?.status).toBe("error");
  });

  // 进程启动失败时不保留端口、token 或 process 引用。
  test("进程启动失败清空运行资源", async () => {
    const fakes = createFakes({
      processManager: {
        start: async () => Promise.reject(new Error("process failed")),
        stop: async () => {},
      } as unknown as AcpLinkProcessManager,
    });
    const runtime = createCcbRuntime(fakes.dependencies);
    await prepare(runtime);
    await expect(runtime.startInstance({ instanceId: "instance" })).rejects.toThrow("process failed");
    const state = runtime.getInstanceState("instance");
    expect(state?.port).toBeNull();
    expect(state?.token).toBeNull();
    expect(state?.process).toBeNull();
  });

  // 未运行实例不能建立 relay，避免使用无效凭据。
  test("拒绝为未运行实例连接 relay", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await expect(runtime.connectRelay({ instanceId: "missing" })).rejects.toThrow("is not running");
  });

  // 依赖注入的 relay 直接保存并返回，不建立真实 socket。
  test("connectRelay 使用注入的 fake relay", async () => {
    const relay = openRelay();
    const runtime = createCcbRuntime(createFakes({ connectRelay: async () => relay }).dependencies);
    await start(runtime);
    await expect(runtime.connectRelay({ instanceId: "instance" })).resolves.toBe(relay);
    expect(runtime.getInstanceState("instance")?.relay).toBe(relay);
  });

  // 已打开 relay 重复连接时复用同一协议句柄。
  test("connectRelay 复用打开的 relay", async () => {
    let connections = 0;
    const relay = openRelay();
    const runtime = createCcbRuntime(
      createFakes({
        connectRelay: async () => {
          connections += 1;
          return relay;
        },
      }).dependencies,
    );
    await start(runtime);
    await runtime.connectRelay({ instanceId: "instance" });
    await runtime.connectRelay({ instanceId: "instance" });
    expect(connections).toBe(1);
  });

  // 已关闭 relay 需要重新连接，不能返回失效句柄。
  test("connectRelay 替换已关闭的 relay", async () => {
    const first = openRelay();
    const second = openRelay();
    let connections = 0;
    const runtime = createCcbRuntime(
      createFakes({ connectRelay: async () => (++connections === 1 ? first : second) }).dependencies,
    );
    await start(runtime);
    await runtime.connectRelay({ instanceId: "instance" });
    await first.close();
    await expect(runtime.connectRelay({ instanceId: "instance" })).resolves.toBe(second);
  });

  // relay 注入失败会把实例置为 error 并保存错误原因。
  test("connectRelay 失败保存错误状态", async () => {
    const runtime = createCcbRuntime(
      createFakes({ connectRelay: async () => Promise.reject(new Error("relay failed")) }).dependencies,
    );
    await start(runtime);
    await expect(runtime.connectRelay({ instanceId: "instance" })).rejects.toThrow("relay failed");
    expect(runtime.getInstanceState("instance")?.status).toBe("error");
    expect(runtime.getInstanceState("instance")?.error).toBe("relay failed");
  });

  // stop 关闭打开的 relay，再停止 fake 进程并释放端口。
  test("stop 依次清理 relay 进程和端口", async () => {
    let closeCount = 0;
    const relay = openRelay(() => (closeCount += 1));
    const fakes = createFakes({ connectRelay: async () => relay });
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime);
    await runtime.connectRelay({ instanceId: "instance" });
    await runtime.stopInstance({ instanceId: "instance" });
    expect(closeCount).toBe(1);
    expect(fakes.stops).toEqual(["instance"]);
    expect(fakes.released).toEqual([9400]);
  });

  // stop 后不保留协议凭据或进程引用。
  test("stop 清空所有运行资源", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await start(runtime);
    await runtime.stopInstance({ instanceId: "instance" });
    const state = runtime.getInstanceState("instance");
    expect(state?.process).toBeNull();
    expect(state?.port).toBeNull();
    expect(state?.token).toBeNull();
    expect(state?.relay).toBeNull();
  });

  // 已停止实例重复 stop 不重复释放资源。
  test("重复 stop 保持幂等", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime);
    await runtime.stopInstance({ instanceId: "instance" });
    await runtime.stopInstance({ instanceId: "instance" });
    expect(fakes.stops).toEqual(["instance"]);
    expect(fakes.released).toEqual([9400]);
  });

  // 从未启动的实例 stop 只转换为 stopped，不调用外部资源。
  test("空闲实例 stop 不调用外部资源", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    await runtime.stopInstance({ instanceId: "idle" });
    expect(runtime.getInstanceState("idle")?.status).toBe("stopped");
    expect(fakes.stops).toEqual([]);
  });

  // stop 钩子失败时报告 error，不伪装为已清理。
  test("stop 钩子失败标记 error", async () => {
    const runtime = createCcbRuntime(
      createFakes({ stopInstance: async () => Promise.reject(new Error("stop hook failed")) }).dependencies,
    );
    await start(runtime);
    await expect(runtime.stopInstance({ instanceId: "instance" })).rejects.toThrow("stop hook failed");
    expect(runtime.getInstanceState("instance")?.status).toBe("error");
  });

  // 进程停止失败时不释放端口，避免错误地把仍在占用的资源交还。
  test("进程 stop 失败不释放端口", async () => {
    const fakes = createFakes({
      processManager: {
        start: async ({ instanceId, port }: { instanceId: string; port: number }) => ({
          instanceId,
          port,
          token: "token",
          status: "running" as const,
        }),
        stop: async () => Promise.reject(new Error("stop failed")),
      } as unknown as AcpLinkProcessManager,
    });
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime);
    await expect(runtime.stopInstance({ instanceId: "instance" })).rejects.toThrow("stop failed");
    expect(fakes.released).toEqual([]);
  });

  // 不同实例拥有独立端口与进程记录。
  test("多个实例隔离端口和进程", async () => {
    const fakes = createFakes();
    const runtime = createCcbRuntime(fakes.dependencies);
    await start(runtime, "first");
    await start(runtime, "second");
    expect(runtime.getInstanceState("first")?.port).toBe(9400);
    expect(runtime.getInstanceState("second")?.port).toBe(9401);
    expect(fakes.starts).toEqual(["first", "second"]);
  });

  // 停止一个实例不会影响另一个实例的运行状态。
  test("停止单个实例不影响其他实例", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await start(runtime, "first");
    await start(runtime, "second");
    await runtime.stopInstance({ instanceId: "first" });
    expect(runtime.getInstanceState("first")?.status).toBe("stopped");
    expect(runtime.getInstanceState("second")?.status).toBe("running");
  });

  // getInstanceState 对未知实例不创建状态，读取无副作用。
  test("读取未知实例不创建状态", () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    expect(runtime.getInstanceState("unknown")).toBeUndefined();
  });

  // 运行中重复 prepare 成功后仍可复用已启动进程。
  test("运行中 prepare 成功后保持 process", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await start(runtime);
    const process = runtime.getInstanceState("instance")?.process;
    await prepare(runtime);
    expect(runtime.getInstanceState("instance")?.status).toBe("running");
    expect(runtime.getInstanceState("instance")?.process).toBe(process);
  });

  // 错误可以来自非 Error 值，并且仍以字符串形式保存。
  test("非 Error 失败原因转为字符串", async () => {
    const runtime = createCcbRuntime(
      createFakes({ startInstance: async () => Promise.reject("plain failure") }).dependencies,
    );
    await prepare(runtime);
    await expect(runtime.startInstance({ instanceId: "instance" })).rejects.toBe("plain failure");
    expect(runtime.getInstanceState("instance")?.error).toBe("plain failure");
  });

  // 状态对象按实例 ID 隔离，写入一个实例不会覆盖另一个实例。
  test("实例状态对象彼此隔离", async () => {
    const runtime = createCcbRuntime(createFakes().dependencies);
    await prepare(runtime, "first");
    await prepare(runtime, "second");
    const first = runtime.getInstanceState("first") as RuntimeInstanceState;
    const second = runtime.getInstanceState("second") as RuntimeInstanceState;
    expect(first).not.toBe(second);
    expect(first.instanceId).toBe("first");
    expect(second.instanceId).toBe("second");
  });
});
