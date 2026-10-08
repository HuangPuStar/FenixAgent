import { beforeEach, describe, expect, test } from "bun:test";
import { stubDb } from "@fenix/platform-sdk/testing";
import {
  initializeMachineModuleConfig,
  stubFileWsTransport,
  stubMachineAgentConfig,
  stubMachineConfig,
  stubMachineEnvironment,
} from "../testing";

const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";
const AGENT_BOUND_MACHINE_ID = "mach_agent_bound";

/** Agent 配置读取的入参记录：组织上下文必须原样传给端口（E2 的缺口就是这里少传了 organizationId）。 */
const agentConfigReads: Array<{ agentConfigId: string; organizationId: string }> = [];

/**
 * 装配 Agent 配置取数端口的替身。
 *
 * 语义与宿主注入的真实实现一致（`getAgentConfigById(id, organizationId)` 按归属读）：配置属于
 * `ownerOrganizationId`，其余组织一律读不到。因此「环境属于另一个组织」这件事在用例里表现为端口返回
 * null——真实实现里由 owner 的归属谓词完成，本包不复制那条规则。
 */
function stubAgentConfigOwnedBy(ownerOrganizationId: string): void {
  agentConfigReads.length = 0;
  stubMachineAgentConfig({
    getExecutionNode: async (input) => {
      agentConfigReads.push({ ...input });
      return input.organizationId === ownerOrganizationId
        ? { kind: "machine", machineId: AGENT_BOUND_MACHINE_ID }
        : null;
    },
    isAgentConfigBoundToMachine: async () => false,
    bindMachineIdByAgentName: async () => {},
  });
}

// 动态 import：../db 经实时 Proxy 转发到当前 DB 替身（../testing 的 machineDbProxy），
// stub 在调用时转发，import 时机不影响 stub 生效
const { getRemoteMachineId } = await import("../services/remote-file-service");

/** 构造 machine 表查询 stub：rows 为空 → 不存在；否则存在 */
function stubMachineLookup(rows: Array<{ id: string }>) {
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

beforeEach(() => {
  initializeMachineModuleConfig();
  // 环境归属 stub：无 agentConfigId，machineId 走 RCS_DEFAULT_MACHINE_ID fallback
  stubMachineEnvironment({
    getEnvironmentById: async () => ({ id: ENV_ID, organizationId: "org-1", userId: "user-1" }),
  });
});

describe("getRemoteMachineId 三分（422 vs 503 vs 返回）", () => {
  test("未配置 machine（无 agentConfigId 且无默认机器）→ null 走本地", async () => {
    // 本地环境：不配置 machine 时不得触发 DB 查询，返回 null 走本地 FS
    const result = await getRemoteMachineId(ENV_ID);
    expect(result).toBeNull();
  });

  test("machineId 不存在于 DB machine 表 → 422 config_error", async () => {
    // 配置错误与连接不可用必须区分：machineId 无记录是管理面配置问题（422），
    // 提示用户去管理面检查，而不是伪装成机器离线（503）
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([]);
    await expect(getRemoteMachineId(ENV_ID)).rejects.toMatchObject({
      statusCode: 422,
      code: "config_error",
    });
  });

  test("machineId 存在但 file-ws 未连接 → 503 file_service_unavailable", async () => {
    // 配置正确但机器离线：503 拒绝静默回退本地，避免远程/本地文件分裂
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([{ id: MACHINE_ID }]);
    stubFileWsTransport({ isFileWsConnected: () => false });
    await expect(getRemoteMachineId(ENV_ID)).rejects.toMatchObject({
      statusCode: 503,
      code: "file_service_unavailable",
    });
  });

  test("machineId 存在且 file-ws 已连接 → 返回 machineId", async () => {
    // 正常路径：DB 记录存在 + 连接正常时返回 machineId，路由决策走远程
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([{ id: MACHINE_ID }]);
    stubFileWsTransport({ isFileWsConnected: () => true });
    const result = await getRemoteMachineId(ENV_ID);
    expect(result).toBe(MACHINE_ID);
  });

  test("422 的 message 提示去管理面检查配置，不泄露内部细节", async () => {
    // message 面向用户：指引排查方向（管理面配置），不包含内部实现细节
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([]);
    const err = await getRemoteMachineId(ENV_ID).catch((e) => e);
    expect((err as Error).message).toContain("管理面");
  });

  test("环境不存在 → null（本地兜底，不触发 machine 查询）", async () => {
    // 环境缺失时 getRemoteMachineId 与现状语义一致返回 null，由门面统一 404
    stubMachineEnvironment({ getEnvironmentById: async () => null });
    const result = await getRemoteMachineId(ENV_ID);
    expect(result).toBeNull();
  });

  test("环境绑定的 Agent 配置属于本组织 → 按配置声明的机器路由", async () => {
    // 正向基线：解析规则在 owner 侧（agentNode 优先、回退 machineId），本包只消费解析后的节点
    stubMachineLookup([{ id: AGENT_BOUND_MACHINE_ID }]);
    stubFileWsTransport({ isFileWsConnected: () => true });
    stubMachineEnvironment({
      getEnvironmentById: async () => ({
        id: ENV_ID,
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "cfg-1",
      }),
    });
    stubAgentConfigOwnedBy("org-1");

    const result = await getRemoteMachineId(ENV_ID);

    expect(result).toBe(AGENT_BOUND_MACHINE_ID);
    expect(agentConfigReads).toEqual([{ agentConfigId: "cfg-1", organizationId: "org-1" }]);
  });

  test("环境绑定的 Agent 配置属于别的组织 → 不按该配置路由，退回默认机器", async () => {
    // §10.3 多租户隔离：配置属于 org-1、环境属于 org-2，归属读返回 null，文件请求不得落到别的组织的机器上。
    // 同时钉住调用形态——读取必须带组织上下文，缺了它跨组织配置会被当成命中（E2 的缺口）。
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([{ id: MACHINE_ID }]);
    stubFileWsTransport({ isFileWsConnected: () => true });
    stubMachineEnvironment({
      getEnvironmentById: async () => ({
        id: ENV_ID,
        organizationId: "org-2",
        userId: "user-1",
        agentConfigId: "cfg-of-org-1",
      }),
    });
    stubAgentConfigOwnedBy("org-1");

    const result = await getRemoteMachineId(ENV_ID);

    expect(result).toBe(MACHINE_ID);
    expect(agentConfigReads).toEqual([{ agentConfigId: "cfg-of-org-1", organizationId: "org-2" }]);
  });
});
