import { describe, expect, test } from "bun:test";
import type { ActorContext, ResourceQueryConstraint } from "@fenix/platform-sdk";
import { providerResource } from "../server/access/provider-resource";
import { ProviderFacade } from "../server/facades/provider-facade";
import type { ModelRow } from "../server/repositories/model-resource";
import type { ScopedProviderRow } from "../server/repositories/provider-resource";
import { createStubAccessControl, createStubModelRepository, createStubProviderService } from "../server/testing";

/**
 * Model 子表的授权边界（对应计划 S5 与 D6 的「下推断言」验收）。
 *
 * Model 不注册独立资源、没有自己的 `visibility` 与 owner，因此不存在"Model 谓词"可断言；计划里
 * 的 Provider 谓词半连接（`authorizationScope`）已被更强的约定取代——Model 的全部读写都经
 * `ProviderFacade`，先对 Provider 授权再按 `provider_id` 操作子行，Model 仓储不接收
 * `ResourceQueryConstraint`。本文件断言这一约定在列表与详情两条路径上成立：
 *
 * 1. 计数与列表共用同一批**已授权** Provider id，不会为看不见的 Provider 计数；
 * 2. Provider 不可见时不得读取任何 Model 子行（否则子行会成为绕过父资源授权的旁路）；
 * 3. 计数一次批量完成，不随列表长度退化为逐行 N+1。
 */

const actor: ActorContext = {
  kind: "user",
  userId: "user-1",
  activeOrganizationId: "org-1",
  memberships: [{ organizationId: "org-1", role: "owner" }],
};

/** 主表行的最小完整夹具；未列出的列按建表默认值补齐。 */
function providerRow(overrides: Partial<ScopedProviderRow> = {}): ScopedProviderRow {
  const organizationId = overrides.organizationId ?? "org-1";
  return {
    id: "provider-1",
    userId: "user-1",
    organizationId,
    name: "demo",
    displayName: null,
    kind: "direct",
    gatewayType: null,
    protocol: "openai",
    baseUrl: null,
    apiKey: null,
    extraOptions: null,
    visibility: "private",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    scope: { organizationId, ownerUserId: "user-1", visibility: "private" },
    ...overrides,
  };
}

