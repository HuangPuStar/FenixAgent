// PgEnvironmentOrchestrationRepo 的 machineId fallback 链测试（断裂点 4/5 回归）
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { config, setConfig } from "../config";
import { PgEnvironmentOrchestrationRepo } from "../repositories/environment-orchestration";
import { resetAllStubs, stubDb } from "../test-utils/helpers";

describe("PgEnvironmentOrchestrationRepo.getEnvironment", () => {
  const repo = new PgEnvironmentOrchestrationRepo();
  // 保存原始 config 引用，每次测试后恢复，防止 setConfig 污染后续测试
  const originalConfig = { ...config };

  // 按 limit 返回值 mock drizzle 链式查询：select → from → leftJoin → where → limit
  function stubSelectRows(rows: unknown[]) {
    stubDb({
      select: () => ({
        from: () => ({
          leftJoin: () => ({
            where: () => ({
              limit: async () => rows,
            }),
          }),
        }),
      }),
    });
  }

  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "env-1",
      organizationId: "org-1",
      agentConfigId: "ac-1",
      autoStart: false,
      configMachineId: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    resetAllStubs();
  });

  afterEach(() => {
    setConfig(originalConfig);
    resetAllStubs();
  });

  // 空串 machineId 应视为未绑定，沿 fallback 链落到 RCS_DEFAULT_MACHINE_ID（断裂点 4 回归）
  test("空串 machineId 且系统有默认机器时 fallback 到默认机器", async () => {
    setConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubSelectRows([makeRow({ configMachineId: "" })]);

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.machineId).toBe("mach_default");
  });

  // 空串 machineId、无默认机器且未禁用本地执行时兜底 local-default（旧路径 falsy 语义）
  test("空串 machineId 且无默认机器时兜底 local-default", async () => {
    setConfig({ defaultMachineId: undefined, disableLocalExecution: false });
    stubSelectRows([makeRow({ configMachineId: "" })]);

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBe("local-default");
  });

  // 空串 machineId、无默认机器且禁用本地执行时 machineId 为 null（由编排域拒绝启动）
  test("空串 machineId 且禁用本地执行时 machineId 为 null", async () => {
    setConfig({ defaultMachineId: undefined, disableLocalExecution: true });
    stubSelectRows([makeRow({ configMachineId: "" })]);

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBeNull();
  });

  // 无 agentConfigId 环境不再被拒绝（断裂点 5 回归），machineId fallback 照常执行
  test("无 agentConfigId 环境返回非 null 且 machineId fallback 到默认机器", async () => {
    setConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubSelectRows([makeRow({ agentConfigId: null, configMachineId: null })]);

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.agentConfigId).toBeNull();
    expect(env?.machineId).toBe("mach_default");
  });

  // 无 agentConfigId 且禁用本地执行、无默认机器时 machineId 为 null（配置错误留给 spawn 层）
  test("无 agentConfigId 且禁用本地执行时 machineId 为 null", async () => {
    setConfig({ defaultMachineId: undefined, disableLocalExecution: true });
    stubSelectRows([makeRow({ agentConfigId: null, configMachineId: null })]);

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.machineId).toBeNull();
  });

  // 记录不存在（limit 返回空数组）时返回 null，与无 agentConfigId 场景严格区分
  test("记录不存在时返回 null", async () => {
    setConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubSelectRows([]);

    expect(await repo.getEnvironment("env-missing")).toBeNull();
  });

  // 绑定了合法 machineId 的 agent config 应原样返回，忽略系统默认机器
  test("agent config 绑定 machineId 时原样返回", async () => {
    setConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubSelectRows([makeRow({ configMachineId: "mach_bound" })]);

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBe("mach_bound");
  });

  // 注：不测 `"  "` 空白串——`||` 下为 truthy，视为合法绑定值原样透传；
  // 空白串归一不在本次范围（实现与 0dcb2e2d 前旧路径 falsy 语义保持一致）。
});
