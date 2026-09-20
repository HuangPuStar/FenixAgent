import type { SandboxInstance, SandboxPool } from "@server/db/schema";

/**
 * SandboxManager 用例的公共夹具。
 *
 * 三个用例文件（身份与快照 / 资源恢复 / 并发协调）共用同一份资源规格与 Instance 工厂：它们断言的是
 * 同一个数据库记录形状，各自复制一份会让字段漂移只在一个文件里被修好。
 */
export const resources = {
  cpu: 0.5,
  memoryMb: 512,
  diskGb: 5,
  gpuCount: 0,
  environment: { LANG: "C.UTF-8" },
  volumes: [],
};

export const pool = {
  id: "pool_default",
  providerKey: "test-provider",
  image: "sandbox:test",
  defaultResources: resources,
  extra: {},
} as unknown as SandboxPool;

/** 构造可被用例覆写的 Instance 记录；默认值对应“首次创建、尚未创建外部资源”的前置状态。 */
export function makeInstance(overrides: Partial<SandboxInstance> = {}): SandboxInstance {
  return {
    id: "sbi_test",
    machineId: "mach_sandbox_sbi_test",
    providerKey: "test-provider",
    sandboxPoolId: "pool_default",
    userId: "user_test",
    externalSandboxId: null,
    status: "creating",
    resolvedConfig: {},
    resourceOverrides: null,
    providerPayload: null,
    lastHeartbeatAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}
