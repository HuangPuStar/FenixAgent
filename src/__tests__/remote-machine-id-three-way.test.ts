import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setConfig } from "../config";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubFileWsHandler } from "../test-utils/helpers";

const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";

// 动态 import：../db 的 mock 是实时 Proxy（setup-mocks.ts），stub 在调用时转发，
// import 时机不影响 stub 生效
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
  resetAllStubs();
  // 环境归属 stub：无 agentConfigId，machineId 走 RCS_DEFAULT_MACHINE_ID fallback
  stubEnvironmentRepo({
    getById: async () => ({ id: ENV_ID, organizationId: "org-1", userId: "user-1" }),
  });
});

afterEach(() => {
  setConfig({ defaultMachineId: undefined });
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
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([]);
    await expect(getRemoteMachineId(ENV_ID)).rejects.toMatchObject({
      statusCode: 422,
      code: "config_error",
    });
  });

  test("machineId 存在但 file-ws 未连接 → 503 file_service_unavailable", async () => {
    // 配置正确但机器离线：503 拒绝静默回退本地，避免远程/本地文件分裂
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([{ id: MACHINE_ID }]);
    stubFileWsHandler({ isFileWsConnected: () => false });
    await expect(getRemoteMachineId(ENV_ID)).rejects.toMatchObject({
      statusCode: 503,
      code: "file_service_unavailable",
    });
  });

  test("machineId 存在且 file-ws 已连接 → 返回 machineId", async () => {
    // 正常路径：DB 记录存在 + 连接正常时返回 machineId，路由决策走远程
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([{ id: MACHINE_ID }]);
    stubFileWsHandler({ isFileWsConnected: () => true });
    const result = await getRemoteMachineId(ENV_ID);
    expect(result).toBe(MACHINE_ID);
  });

  test("422 的 message 提示去管理面检查配置，不泄露内部细节", async () => {
    // message 面向用户：指引排查方向（管理面配置），不包含内部实现细节
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineLookup([]);
    const err = await getRemoteMachineId(ENV_ID).catch((e) => e);
    expect((err as Error).message).toContain("管理面");
  });

  test("环境不存在 → null（本地兜底，不触发 machine 查询）", async () => {
    // 环境缺失时 getRemoteMachineId 与现状语义一致返回 null，由门面统一 404
    stubEnvironmentRepo({ getById: async () => null });
    const result = await getRemoteMachineId(ENV_ID);
    expect(result).toBeNull();
  });
});
