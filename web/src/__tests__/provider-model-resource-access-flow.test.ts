import { describe, expect, test } from "bun:test";
import { buildModelOptions } from "@/components/config/ModelConfigDialog";
import { mapMcpOptions, mapModelOptions } from "../pages/agent-panel/agent-editor/agent-editor-model";
import {
  buildProviderInlineTestPayload,
  buildProviderPublicReadablePayload,
  canWriteProvider,
  getProviderDisplayName,
  getProviderIconModelId,
  getProviderKey,
  getProviderResourceBadgeKey,
  getProviderScope,
  supportsThinking,
} from "../pages/agent-panel/pages/agent-models-utils";
import type { ModelEntry, ProviderInfo, ResourceAccess } from "../types/config";

const internalProvider: ProviderInfo = {
  providerId: "provider-internal",
  id: "openai",
  name: "OpenAI",
  kind: "direct",
  gatewayType: null,
  protocol: "openai",
  keyHint: "***1234",
  baseURL: "https://internal.example.com",
  modelCount: 1,
  resourceAccess: {
    ownership: "internal",
    sourceOrganizationId: "org-current",
    sourceOrganizationName: "Current Team",
    resourceUid: "provider-internal",
    resourceKey: "org-current/provider-internal",
    manageable: true,
    writable: true,
    publicReadable: false,
  },
};

const externalProvider: ProviderInfo = {
  providerId: "provider-external",
  id: "openai",
  name: "OpenAI Shared",
  kind: "direct",
  gatewayType: null,
  protocol: "openai",
  keyHint: "***5678",
  baseURL: "https://external.example.com",
  modelCount: 1,
  resourceAccess: {
    ownership: "external",
    sourceOrganizationId: "org-source",
    sourceOrganizationName: "Source Team",
    resourceUid: "provider-external",
    resourceKey: "org-source/provider-external",
    manageable: false,
    writable: false,
  },
};

const externalModel: ModelEntry = {
  id: "model-uuid-shared",
  modelId: "shared-model",
  displayName: "Shared Model",
  provider: "openai",
  providerDisplayName: "OpenAI Shared",
  contextLimit: 128000,
  outputLimit: 4096,
  providerResourceKey: "org-source/provider-external",
  providerResourceAccess: externalProvider.resourceAccess,
};

const sharedMcpAccess: ResourceAccess = {
  ownership: "external",
  sourceOrganizationId: "org-source",
  sourceOrganizationName: "Source Team",
  resourceUid: "mcp-external",
  resourceKey: "org-source/mcp-external",
  manageable: false,
  writable: false,
};

