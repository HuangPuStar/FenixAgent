// 本文件守护「授权视图 → 目录/编辑器的模型与 Provider 选项」这条链路，其中 `mapModelOptions` /
// `mapMcpOptions` 属 agent-config 的编辑域，按跨包规则从对方包根 `@fenix/agent-config/web` 消费。
//
// 历史（2026-09-20，已解除）：本链一度整文件 0 断言执行，两个原因都在宿主侧——`apps/web/src/i18n/index.ts`
// 曾按 observer 的旧布局深链 `web/i18n/{en,zh}/observer.json`（该包已迁到 `web/i18n/locales/**`），以及
// preload 把 `globalThis.window` 置成 globalThis，触发 `antd-style` 的 SSR 守卫裸调 `matchMedia`。宿主
// i18n 改指各包 `@fenix/*/web/i18n` 后本链已在无 DOM 的 `bun test` 进程里正常求值：实测本文件与
// `src/__tests__/agent-editor-model.test.ts` 合计 32 pass / 0 fail。保留这段记述是因为「无 DOM 进程里求值
// 整棵 UI 链」仍是本文件最脆弱的假设——再出现整文件 0 断言，先查宿主 i18n 与 preload 的加载期副作用，
// 而不是怀疑断言本身。
import { describe, expect, test } from "bun:test";
import { mapMcpOptions, mapModelOptions } from "@fenix/agent-config/web";
import type { ModelEntry, ProviderInfo } from "@fenix/web-runtime/types/config";
import { buildModelOptions } from "../components/config/ModelConfigDialog";
import type { ProviderResourceLike } from "../lib/provider-resource-access";
import {
  canManageProviderSharing,
  getProviderAccessBadgeKey,
  getProviderDisplayName,
  getProviderKey,
  isExternalProvider,
  isProviderWritable,
  isPublicProvider,
} from "../lib/provider-resource-access";
import {
  buildProviderInlineTestPayload,
  buildProviderPublicReadablePayload,
  canWriteProvider,
  getProviderKey as getProviderCatalogKey,
  getProviderIconModelId,
  getProviderResourceBadgeKey,
  providerMatchesScope,
  supportsThinking,
} from "../pages/agent-panel/pages/agent-models-utils";

const ACTIVE_ORG_ID = "org-current";

/** 本组织 Provider：具备 update 动作，可写且可管理公开受众。 */
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
  scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
  access: { actions: ["read", "update", "delete"] },
};

/** 跨组织 Provider：只有 read 动作，界面必须完全只读。 */
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
  scope: { organizationId: "org-source", visibility: "private" },
  access: { actions: ["read"] },
};

/** 已对其他组织公开的本组织 Provider。 */
const publicProvider: ProviderInfo = {
  ...internalProvider,
  scope: { ...internalProvider.scope, visibility: "public" },
};

/** 共享来源模型：授权视图与公开状态继承所属 Provider，模型自身不持有归属。 */
const sharedModel: ModelEntry = {
  id: "model-uuid-shared",
  modelId: "shared-model",
  displayName: "Shared Model",
  provider: "openai",
  providerId: "provider-external",
  providerDisplayName: "OpenAI Shared",
  contextLimit: 128000,
  outputLimit: 4096,
  organizationName: "Source Team",
  scope: { organizationId: "org-source", visibility: "private" },
  access: { actions: ["read"] },
};

/** 本组织模型：与所属 Provider 同组织，具备写动作。 */
const internalModel: ModelEntry = {
  ...sharedModel,
  id: "model-uuid-internal",
  modelId: "internal-model",
  displayName: "Internal Model",
  providerId: "provider-internal",
  providerDisplayName: "OpenAI",
  organizationName: "Current Team",
  scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
  access: { actions: ["read", "update"] },
};

// `/web` MCP 视图的共享来源样例：新授权栈返回 `scope` + `organizationName`，不再有 `resourceAccess`。
const sharedMcpView = {
  scope: { organizationId: "org-source", visibility: "private" } as const,
  organizationName: "Source Team",
};

