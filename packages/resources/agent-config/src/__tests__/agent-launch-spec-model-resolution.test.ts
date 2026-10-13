import { describe, expect, test } from "bun:test";
import { createModelService } from "@fenix/model-management/server";
import { createStubModelRepository, createStubProviderRepository } from "@fenix/model-management/server/testing";
import { AppError } from "@fenix/platform-sdk";
import type { RuntimeCredentialResolver } from "../server/services/agent-launch-spec";
import { resolveFirstConfiguredModel, resolveModelConfig } from "../server/services/agent-launch-spec/model-resolution";
import { launchSpecDeps, modelRow, providerRow, scopedAgent } from "./fixtures";

/**
 * 模型解析（`agent-launch-spec/model-resolution.ts`）的规则用例。
 *
 * 三块规则：**显式引用**（`modelId` → 模型行 → Provider 行，任一缺失即失败）、**回退**（配置没有
 * `modelId` 时取组织内第一个可用模型）、**网关凭证**（`kind = "gateway"` 的 Provider 用宿主注入的
 * 凭证解析器换密钥，而不是用 Provider 行里的明文 key）。
 *
 * 两个用户标识必须分开：回退选模型用 **Agent 配置属主**，网关凭证用 **实例属主**——后者与主体复验同源，
 * 写成同一个会让"谁在跑这个 Agent"与"这个配置归谁"混为一谈。
 *
 * 迁移说明（W4b）：本文件承接 `agent-runtime` 的 `round43` / `launch-spec-provider-model-access` /
 * `launch-spec-agent-sharing-access` / `launch-spec-model-gateway` / `launch-spec-builder-errors` 里的
 * 模型断言面（旧实现 `launch-spec-builder.ts` 已删除）。
 */

/** 捕获解析抛出的配置错误；不用 `rejects.toThrow` 是为了同时断言错误码与状态码。 */
async function captureConfigError(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }
  throw new Error("预期解析失败，但调用成功返回");
}

/** 用给定的模型行与 Provider 行组装依赖；未提供 Provider 行即模拟「行缺失」。 */
function depsWithModels(input: {
  model?: ReturnType<typeof modelRow>;
  provider?: ReturnType<typeof providerRow>;
  fallback?: ReturnType<typeof modelRow>;
}) {
  return launchSpecDeps({
    models: createModelService({
      modelRepository: createStubModelRepository({
        findRowUnscoped: async () => input.model,
        findFirstByProviderUnscoped: async () => input.fallback,
      }),
      providerRepository: createStubProviderRepository({
        findRowByOrganizationUnscoped: async ({ resourceId, organizationId }) =>
          input.provider && input.provider.id === resourceId && input.provider.organizationId === organizationId
            ? input.provider
            : undefined,
        listByOrganizationUnscoped: async () => (input.provider ? [input.provider] : []),
      }),
    }),
  });
}

