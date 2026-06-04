import { describe, expect, test } from "bun:test";
import { buildLaunchSpec } from "../services/launch-spec-builder";

const now = new Date("2026-06-01T00:00:00.000Z");

function providerRow() {
  return {
    id: "provider_external",
    userId: "user_source",
    organizationId: "org_source",
    name: "openai",
    displayName: "OpenAI Shared",
    protocol: "openai" as const,
    baseUrl: "https://external.example.com",
    apiKey: "external-key",
    extraOptions: {},
    createdAt: now,
    updatedAt: now,
    resourceAccess: {
      ownership: "external" as const,
      sourceOrganizationId: "org_source",
      resourceUid: "provider_external",
      resourceKey: "org_source/provider_external",
      manageable: false,
      writable: false,
    },
  };
}

describe("workflow provider model access", () => {
  // Workflow 当前不再维护独立 agent config resolver，稳定外部 provider model 引用由 LaunchSpec 统一解析
  test("workflow runtime 可使用外部 provider model fullConfig", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentName: "workflow-agent",
      modelRef: "org_source/provider_external/shared-model",
      environmentSecret: "secret",
      fullConfig: {
        agentConfig: null,
        providers: [providerRow()],
        skills: [],
        mcpServers: [],
      },
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      apiKey: "external-key",
      baseUrl: "https://external.example.com",
      model: "shared-model",
    });
  });

  // 不可读或不存在的 provider 不进入 fullConfig，稳定引用解析失败时回落为明确的默认空 key 配置
  test("workflow runtime 缺少可读 provider 时不会使用外部密钥", async () => {
    const spec = await buildLaunchSpec({
      organizationId: "org_current",
      userId: "user_owner",
      agentName: "workflow-agent",
      modelRef: "org_source/provider_external/shared-model",
      environmentSecret: "secret",
      fullConfig: {
        agentConfig: null,
        providers: [],
        skills: [],
        mcpServers: [],
      },
    });

    expect(spec.model).toMatchObject({
      provider: "openai",
      apiKey: "",
      model: "org_source/provider_external/shared-model",
    });
  });
});