describe("provider model resource access flow", () => {
  // 同名 Provider 用归属范围与 providerId 生成的资源键区分，不会互相覆盖。
  test("uses scope organization id and provider id as the provider key", () => {
    expect(getProviderKey(internalProvider)).toBe("org-current/provider-internal");
    expect(getProviderKey(externalProvider)).toBe("org-source/provider-external");
    // 列表消费点与授权子模块共用同一份键推导，避免两处漂移。
    expect(getProviderCatalogKey(externalProvider)).toBe("org-source/provider-external");
  });

  // 展示名取配置的展示名，缺失或为空时退回配置名，不得展示空名称。
  test("falls back to the provider config name when display name is missing", () => {
    expect(getProviderDisplayName(internalProvider)).toBe("OpenAI");
    expect(getProviderDisplayName({ ...internalProvider, name: "" })).toBe("openai");
    expect(getProviderDisplayName({ id: "legacy-provider" })).toBe("legacy-provider");
  });

  // 跨组织资源按 scope.organizationId 与当前组织比对判定，缺任一侧都按本组织处理。
  test("detects external providers by scope organization id", () => {
    expect(isExternalProvider(internalProvider, ACTIVE_ORG_ID)).toBe(false);
    expect(isExternalProvider(externalProvider, ACTIVE_ORG_ID)).toBe(true);
    // 组织上下文未就绪时不得把自己的 Provider 误判为共享来源。
    expect(isExternalProvider(externalProvider, undefined)).toBe(false);
    // 无归属组织的个人资源按本组织处理。
    expect(isExternalProvider({ id: "personal" }, ACTIVE_ORG_ID)).toBe(false);
  });

  // 公开状态只由 scope.visibility 决定，与归属组织无关。
  test("reads public visibility from scope only", () => {
    expect(isPublicProvider(internalProvider)).toBe(false);
    expect(isPublicProvider(publicProvider)).toBe(true);
  });

  // 可写性只由 access.actions 的 update 决定，跨组织 Provider 只有 read 动作时只读。
  test("marks external providers as read-only", () => {
    expect(isProviderWritable(internalProvider)).toBe(true);
    expect(isProviderWritable(externalProvider)).toBe(false);
    expect(isProviderWritable({ ...internalProvider, access: { actions: ["read", "create", "delete"] } })).toBe(false);
    expect(canWriteProvider(internalProvider)).toBe(true);
    expect(canWriteProvider(externalProvider)).toBe(false);
  });

  // 授权视图缺失时保守拒绝写权限，不得沿用旧栈「字段缺失即放行」的兜底。
  test("denies write access when the authorization view is missing", () => {
    const withoutAccess: ProviderResourceLike = { id: "legacy-provider", scope: internalProvider.scope };
    expect(isProviderWritable(withoutAccess)).toBe(false);
    expect(canManageProviderSharing(withoutAccess)).toBe(false);
    expect(canManageProviderSharing({ ...withoutAccess, access: {} })).toBe(false);
  });

  // 系统托管的 Gateway Provider 界面保持只读，避免暴露必然返回 FORBIDDEN 的写入口。
  test("keeps gateway providers read-only", () => {
    const gatewayProvider: ProviderInfo = { ...internalProvider, kind: "gateway", gatewayType: "litellm" };
    expect(canWriteProvider(gatewayProvider)).toBe(false);
    // 授权动作本身仍表明主体对该 Provider 配置有写权限，只读是目录层的额外约束。
    expect(isProviderWritable(gatewayProvider)).toBe(true);
  });

  // 公开受众变更与写配置同权：只有具备 update 动作的主体才能管理。
  test("requires the update action to manage sharing", () => {
    expect(canManageProviderSharing(internalProvider)).toBe(true);
    expect(canManageProviderSharing(externalProvider)).toBe(false);
  });

  // 角标优先级：跨组织共享优先，其次公开，否则本组织私有。
  test("derives the access badge key from scope", () => {
    expect(getProviderResourceBadgeKey(internalProvider, ACTIVE_ORG_ID)).toBe("resource.internal");
    expect(getProviderResourceBadgeKey(externalProvider, ACTIVE_ORG_ID)).toBe("resource.external");
    expect(getProviderResourceBadgeKey(publicProvider, ACTIVE_ORG_ID)).toBe("resource.public");
    expect(getProviderAccessBadgeKey(externalProvider, ACTIVE_ORG_ID)).toBe("resource.external");
  });

  // 本组织与公开是独立且可重叠的筛选维度。
  test("matches provider organization and public scopes independently", () => {
    const publicExternalProvider: ProviderInfo = {
      ...externalProvider,
      scope: { ...externalProvider.scope, visibility: "public" },
    };

    expect(providerMatchesScope(internalProvider, "all", ACTIVE_ORG_ID)).toBe(true);
    expect(providerMatchesScope(internalProvider, "organization", ACTIVE_ORG_ID)).toBe(true);
    expect(providerMatchesScope(externalProvider, "organization", ACTIVE_ORG_ID)).toBe(false);
    expect(providerMatchesScope(publicProvider, "public", ACTIVE_ORG_ID)).toBe(true);
    expect(providerMatchesScope(publicExternalProvider, "public", ACTIVE_ORG_ID)).toBe(true);
    expect(providerMatchesScope(externalProvider, "public", ACTIVE_ORG_ID)).toBe(false);
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

  // 公开受众写载荷仍以 publicReadable 表达受众变更（写协议不随响应视图切换而改变）。
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

  // 模型选项值使用所属 Provider 的资源键，保证跨组织同名 Provider 的模型引用唯一。
  test("model config dialog options use the provider resource key and display name", () => {
    expect(buildModelOptions([sharedModel])).toEqual([
      { value: "org-source/provider-external/shared-model", label: "Source Team/OpenAI Shared/Shared Model" },
    ]);
  });

  // Provider 资源键不可推导时（缺 providerId）退回 ${provider}/${modelId} 旧格式。
  test("falls back to the legacy model option value without a provider id", () => {
    const { providerId: _providerId, organizationName: _organizationName, ...legacyModel } = sharedModel;
    expect(buildModelOptions([legacyModel])).toEqual([
      { value: "openai/shared-model", label: "OpenAI Shared/Shared Model" },
    ]);
  });

  // 模型共享来源由所属 Provider 的 scope 判定，分组 id 即 Provider 资源键，不会合并跨组织同名服务商。
  test("groups models by their provider with the inherited scope", () => {
    expect(mapModelOptions([internalModel, sharedModel], ACTIVE_ORG_ID)).toEqual([
      {
        value: "model-uuid-internal",
        label: "Internal Model",
        modelId: "internal-model",
        group: { id: "org-current/provider-internal", label: "OpenAI", scope: "organization" },
      },
      {
        value: "model-uuid-shared",
        label: "Shared Model",
        modelId: "shared-model",
        group: { id: "org-source/provider-external", label: "OpenAI Shared", scope: "shared" },
      },
    ]);
  });

  // 组织上下文缺失或模型未带授权视图时，模型按本组织分组，不得冒充共享来源。
  test("keeps models in the organization group without an active organization", () => {
    const { scope: _scope, access: _access, ...modelWithoutAccessView } = internalModel;
    expect(mapModelOptions([internalModel], undefined)[0]?.group.scope).toBe("organization");
    // 授权视图缺失时归属键退化为 Provider 配置名。
    expect(mapModelOptions([modelWithoutAccessView])[0]?.group).toEqual({
      id: "openai",
      label: "OpenAI",
      scope: "organization",
    });
  });

  // AgentFormDialog 的 MCP 选项只展示已启用项，避免禁用 MCP 继续出现在绑定候选中
  test("agent form filters disabled mcp options", () => {
    expect(
      mapMcpOptions([
        { id: "mcp-external", name: "enabled-mcp", enabled: true, ...sharedMcpView },
        { id: "mcp-disabled", name: "disabled-mcp", enabled: false, ...sharedMcpView },
      ]),
    ).toEqual([
      {
        id: "mcp-external",
        key: "org-source/mcp-external",
        name: "enabled-mcp",
        label: "Source Team/enabled-mcp",
        scope: { organizationId: "org-source", visibility: "private" },
        organizationName: "Source Team",
      },
    ]);
  });
});
