import { describe, expect, test } from "bun:test";
import type { ProviderRow } from "../server/repositories/provider-resource";
import { createModelService } from "../server/services/model-service";
import { createStubModelRepository, createStubProviderRepository } from "../server/testing";

/**
 * 「组织内第一个已配置模型」的枚举规则（`ModelService.findFirstConfiguredByOrganizationUnscoped`）。
 *
 * 这条规则是启动路径上唯一决定「没指定模型的 Agent 用哪个模型」的地方，写成循环里的一个提前 return
 * 就会让「第一个 Provider 恰好没配模型」变成启动失败。排序键（`PROVIDER_LIST_ORDER`）由仓储保证，
 * 本服务只负责枚举与跳过，因此这里用替身声明顺序、只钉住服务的控制流。
 *
 * 迁移说明（W4b）：原断言在 `agent-runtime` 的 `round43-launch-spec-builder.test.ts`（用例「最小规格
 * 跳过无模型 provider」），它经真实的启动参数组装链间接覆盖本规则。组装实现搬到 `@fenix/agent-config`
 * 后，规则本身的 owner 是这里，故按断言面改写到这里，组装侧只保留"要一个可用的"。
 */

function provider(id: string): ProviderRow {
  return {
    id,
    userId: "user-1",
    organizationId: "org-1",
    name: `provider-${id}`,
    displayName: id,
    kind: "direct",
    gatewayType: null,
    protocol: "openai",
    baseUrl: "https://api.example.com",
    apiKey: "{env:KEY}",
    extraOptions: null,
    visibility: "private",
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function model(providerId: string, modelId: string) {
  return {
    id: `model-${modelId}`,
    organizationId: "org-1",
    providerId,
    modelId,
    displayName: modelId,
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

/** 按 providerId → 模型行的映射构造替身；映射里没有的 Provider 就是"没配模型"。 */
function serviceWith(modelsByProvider: Record<string, ReturnType<typeof model>>, providerIds: string[]) {
  return createModelService({
    modelRepository: createStubModelRepository({
      findFirstByProviderUnscoped: async ({ providerId }) => modelsByProvider[providerId],
    }),
    providerRepository: createStubProviderRepository({
      listByOrganizationUnscoped: async () => providerIds.map(provider),
    }),
  });
}

describe("组织内首个可用模型的枚举", () => {
  // 空 Provider 不能中断枚举：否则"第一个 Provider 恰好没配模型"会让后面配好的 Provider 永远选不上。
  test("跳过没有配置模型的 Provider", async () => {
    const service = serviceWith({ "p-2": model("p-2", "gpt-4o") }, ["p-1", "p-2", "p-3"]);

    const first = await service.findFirstConfiguredByOrganizationUnscoped("org-1");

    expect(first?.provider.id).toBe("p-2");
    expect(first?.model.modelId).toBe("gpt-4o");
  });

  // 按 Provider 顺序取第一个有模型的：顺序由仓储的排序键给出，本服务不得自行重排。
  test("按 Provider 顺序取第一个有模型的", async () => {
    const service = serviceWith({ "p-1": model("p-1", "first-model"), "p-2": model("p-2", "second-model") }, [
      "p-1",
      "p-2",
    ]);

    const first = await service.findFirstConfiguredByOrganizationUnscoped("org-1");

    expect(first?.model.modelId).toBe("first-model");
  });

  // 一个 Provider 都没配模型时返回 undefined：失败语义（"请先配置模型"）由调用方决定，服务不抛错。
  test("没有任何已配置模型时返回 undefined", async () => {
    const service = serviceWith({}, ["p-1", "p-2"]);

    expect(await service.findFirstConfiguredByOrganizationUnscoped("org-1")).toBeUndefined();
  });

  // 组织内没有 Provider 时同样返回 undefined：枚举的输入为空，不是异常。
  test("组织内没有 Provider 时返回 undefined", async () => {
    const service = serviceWith({}, []);

    expect(await service.findFirstConfiguredByOrganizationUnscoped("org-1")).toBeUndefined();
  });
});
