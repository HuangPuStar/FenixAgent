import { describe, expect, test } from "bun:test";
import { buildModelOptions } from "@/components/config/ModelConfigDialog";
import { mapModelOptions } from "../pages/agent-panel/AgentFormDialog";
import {
  buildProviderPublicReadablePayload,
  canWriteProvider,
  getProviderDisplayName,
  getProviderKey,
  getProviderResourceBadgeKey,
} from "../pages/agent-panel/pages/AgentModelsPage";
import type { ModelEntry, ProviderInfo } from "../types/config";

const internalProvider: ProviderInfo = {
  id: "openai",
  name: "OpenAI",
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
  id: "openai",
  name: "OpenAI Shared",
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

  // 内部 provider 公开开关复用原 set API payload，并携带 publicReadable
  test("builds public readable provider set payload", () => {
    expect(
      buildProviderPublicReadablePayload(
        { apiKey: "{env:RCS_SECRET_OPENAI}", baseURL: "https://api.example.com" },
        true,
      ),
    ).toEqual({
      apiKey: "{env:RCS_SECRET_OPENAI}",
      baseURL: "https://api.example.com",
      publicReadable: true,
    });
  });

  // ModelConfigDialog 使用资源 key 生成稳定引用，展示文案由前端拼 provider/source
  test("model config dialog options use resource key and display name", () => {
    expect(buildModelOptions([externalModel])).toEqual([
      { value: "org-source/provider-external/shared-model", label: "Source Team/OpenAI Shared/Shared Model" },
    ]);
  });

  // AgentFormDialog 保存模型 UUID，并展示由前端拼接的 provider/source 文案
  test("agent form model options use modelId and display name", () => {
    expect(mapModelOptions([externalModel])).toEqual([
      { value: "model-uuid-shared", label: "Source Team/OpenAI Shared/Shared Model" },
    ]);
  });
});
