import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createExecutionNodeResolver } from "../services/orchestration-bootstrap";
import { resetAllStubs } from "../test-utils/helpers";

describe("createExecutionNodeResolver", () => {
  const prepareCalls: Array<{ sandboxPoolId: string; userId: string; organizationId: string | null }> = [];

  beforeEach(() => {
    resetAllStubs();
    prepareCalls.length = 0;
  });

  afterEach(() => {
    resetAllStubs();
  });

  function makeResolver(overrides: { sandboxEnabled?: boolean; defaultSandboxPoolId?: string | null } = {}) {
    return createExecutionNodeResolver({
      prepareSandbox: async (sandboxPoolId, userId, organizationId) => {
        prepareCalls.push({ sandboxPoolId, userId, organizationId });
        return `mach_sandbox_${sandboxPoolId}`;
      },
      ...overrides,
    });
  }

  function input(overrides: Record<string, unknown> = {}) {
    return {
      envId: "env-1",
      organizationId: "org-1",
      userId: "user-1",
      agentNode: null,
      configMachineId: null,
      ...overrides,
    };
  }

  // 显式 sandbox：环境绑定沙盒资源池，prepare 必须收到 sandboxPoolId / userId /
  // organizationId（sandbox 实例按 userId 归属，复用键与租户隔离依赖这三个参数）
  test("agentNode 为 sandbox 时调用 prepareSandbox 并返回 nodeId", async () => {
    const resolver = makeResolver();
    const result = await resolver(input({ agentNode: { kind: "sandbox", sandboxPoolId: "pool-1" } }));

    expect(result).toBe("mach_sandbox_pool-1");
    expect(prepareCalls).toEqual([{ sandboxPoolId: "pool-1", userId: "user-1", organizationId: "org-1" }]);
  });

  // 显式 machine：无需沙盒准备，直接返回 machineId，prepare 不得被调用
  test("agentNode 为 machine 时直接返回 machineId 且不调用 prepareSandbox", async () => {
    const resolver = makeResolver();
    const result = await resolver(input({ agentNode: { kind: "machine", machineId: "mach_remote" } }));

    expect(result).toBe("mach_remote");
    expect(prepareCalls).toHaveLength(0);
  });

  // 默认 sandbox：未显式指定执行节点且启用沙盒默认策略时，使用默认资源池
  test("sandboxEnabled 且配置默认池时 prepare 默认池", async () => {
    const resolver = makeResolver({ sandboxEnabled: true, defaultSandboxPoolId: "pool-default" });
    const result = await resolver(input());

    expect(result).toBe("mach_sandbox_pool-default");
    expect(prepareCalls).toEqual([{ sandboxPoolId: "pool-default", userId: "user-1", organizationId: "org-1" }]);
  });

  // 沙盒已启用但缺少默认资源池属部署配置错误：明确拒绝而非静默回落，
  // 与旧 spawn 路径语义对齐（否则每个环境都会在运行时才发现节点不可用）
  test("sandboxEnabled 但无默认池时抛 SANDBOX_DEFAULT_POOL_MISSING(503)", async () => {
    const resolver = makeResolver({ sandboxEnabled: true, defaultSandboxPoolId: null });

    await expect(resolver(input())).rejects.toMatchObject({
      code: "SANDBOX_DEFAULT_POOL_MISSING",
      statusCode: 503,
    });
    expect(prepareCalls).toHaveLength(0);
  });

  // 沙盒未启用：返回 null，由 EnvironmentRepo 走默认 fallback 链
  //（machineId 列 → RCS_DEFAULT_MACHINE_ID → local-default）
  test("sandbox 未启用时返回 null", async () => {
    const resolver = makeResolver({ sandboxEnabled: false });

    expect(await resolver(input())).toBeNull();
    expect(prepareCalls).toHaveLength(0);
  });

  // agentNode 为空对象（"显式清空"）时按 resolveAgentNode 权威语义忽略 machineId 列；
  // resolver 返回 null 后 repo 层同样跳过列（M1 回归测试覆盖），两端语义一致
  test("agentNode 为空对象时忽略 configMachineId 列", async () => {
    const resolver = makeResolver({ sandboxEnabled: false });

    expect(await resolver(input({ agentNode: {}, configMachineId: "mach_bound" }))).toBeNull();
    expect(prepareCalls).toHaveLength(0);
  });
});
