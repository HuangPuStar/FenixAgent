import { describe, expect, test } from "bun:test";
import type { AgentLaunchSpec } from "@fenix/agent-runtime/server";
import { type CloudDriveModuleConfig, verifyCloudDriveMcpToken } from "@fenix/resource-cloud-drive/server";
import {
  CLOUD_DRIVE_MCP_SERVER_NAME,
  CloudDriveMcpNameConflictError,
  createCloudDriveSessionMcpProvider,
  withCloudDriveMcpServer,
} from "../services/cloud-drive-mcp";

const SECRET = "injection-test-secret";
const MASTER_KEY = "master-key-value";
const NOW = 1_700_000_000;

function launchSpec(overrides: Partial<AgentLaunchSpec> = {}): AgentLaunchSpec {
  return {
    organizationId: "org-1",
    userId: "user-a",
    agent: { name: "assistant", prompt: "system" },
    model: {
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://example.com/v1",
      apiKey: "test-key",
      model: "gpt-4o",
    },
    skills: [],
    mcpServers: [],
    ...overrides,
  };
}

function config(overrides: Partial<CloudDriveModuleConfig> = {}): CloudDriveModuleConfig {
  return {
    baseUrl: "http://127.0.0.1:8080",
    masterKey: MASTER_KEY,
    timeoutMs: 120_000,
    mcpTokenSecret: SECRET,
    mcpTokenTtlSeconds: 3600,
    mcpLaunchTtlSeconds: 86_400,
    mcpScope: "read",
    mcpTimeoutMs: 15_000,
    ...overrides,
  };
}

function inject(overrides: { config?: Partial<CloudDriveModuleConfig>; spec?: Partial<AgentLaunchSpec> } = {}) {
  return withCloudDriveMcpServer({
    spec: launchSpec(overrides.spec),
    config: config(overrides.config),
    baseUrl: "http://fenix.local:3000/",
    organizationId: "org-1",
    userId: "user-a",
    nowSeconds: NOW,
  });
}

describe("LaunchSpec 下发 CloudDrive MCP", () => {
  // 已配置时追加一条 streamable-http 条目，token 只属于当前用户与组织。
  test("已配置时追加条目且 token 可校验", async () => {
    const result = await inject();
    const entry = result.spec.mcpServers.at(-1);

    expect(result.skipped).toBeUndefined();
    expect(entry).toMatchObject({
      name: CLOUD_DRIVE_MCP_SERVER_NAME,
      type: "streamable-http",
      url: "http://fenix.local:3000/mcp/cloud-drive",
      timeout: 15_000,
    });

    const token = entry && "headers" in entry ? entry.headers?.Authorization?.replace("Bearer ", "") : undefined;
    expect(token).toBeDefined();
    const claims = await verifyCloudDriveMcpToken(token ?? "", SECRET, NOW);
    expect(claims).toMatchObject({ userId: "user-a", organizationId: "org-1", scope: "read" });
    expect(token).not.toContain(MASTER_KEY);
  });

  // 原有用户 MCP 条目必须保留且顺序不变：平台条目只追加在末尾。
  test("保留用户已有 MCP 条目", async () => {
    const result = await inject({
      spec: {
        mcpServers: [{ name: "user-mcp", type: "streamable-http", url: "https://example.com/mcp" }],
      },
    });

    expect(result.spec.mcpServers.map((server) => server.name)).toEqual(["user-mcp", CLOUD_DRIVE_MCP_SERVER_NAME]);
  });

  // 与保留名冲突时拒绝启动，不允许静默覆盖用户配置。
  test("同名冲突时抛错", async () => {
    await expect(
      inject({
        spec: {
          mcpServers: [{ name: CLOUD_DRIVE_MCP_SERVER_NAME, type: "streamable-http", url: "https://example.com" }],
        },
      }),
    ).rejects.toBeInstanceOf(CloudDriveMcpNameConflictError);
  });

  // 未配置 CloudDrive 时跳过，不影响实例启动。
  test("未配置 CloudDrive 时跳过", async () => {
    for (const override of [{ baseUrl: undefined }, { masterKey: undefined }]) {
      const result = await inject({ config: override });
      expect(result.skipped).toBe("cloud-drive-not-configured");
      expect(result.spec.mcpServers).toEqual([]);
    }
  });

  // 缺少 token 密钥时跳过（网关同时 503），把「配置不完整」留给宿主记 warning。
  test("缺少 token 密钥时跳过", async () => {
    const result = await inject({ config: { mcpTokenSecret: undefined } });

    expect(result.skipped).toBe("missing-token-secret");
    expect(result.spec.mcpServers).toEqual([]);
  });
});

describe("会话级 CloudDrive MCP（通道 B）", () => {
  function provider(overrides: Partial<CloudDriveModuleConfig> = {}) {
    return createCloudDriveSessionMcpProvider({
      baseUrl: () => "http://fenix.local:3000/",
      config: () => config(overrides),
      nowSeconds: () => NOW,
    });
  }

  // 会话级条目用 ACP 的 `http` 形状与 headers 数组，token 的 TTL 取短周期配置。
  test("返回 ACP http 条目且 token 可校验", async () => {
    const entries = await provider()({
      userId: "user-a",
      organizationId: "org-1",
      agentId: "env-1",
      instanceId: "inst-1",
    });
    const entry = entries?.[0] as
      | { type: string; name: string; url: string; headers: Array<{ name: string; value: string }> }
      | undefined;

    expect(entry).toMatchObject({
      type: "http",
      name: CLOUD_DRIVE_MCP_SERVER_NAME,
      url: "http://fenix.local:3000/mcp/cloud-drive",
    });
    const token = entry?.headers[0]?.value.replace("Bearer ", "") ?? "";
    expect(await verifyCloudDriveMcpToken(token, SECRET, NOW)).toMatchObject({
      userId: "user-a",
      organizationId: "org-1",
      scope: "read",
      expiresAt: NOW + 3600,
    });
    expect(token).not.toContain(MASTER_KEY);
  });

  // 未配置或缺少组织上下文时不注入，避免签发无主体意义的 token。
  test("未配置或缺少组织时不注入", async () => {
    expect(
      await provider({ baseUrl: undefined })({
        userId: "user-a",
        organizationId: "org-1",
        agentId: "env-1",
        instanceId: "i",
      }),
    ).toBeUndefined();
    expect(
      await provider({ mcpTokenSecret: undefined })({
        userId: "user-a",
        organizationId: "org-1",
        agentId: "env-1",
        instanceId: "i",
      }),
    ).toBeUndefined();
    expect(await provider()({ userId: "user-a", agentId: "env-1", instanceId: "i" })).toBeUndefined();
  });
});