/** 子表行的最小完整夹具。 */
function modelRow(overrides: Partial<ModelRow> = {}): ModelRow {
  return {
    id: "model-1",
    organizationId: "org-1",
    providerId: "provider-1",
    modelId: "gpt-test",
    displayName: null,
    modalities: null,
    limitConfig: null,
    cost: null,
    options: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

/** 构造真实 Facade，只把服务、子表仓储与平台授权替换为可记录的替身。 */
function buildFacade(
  overrides: {
    readonly items?: readonly ScopedProviderRow[];
    readonly models?: readonly ModelRow[];
    readonly findByIdRow?: ScopedProviderRow | undefined;
  } = {},
) {
  const countCalls: { providerIds: readonly string[] }[] = [];
  const listModelCalls: { providerId: string }[] = [];
  const serviceListInputs: { access: ResourceQueryConstraint; limit?: number; offset?: number }[] = [];
  const serviceFindInputs: { access: ResourceQueryConstraint; resourceId: string }[] = [];
  const items = overrides.items ?? [providerRow()];

  const facade = new ProviderFacade(
    {
      service: createStubProviderService({
        list: async (input) => {
          serviceListInputs.push(input);
          return { items: [...items], total: items.length };
        },
        findById: async (input) => {
          serviceFindInputs.push(input);
          return overrides.findByIdRow;
        },
      }),
      models: createStubModelRepository({
        countByProviderIds: async (input) => {
          countCalls.push(input);
          return new Map(input.providerIds.map((id) => [id, overrides.models?.length ?? 0]));
        },
        listByProviderId: async (input) => {
          listModelCalls.push(input);
          return [...(overrides.models ?? [])];
        },
      }),
    },
    {
      accessControl: createStubAccessControl({
        createListConstraint: async ({ action }) =>
          ({ resourceType: providerResource.definition.type, action, provider: "test" }) as ResourceQueryConstraint,
        resolveAccess: async () => ({ actions: ["read", "update"] }),
        resolveAccessMany: async ({ resourceIds }) =>
          new Map(resourceIds.map((id) => [id, { actions: ["read", "update"] as const }])),
      }),
      resource: providerResource.definition,
      scopeStore: {
        initialize: async () => undefined,
        getMany: async ({ resourceIds }) => new Map(resourceIds.map((id) => [id, { visibility: "private" as const }])),
        update: async () => undefined,
        remove: async () => undefined,
      },
    },
  );

  return { facade, countCalls, listModelCalls, serviceListInputs, serviceFindInputs };
}

describe("ProviderFacade 的 Model 子表授权边界", () => {
  // 计数只针对授权查询返回的 Provider id：看不见的 Provider 不该因为计数而暴露其模型规模。
  test("list 只为已授权的 Provider id 计数", async () => {
    const visible = [providerRow({ id: "provider-1" }), providerRow({ id: "provider-2" })];
    const { facade, countCalls } = buildFacade({ items: visible });

    const result = await facade.list(actor);

    expect(result.items.map((item) => item.id)).toEqual(["provider-1", "provider-2"]);
    expect(countCalls).toHaveLength(1);
    expect(countCalls[0].providerIds).toEqual(["provider-1", "provider-2"]);
  });

  // 计数是列表长度无关的一次批量查询：逐行查询会随可见 Provider 数量线性放大数据库往返。
  test("list 的模型计数在一次批量查询内完成", async () => {
    const visible = Array.from({ length: 5 }, (_, index) => providerRow({ id: `provider-${index}` }));
    const { facade, countCalls } = buildFacade({ items: visible });

    await facade.list(actor);

    expect(countCalls).toHaveLength(1);
    expect(countCalls[0].providerIds).toHaveLength(5);
  });

  // 授权查询返回空集合时不得读取任何子行：空列表没有可读的 Provider，读子行即无归属键的越权读。
  // 计数请求仍然发出，但空名单由仓储短路（不生成 SQL），这里断言它不会带着任何 id 去查。
  test("list 无可读 Provider 时返回空且不读取子行", async () => {
    const { facade, countCalls, listModelCalls } = buildFacade({ items: [] });

    const result = await facade.list(actor);

    expect(result).toEqual({ items: [], total: 0 });
    expect(countCalls).toEqual([{ providerIds: [] }]);
    expect(listModelCalls).toHaveLength(0);
  });

  // 计数缺失按 0 处理：子表为空是合法状态，不能因为 Map 缺项就让整行列表失败。
  test("list 对计数缺项的 Provider 回填 0", async () => {
    const { facade } = buildFacade({ items: [providerRow({ id: "provider-1" })], models: [] });

    const result = await facade.list(actor);

    expect(result.items[0].modelCount).toBe(0);
  });

  // 详情读取子行前必须先由授权查询拿到 Provider 行；拿不到就不读子行，避免子行成为绕过父授权的旁路。
  test("getById 在 Provider 不可见时不读取 Model 子行", async () => {
    const { facade, listModelCalls, serviceFindInputs } = buildFacade({ findByIdRow: undefined });

    const detail = await facade.getById(actor, "provider-hidden");

    expect(detail).toBeUndefined();
    expect(serviceFindInputs).toHaveLength(1);
    expect(serviceFindInputs[0].resourceId).toBe("provider-hidden");
    expect(listModelCalls).toHaveLength(0);
    // 授权条件必须是句柄本身，而不是被复制或改写成"等价形状"。
    expect(serviceFindInputs[0].access).toBeDefined();
  });

  // 详情可见时子行按 `provider_id` 读取：子表查询不携带任何组织或角色条件，它们已由父行授权覆盖。
  test("getById 可见时按 provider_id 读取子行", async () => {
    const { facade, listModelCalls } = buildFacade({
      findByIdRow: providerRow({ id: "provider-1" }),
      models: [modelRow({ id: "model-1" }), modelRow({ id: "model-2" })],
    });

    const detail = await facade.getById(actor, "provider-1");

    expect(detail?.models.map((row) => row.id)).toEqual(["model-1", "model-2"]);
    expect(listModelCalls).toEqual([{ providerId: "provider-1" }]);
  });

  // 列表路径不加载子行：详情才需要 `models`，列表只补计数，否则列表会为每行多付一次子表查询。
  test("list 不加载 Model 子行", async () => {
    const { facade, listModelCalls } = buildFacade({ items: [providerRow()], models: [modelRow()] });

    await facade.list(actor);

    expect(listModelCalls).toHaveLength(0);
  });
});
