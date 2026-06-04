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
  id: "shared-model",
  provider: "openai",
  fullId: "openai/shared-model",
  stableFullId: "org-source/provider-external/shared-model",
  label: "Shared Model",
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

  // ModelConfigDialog 优先提交 stableFullId，并展示来源组织
  test("model config dialog options prefer stableFullId", () => {
    expect(buildModelOptions([externalModel])).toEqual([
      { value: "org-source/provider-external/shared-model", label: "Source Team/openai/shared-model" },
    ]);
  });

  // AgentFormDialog 模型选项同样优先提交 stableFullId
  test("agent form model options prefer stableFullId", () => {
    expect(mapModelOptions([externalModel])).toEqual([
      { value: "org-source/provider-external/shared-model", label: "Source Team/openai/shared-model" },
    ]);
  });
});
