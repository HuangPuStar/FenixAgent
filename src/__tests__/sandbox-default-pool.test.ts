import { describe, expect, test } from "bun:test";
import type { SandboxPool } from "../db/schema";
import { initializeDefaultSandboxPool } from "../services/sandbox/sandbox-default-pool";

const settings = {
  sandboxEnabled: true,
  defaultSandboxPoolId: "default",
  defaultSandboxImage: "sandbox:v1",
  defaultSandboxResourcesJson: JSON.stringify({
    cpu: 2,
    memoryMb: 4096,
    diskGb: 20,
    gpuCount: 0,
    environment: {},
    volumes: [],
  }),
  defaultSandboxAgentType: "peri",
  defaultSandboxExtraJson: JSON.stringify({
    "opensandbox-cluster": { entrypoint: ["docker-entrypoint.sh", "acp-runtime", "opencode", "acp"] },
  }),
};

describe("default sandbox pool", () => {
  // 沙盒关闭时不应创建或修改默认资源池。
  test("does not initialize when sandbox is disabled", async () => {
    let called = false;
    const result = await initializeDefaultSandboxPool(
      { ...settings, sandboxEnabled: false },
      {
        upsert: async () => {
          called = true;
          return {} as SandboxPool;
        },
      },
    );
    expect(result).toBeNull();
    expect(called).toBe(false);
  });

  // 启用沙盒时必须具备默认 Pool、镜像和完整资源配置。
  test("requires all default sandbox settings", async () => {
    await expect(
      initializeDefaultSandboxPool({ sandboxEnabled: true }, { upsert: async () => ({}) as Promise<SandboxPool> }),
    ).rejects.toThrow("RCS_SANDBOX_ENABLED=true requires");
  });

  // 默认 Pool 使用全局作用域，名称和 ID 相同，并同步当前环境中的模板配置。
  test("upserts a global pool from current settings", async () => {
    let input: Record<string, unknown> | undefined;
    await initializeDefaultSandboxPool(settings, {
      upsert: async (value) => {
        input = value as Record<string, unknown>;
        return value as SandboxPool;
      },
    });
    expect(input).toMatchObject({
      id: "default",
      name: "default",
      organizationId: null,
      providerKey: "opensandbox-cluster",
      image: "sandbox:v1",
    });
    expect(input?.defaultResources).toEqual(JSON.parse(settings.defaultSandboxResourcesJson));
    expect(input?.extra).toEqual({
      agent_type: "peri",
      ...JSON.parse(settings.defaultSandboxExtraJson),
    });
  });

  // 非法资源 JSON 必须阻止默认 Pool 初始化，不能静默使用空配置。
  test("rejects malformed resources", async () => {
    await expect(
      initializeDefaultSandboxPool(
        { ...settings, defaultSandboxResourcesJson: "{}" },
        { upsert: async () => ({}) as Promise<SandboxPool> },
      ),
    ).rejects.toThrow("sandbox resources are incomplete");
  });
});
