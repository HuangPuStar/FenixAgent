// PgEnvironmentOrchestrationRepo 的 machineId fallback 链测试（断裂点 4/5 回归）
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeAgentRuntimeModuleConfig, stubAgentRuntimeConfig } from "@fenix/agent-runtime/server/testing";
import { resetAllStubs, stubDb } from "@fenix/platform-sdk/testing";
import {
  type ExecutionNodeResolver,
  PgEnvironmentOrchestrationRepo,
} from "../server/repositories/environment-orchestration";
import {
  type AgentConfigExecutionFields,
  bindAgentConfigLookupPort,
  resetAgentConfigLookupPort,
} from "../server/services/agent-config-lookup-port";

describe("PgEnvironmentOrchestrationRepo.getEnvironment", () => {
  const repo = new PgEnvironmentOrchestrationRepo();

  /** 端口被问过的 agentConfigId 序列：用于断言"无 agentConfigId 时不问端口"。 */
  const portCalls: string[] = [];

  // 按 limit 返回值 mock drizzle 链式查询：select → from → where → limit。
  // `agent_config` 随 §1.7 B7 迁出宿主 schema 后本查询不再 LEFT JOIN，两列改由端口取（见下）。
  function stubSelectRows(rows: unknown[]) {
    stubDb({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => rows,
          }),
        }),
      }),
    });
  }

  /**
   * 装配端口桩：`fields` 为 `findAgentConfigExecutionFields` 的返回值（`null` 表示配置行已被删除，
   * 与"两列皆空"同义）。除该方法外的三个方法在本文件的用例里不会被走到，返回空值即可。
   */
  function stubLookup(fields: AgentConfigExecutionFields | null) {
    bindAgentConfigLookupPort({
      findAgentConfig: async () => null,
      findVisibleAgentConfig: async () => null,
      findAgentConfigExecutionFields: async (agentConfigId) => {
        portCalls.push(agentConfigId);
        return fields;
      },
      findAgentConfigNamesByIds: async () => new Map(),
    });
  }

  /** 一次性桩住环境行与端口；`fields` 缺省为"两列皆空"。 */
  function stubEnvRow(
    overrides: Partial<Record<string, unknown>> = {},
    fields: AgentConfigExecutionFields | null = { machineId: null, agentNode: null },
  ) {
    stubSelectRows([makeRow(overrides)]);
    stubLookup(fields);
  }

  function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      id: "env-1",
      organizationId: "org-1",
      agentConfigId: "ac-1",
      autoStart: false,
      envUserId: "user-1",
      ...overrides,
    };
  }

  // 每个用例重置替身并装配模块配置：machineId fallback 链读的是 agent-runtime 模块配置，
  // 用例内调整走 stubAgentRuntimeConfig（与生产读取路径同一次校验）
  beforeEach(() => {
    initializeAgentRuntimeModuleConfig();
    portCalls.length = 0;
  });

  afterEach(() => {
    // 端口绑定是进程级单例，不重置会在下一个用例里触发"已绑定"报错
    resetAgentConfigLookupPort();
    resetAllStubs();
  });

  // 空串 machineId 应视为未绑定，沿 fallback 链落到 RCS_DEFAULT_MACHINE_ID（断裂点 4 回归）
  test("空串 machineId 且系统有默认机器时 fallback 到默认机器", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, { machineId: "", agentNode: null });

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.machineId).toBe("mach_default");
  });

  // 空串 machineId、无默认机器且未禁用本地执行时兜底 local-default（旧路径 falsy 语义）
  test("空串 machineId 且无默认机器时兜底 local-default", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: undefined, disableLocalExecution: false });
    stubEnvRow({}, { machineId: "", agentNode: null });

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBe("local-default");
  });

  // 空串 machineId、无默认机器且禁用本地执行时 machineId 为 null（由编排域拒绝启动）
  test("空串 machineId 且禁用本地执行时 machineId 为 null", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: undefined, disableLocalExecution: true });
    stubEnvRow({}, { machineId: "", agentNode: null });

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBeNull();
  });

  // 无 agentConfigId 环境不再被拒绝（断裂点 5 回归），machineId fallback 照常执行；
  // 同时端口不应被问——ACP/Bridge 注册路径的环境不因端口装配状态改变行为
  test("无 agentConfigId 环境返回非 null 且 machineId fallback 到默认机器", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({ agentConfigId: null }, null);

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.agentConfigId).toBeNull();
    expect(env?.machineId).toBe("mach_default");
    expect(portCalls).toEqual([]);
  });

  // 无 agentConfigId 且禁用本地执行、无默认机器时 machineId 为 null（配置错误留给 spawn 层）
  test("无 agentConfigId 且禁用本地执行时 machineId 为 null", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: undefined, disableLocalExecution: true });
    stubEnvRow({ agentConfigId: null }, null);

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.machineId).toBeNull();
  });

  // 记录不存在（limit 返回空数组）时返回 null，与无 agentConfigId 场景严格区分
  test("记录不存在时返回 null", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubSelectRows([]);
    // 刻意不绑端口：记录不存在时若仍去问端口会直接抛错（getAgentConfigLookupPort 的 fail-fast），
    // 因此这条用例本身就是"未触达端口"的断言
    expect(await repo.getEnvironment("env-missing")).toBeNull();
  });

  // 有 agentConfigId 但端口取不到配置行（已被删除）时按"两列皆空"处理，
  // 与迁移前 LEFT JOIN 的语义一致（配置缺失 = 未绑定执行节点 → 走默认 fallback 链）
  test("端口返回 null（配置行已删除）时 fallback 到默认机器", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, null);

    const env = await repo.getEnvironment("env-1");
    expect(env).not.toBeNull();
    expect(env?.machineId).toBe("mach_default");
    expect(portCalls).toEqual(["ac-1"]);
  });

  // 绑定了合法 machineId 的 agent config 应原样返回，忽略系统默认机器
  test("agent config 绑定 machineId 时原样返回", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, { machineId: "mach_bound", agentNode: null });

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBe("mach_bound");
  });

  // agentNode 存在（含空对象 {}，表示"显式清空"）时忽略 machineId 列：
  // 与 resolveAgentNode 权威语义对齐，防止 spawn 用列、文件路径忽略列的分裂
  // （合并 main Sandbox 后引入的语义偏移回归）
  test("agentNode 为空对象时忽略 machineId 列走默认机器", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, { machineId: "mach_bound", agentNode: {} });

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBe("mach_default");
  });

  // agentNode 为 null（历史数据）时 machineId 列照常生效
  test("agentNode 为 null 时 machineId 列照常生效", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, { machineId: "mach_bound", agentNode: null });

    const env = await repo.getEnvironment("env-1");
    expect(env?.machineId).toBe("mach_bound");
  });

  // 注：不测 `"  "` 空白串——`||` 下为 truthy，视为合法绑定值原样透传；
  // 空白串归一不在本次范围（实现与 0dcb2e2d 前旧路径 falsy 语义保持一致）。

  // 注入执行节点解析器后（sandbox 适配装配点），resolver 结果优先于默认 fallback 链
  test("注入 resolver 时优先采用 resolver 解析出的 machineId", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, { machineId: "mach_bound", agentNode: null });
    repo.setExecutionNodeResolver(async () => "sbx_machine_1");

    const env = await repo.getEnvironment("env-1", "user-1");
    expect(env?.machineId).toBe("sbx_machine_1");
  });

  // resolver 返回 null 表示无业务解析结果，回落到默认链（machineId 列 → 默认机器）
  test("resolver 返回 null 时回落默认 fallback 链", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: "mach_default", disableLocalExecution: false });
    stubEnvRow({}, { machineId: "", agentNode: null });
    repo.setExecutionNodeResolver(async () => null);

    const env = await repo.getEnvironment("env-1", "user-1");
    expect(env?.machineId).toBe("mach_default");
  });

  // resolver 的入参应包含 userId 与 agentNode 原始 JSON（sandbox 归属与解析输入）；
  // 端口原样透传两列，不做归一（节点解析规则只有 resolveAgentNode 一份）
  test("resolver 收到 userId / agentNode / configMachineId 上下文", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: undefined, disableLocalExecution: false });
    stubEnvRow({}, { machineId: null, agentNode: { kind: "sandbox", sandboxPoolId: "pool-1" } });
    // 用对象容器保存捕获值：直接捕获到 let 变量会触发 TS 闭包 CFA 窄化（报 never），
    // 属性访问不受闭包赋值影响，类型始终为声明类型
    const captured: { input: Parameters<ExecutionNodeResolver>[0] | null } = { input: null };
    repo.setExecutionNodeResolver(async (input) => {
      captured.input = input;
      return null;
    });

    await repo.getEnvironment("env-1", "user-9");
    expect(captured.input).not.toBeNull();
    expect(captured.input?.userId).toBe("user-9");
    expect(captured.input?.agentNode).toEqual({ kind: "sandbox", sandboxPoolId: "pool-1" });
    expect(captured.input?.configMachineId).toBeNull();
  });

  // getEnvironment 不传 userId 时回退环境属主（历史调用方兼容）
  test("不传 userId 时 resolver 收到环境属主 userId", async () => {
    stubAgentRuntimeConfig({ defaultMachineId: undefined, disableLocalExecution: false });
    stubEnvRow({ envUserId: "owner-1" });
    let capturedUserId: string | undefined;
    repo.setExecutionNodeResolver(async (input) => {
      capturedUserId = input.userId;
      return null;
    });

    await repo.getEnvironment("env-1");
    expect(capturedUserId).toBe("owner-1");
  });
});