describe("provider model resource access flow", () => {
  // 内部和外部同名 provider 使用 resourceKey 区分，不会覆盖 models map
  test("uses stable provider resource keys for same-name providers", () => {
    expect(getProviderKey(internalProvider)).toBe("org-current/provider-internal");
    expect(getProviderKey(externalProvider)).toBe("org-source/provider-external");
    expect(getProviderDisplayName(internalProvider)).toBe("Current Team/openai");
    expect(getProviderDisplayName(externalProvider)).toBe("Source Team/openai");
  });

  // 外部 provider 的写入口判断为只读，页面据此隐藏 edit/delete/test/add model
  test("marks external provider as read-only", () => {
    expect(canWriteProvider(internalProvider)).toBe(true);
    expect(canWriteProvider(externalProvider)).toBe(false);
    expect(getProviderResourceBadgeKey(internalProvider)).toBe("resource.internal");
    expect(getProviderResourceBadgeKey(externalProvider)).toBe("resource.external");
  });

  // Provider API 未提供个人/平台 scope 时，只显示可由 ownership 证明的本组织与共享范围。
  test("derives only provable provider scopes", () => {
    expect(getProviderScope(internalProvider)).toBe("organization");
    expect(getProviderScope(externalProvider)).toBe("shared");
  });

  // 本组织公开资源仍属于本组织；外部资源只能证明为公开，不能推断为全局公开。
  test("keeps ownership scope separate from public readability", () => {
    const publicInternalProvider: ProviderInfo = {
      ...internalProvider,
      resourceAccess: { ...internalProvider.resourceAccess!, publicReadable: true },
    };

    expect(getProviderScope(publicInternalProvider)).toBe("organization");
    expect(getProviderScope(externalProvider)).toBe("shared");
    expect(externalProvider.resourceAccess?.publicReadable).toBeUndefined();
  });

  // 自定义 Provider ID 无法识别品牌时，应使用已配置模型 ID 解析图标。
  test("uses a configured model id for the provider brand icon", () => {
    expect(
      getProviderIconModelId({ ...internalProvider, id: "admin@example.com" }, [
        { id: "gpt-5.2", name: "GPT-5.2", modalities: null, limit: null, cost: null },
      ]),
    ).toBe("gpt-5.2");
    expect(getProviderIconModelId({ ...internalProvider, id: "custom-provider" }, [])).toBe("custom-provider");
  });

  // 思考能力必须读取真实 options.thinking.enabled，不能根据模型名称推测。
  test("reads thinking capability from model options", () => {
    expect(supportsThinking({ options: { thinking: { enabled: true } } })).toBe(true);
    expect(supportsThinking({ options: { thinking: { enabled: false } } })).toBe(false);
    expect(supportsThinking({})).toBe(false);
  });

  // 内部 provider 公开开关复用原 set API payload，并携带 publicReadable
  test("builds public readable provider set payload", () => {
    expect(buildProviderPublicReadablePayload(true)).toEqual({
      publicReadable: true,
    });
  });

  // 预取模型列表只应使用当前表单值测试，未填写的字段不应触发隐式落库。
  test("builds inline provider test payload without forcing persistence fields", () => {
    expect(
      buildProviderInlineTestPayload({
        apiKey: "sk-temp",
        baseURL: "https://proxy.example.com",
        protocol: "openai",
      }),
    ).toEqual({
      apiKey: "sk-temp",
      baseURL: "https://proxy.example.com",
      protocol: "openai",
    });

    expect(
      buildProviderInlineTestPayload({
        apiKey: "   ",
        baseURL: "",
        protocol: "anthropic",
      }),
    ).toEqual({
      apiKey: undefined,
      baseURL: undefined,
      protocol: "anthropic",
    });
  });

  // ModelConfigDialog 使用资源 key 生成稳定引用，展示文案由前端拼 provider/source
  test("model config dialog options use resource key and display name", () => {
    expect(buildModelOptions([externalModel])).toEqual([
      { value: "org-source/provider-external/shared-model", label: "Source Team/OpenAI Shared/Shared Model" },
    ]);
  });

  // Agent Editor 保存模型 UUID，并以 Provider 分组展示短模型名称和品牌标识。
  test("agent form model options use modelId and display name", () => {
    expect(mapModelOptions([externalModel])).toEqual([
      {
        value: "model-uuid-shared",
        label: "Shared Model",
        modelId: "shared-model",
        group: {
          id: "org-source:org-source/provider-external",
          label: "OpenAI Shared",
          scope: "shared",
        },
      },
    ]);
  });

  // AgentFormDialog 的 MCP 选项只展示已启用项，避免禁用 MCP 继续出现在绑定候选中
  test("agent form filters disabled mcp options", () => {
    expect(
      mapMcpOptions([
        { id: "mcp-enabled", name: "enabled-mcp", enabled: true, resourceAccess: sharedMcpAccess },
        { id: "mcp-disabled", name: "disabled-mcp", enabled: false, resourceAccess: sharedMcpAccess },
      ]),
    ).toEqual([
      {
        id: "mcp-enabled",
        key: "org-source/mcp-external",
        name: "enabled-mcp",
        label: "Source Team/enabled-mcp",
        resourceAccess: sharedMcpAccess,
      },
    ]);
  });
});