describe("显式模型引用", () => {
  // 完整形状：Provider 名与协议、基地址、`{env:...}` 解引用后的密钥、模型标识（`model` 与 `modelName`
  // 同值——opencode / ccb 引擎用后者作运行时模型标识），以及 modalities。
  test("显式模型构成完整 ModelConfig", async () => {
    const deps = depsWithModels({
      model: modelRow({ modalities: ["text", "image"] }),
      provider: providerRow(),
    });

    const model = await resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1");

    expect(model).toEqual({
      provider: "openai",
      protocol: "openai",
      baseUrl: "https://api.example.com",
      apiKey: "resolved-key",
      model: "gpt-4o",
      modelName: "gpt-4o",
      modalities: ["text", "image"],
    });
  });

  // anthropic 协议要原样透传给 runtime（两种协议的请求形状不同，改写协议等于换了上游语义）。
  test("anthropic 协议原样透传", async () => {
    const deps = depsWithModels({
      model: modelRow(),
      provider: providerRow({ protocol: "anthropic", name: "anthropic-direct" }),
    });

    const model = await resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1");

    expect(model.protocol).toBe("anthropic");
    expect(model.provider).toBe("anthropic-direct");
  });

  // modalities 未配置时不下发该字段：空值由 runtime 按"未知"处理，传 undefined 会让它变成空数组。
  test("未配置 modalities 时省略该字段", async () => {
    const deps = depsWithModels({ model: modelRow(), provider: providerRow() });

    const model = await resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1");

    expect(model.modalities).toBeUndefined();
  });

  // 未知协议阻断启动：plugin-sdk 只声明 openai / anthropic，别的取值说明 Provider 行配错了。
  test("未知协议抛 INVALID_CONFIG", async () => {
    const deps = depsWithModels({
      model: modelRow(),
      provider: providerRow({ protocol: "gemini", name: "gemini-direct" }),
    });

    const error = await captureConfigError(() =>
      resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1"),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("unsupported protocol");
  });

  // Provider 行的 `{env:...}` 引用没解析到就是空串：绝不把引用式原样下发，让 agent 拿着 `{env:X}` 去连上游。
  test("未解析的环境变量引用退化为空密钥", async () => {
    const deps = depsWithModels({ model: modelRow(), provider: providerRow({ apiKey: "{env:MISSING_KEY}" }) });

    const model = await resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1");

    expect(model.apiKey).toBe("");
  });

  // 配置引用了不存在的模型行：失败文案要带上 AgentConfig 与 modelId，否则定位不到是哪次启动引用了它。
  test("模型行缺失时抛 INVALID_CONFIG", async () => {
    const deps = depsWithModels({ model: undefined, provider: providerRow() });

    const error = await captureConfigError(() =>
      resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1"),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references missing model id");
  });

  // 模型行存在但 Provider 行缺失同样阻断启动。
  test("Provider 行缺失时抛 INVALID_CONFIG", async () => {
    const deps = depsWithModels({ model: modelRow(), provider: undefined });

    const error = await captureConfigError(() =>
      resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1"),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references missing provider");
  });

  // Provider 行的组织条件取自**模型行**冗余的 `organization_id`，而不是调用方（Agent 配置）的组织：
  // Agent 配置在 org-1、模型与 Provider 行同属 org-other 时仍要解析成功——共享过来的配置就是这样跑起来的。
  // 若实现改用调用方组织，本例会以「Provider 行缺失」失败。
  test("Provider 行按模型行的组织匹配而非调用方组织", async () => {
    const deps = depsWithModels({
      model: modelRow({ organizationId: "org-other", providerId: "provider-1" }),
      provider: providerRow({ id: "provider-1", organizationId: "org-other", name: "openai-shared" }),
    });

    const model = await resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1");

    expect(model.provider).toBe("openai-shared");
    expect(model.model).toBe("gpt-4o");
  });

  // 模型行与 Provider 行的组织不一致属跨组织脏数据：不能拼成一份可运行的启动参数（否则等于把别的
  // 组织的凭据下发给本组织的实例）。
  test("Provider 行组织与模型行不一致时失败", async () => {
    const deps = depsWithModels({
      model: modelRow({ organizationId: "org-other", providerId: "provider-1" }),
      // Provider 行属于 org-1，与模型行的 org-other 不一致：按模型行组织读必然落空。
      provider: providerRow({ id: "provider-1", organizationId: "org-1" }),
    });

    const error = await captureConfigError(() =>
      resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1"),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("references missing provider");
  });
});

describe("无 modelId 时的模型回退", () => {
  // 配置没指定模型时取组织内第一个可用模型：回退用的用户标识取配置属主（表达"这个配置自己没有指定"）。
  test("按配置属主的组织取首个可用模型", async () => {
    const deps = launchSpecDeps({
      models: createModelService({
        modelRepository: createStubModelRepository({ findFirstByProviderUnscoped: async () => modelRow() }),
        providerRepository: createStubProviderRepository({
          listByOrganizationUnscoped: async () => [providerRow()],
        }),
      }),
    });

    const model = await resolveModelConfig(
      deps,
      scopedAgent({ modelId: null, organizationId: "org-1", ownerUserId: "owner-1" }),
      "user-1",
    );

    expect(model.model).toBe("gpt-4o");
    expect(model.apiKey).toBe("resolved-key");
  });

  // 组织内一个模型都没有时失败并引导先配置模型：这条回退不能静默产出一个不可运行的默认模型。
  test("组织内没有可用模型时抛 INVALID_CONFIG", async () => {
    const deps = launchSpecDeps({
      models: createModelService({
        modelRepository: createStubModelRepository(),
        providerRepository: createStubProviderRepository({ listByOrganizationUnscoped: async () => [] }),
      }),
    });

    const error = await captureConfigError(() =>
      resolveFirstConfiguredModel(deps, { organizationId: "org-1", userId: "user-1" }),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("requires at least one configured model");
  });
});

describe("模型网关凭证", () => {
  /** 网关 Provider：行里的 apiKey 是占位，真实密钥由凭证服务签发。 */
  const gatewayProvider = () => providerRow({ kind: "gateway", gatewayType: "litellm", apiKey: "inline-key" });

  // 网关 Provider 用凭证服务的签发结果，而不是 Provider 行里的 apiKey；请求主体是**实例属主**，
  // 与主体复验同源（网关凭证按"谁在跑这个 Agent"签发）。
  test("用凭证服务签发的密钥并携带实例属主", async () => {
    const seen: unknown[] = [];
    const resolver: RuntimeCredentialResolver = async (input) => {
      seen.push(input);
      return { status: "ready", externalCredentialId: "cred-1", secret: "issued-key" };
    };
    const deps = launchSpecDeps({
      models: createModelService({
        modelRepository: createStubModelRepository({ findRowUnscoped: async () => modelRow() }),
        providerRepository: createStubProviderRepository({
          findRowByOrganizationUnscoped: async () => gatewayProvider(),
        }),
      }),
      resolveRuntimeCredential: resolver,
    });

    const model = await resolveModelConfig(
      deps,
      scopedAgent({ modelId: "model-1", organizationId: "org-1" }),
      "instance-owner",
    );

    expect(model.apiKey).toBe("issued-key");
    expect(seen).toEqual([
      { gatewayProviderId: "provider-1", organizationId: "org-1", userId: "instance-owner", agentConfigId: "agent-1" },
    ]);
  });

  // 预算耗尽属业务性失败：400 + 专用错误码，前端据此提示用户而不是报服务故障；也不能退回明文 key。
  test("预算耗尽时抛 MODEL_GATEWAY_BUDGET_EXHAUSTED", async () => {
    const deps = launchSpecDeps({
      models: createModelService({
        modelRepository: createStubModelRepository({ findRowUnscoped: async () => modelRow() }),
        providerRepository: createStubProviderRepository({
          findRowByOrganizationUnscoped: async () => gatewayProvider(),
        }),
      }),
      resolveRuntimeCredential: async () => ({ status: "budget-exhausted" }),
    });

    const error = await captureConfigError(() =>
      resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1"),
    );

    expect(error.code).toBe("MODEL_GATEWAY_BUDGET_EXHAUSTED");
    expect(error.statusCode).toBe(400);
  });

  // 宿主没装配凭证解析器时直接失败：静默退回 Provider 行里的 apiKey 会把"网关未配置"伪装成"用明文 key 直连上游"。
  test("未装配凭证解析器时抛 INVALID_CONFIG", async () => {
    const deps = launchSpecDeps({
      models: createModelService({
        modelRepository: createStubModelRepository({ findRowUnscoped: async () => modelRow() }),
        providerRepository: createStubProviderRepository({
          findRowByOrganizationUnscoped: async () => gatewayProvider(),
        }),
      }),
    });

    const error = await captureConfigError(() =>
      resolveModelConfig(deps, scopedAgent({ modelId: "model-1" }), "user-1"),
    );

    expect(error.code).toBe("INVALID_CONFIG");
    expect(error.message).toContain("requires a configured model gateway");
  });
});
