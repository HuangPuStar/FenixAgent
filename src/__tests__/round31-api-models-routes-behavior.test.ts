import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ForbiddenError, NotFoundError } from "../errors";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { setTestOrgContext } from "../services/org-context";
import { resetAllStubs, stubConfigPg } from "../test-utils/helpers";

const apiModelsRoute = (await import("../routes/api/models")).default;

function request(path: string, init?: RequestInit) {
  return apiModelsRoute.handle(new Request(`http://localhost${path}`, init));
}

function access(publicReadable = false) {
  return {
    ownership: "internal" as const,
    sourceOrganizationId: "org-a",
    resourceUid: "provider-a",
    resourceKey: "org-a/provider-a",
    manageable: true,
    writable: true,
    publicReadable,
  };
}

type Model = {
  id: string;
  modelId: string;
  displayName: string | null;
  modalities: unknown;
  limitConfig: unknown;
  cost: unknown;
  options: unknown;
};

function provider(models: Model[] = []) {
  return {
    id: "provider-a",
    name: "openai",
    displayName: "OpenAI",
    protocol: "openai" as const,
    baseUrl: "https://models.example.test",
    apiKey: "secret-not-for-response",
    extraOptions: { region: "test" },
    resourceAccess: access(),
    models,
  };
}

function configureDefaults() {
  stubConfigPg({
    listProviders: async () => [],
    getProvider: async () => null,
    getProviderById: async () => null,
    upsertProvider: async () => "provider-a",
    updateProviderById: async () => true,
    deleteProviderById: async () => true,
    assertProviderInternalWritableById: async () => null,
    addModel: async () => "model-a",
    updateModelById: async () => false,
    removeModelById: async () => true,
  });
}

describe("API Models Routes round 31", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "user-a", email: "user-a@example.test", name: "User A" },
      authContext: { organizationId: "org-a", userId: "user-a", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org-a", userId: "user-a", role: "owner" });
    configureDefaults();
  });

  afterEach(() => {
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 认证上下文切换后，Provider 列表必须使用切换后的租户而非默认租户。
  test("uses a switched tenant context when listing providers", async () => {
    const listProviders = mock(async () => []);
    stubConfigPg({ listProviders });
    setTestAuth({
      user: { id: "user-b", email: "user-b@example.test", name: "User B" },
      authContext: { organizationId: "org-b", userId: "user-b", role: "member" },
    });
    await request("/api/models/providers");
    expect(listProviders).toHaveBeenCalledWith({ organizationId: "org-b", userId: "user-b", role: "member" });
  });

  // Provider 列表必须把当前组织认证上下文传给服务层。
  test("passes the current tenant context when listing providers", async () => {
    const listProviders = mock(async () => []);
    stubConfigPg({ listProviders });
    await request("/api/models/providers");
    expect(listProviders).toHaveBeenCalledWith({ organizationId: "org-a", userId: "user-a", role: "owner" });
  });

  // Provider 列表默认使用第一页和二十条分页参数。
  test("uses default provider pagination", async () => {
    const res = await request("/api/models/providers");
    expect(await res.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
  });

  // Provider 列表应在第二页截取正确的项目。
  test("slices provider results for a later page", async () => {
    stubConfigPg({
      listProviders: async () => [
        { ...provider(), id: "p-1", name: "one", modelCount: 1 },
        { ...provider(), id: "p-2", name: "two", modelCount: 2 },
        { ...provider(), id: "p-3", name: "three", modelCount: 3 },
      ],
    });
    const res = await request("/api/models/providers?page=2&pageSize=2");
    expect(await res.json()).toMatchObject({ total: 3, page: 2, pageSize: 2, items: [{ id: "p-3", name: "three" }] });
  });

  // Provider 列表超出末页时应返回空项目而保留总数。
  test("returns an empty provider page beyond the result set", async () => {
    stubConfigPg({ listProviders: async () => [{ ...provider(), modelCount: 0 }] });
    const res = await request("/api/models/providers?page=3&pageSize=1");
    expect(await res.json()).toMatchObject({ items: [], total: 1, page: 3, pageSize: 1 });
  });

  // Provider 列表 DTO 应把缺失的可选字段标准化为 null 或零。
  test("normalizes absent provider list fields", async () => {
    stubConfigPg({
      listProviders: async () => [{ id: "p", name: "minimal", protocol: "openai", resourceAccess: access() }],
    });
    const res = await request("/api/models/providers");
    expect(await res.json()).toMatchObject({ items: [{ displayName: null, baseUrl: null, modelCount: 0 }] });
  });

  // Provider 分页页码不能小于一。
  test("rejects provider page zero", async () => {
    const res = await request("/api/models/providers?page=0");
    expect(res.status).toBe(422);
  });

  // Provider 分页页码必须是整数。
  test("rejects fractional provider page", async () => {
    const res = await request("/api/models/providers?page=1.5");
    expect(res.status).toBe(422);
  });

  // Provider 分页大小不能为零。
  test("rejects provider page size zero", async () => {
    const res = await request("/api/models/providers?pageSize=0");
    expect(res.status).toBe(422);
  });

  // Provider 分页大小不能超过上限。
  test("rejects oversized provider page size", async () => {
    const res = await request("/api/models/providers?pageSize=101");
    expect(res.status).toBe(422);
  });

  // 创建 Provider 时名称不能为空。
  test("rejects an empty provider name", async () => {
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "" }),
    });
    expect(res.status).toBe(422);
  });

  // 创建 Provider 时协议必须属于受支持枚举。
  test("rejects an unsupported provider protocol", async () => {
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "x", protocol: "custom" }),
    });
    expect(res.status).toBe(422);
  });

  // 创建 Provider 时重复名称应返回冲突响应。
  test("returns conflict for an existing provider name", async () => {
    stubConfigPg({ getProvider: async () => provider() });
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "openai" }),
    });
    expect(await res.json()).toEqual({ error: { code: "CONFLICT", message: "Provider 'openai' already exists" } });
  });

  // 创建 Provider 的可空字段应通过请求验证并继续执行重复名称检查。
  test("accepts nullable provider fields before conflict detection", async () => {
    const upsertProvider = mock(async () => "provider-a");
    stubConfigPg({ upsertProvider, getProvider: async () => provider() });
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "openai",
        displayName: null,
        baseUrl: null,
        apiKey: null,
        extraOptions: null,
        publicReadable: true,
      }),
    });
    expect(res.status).toBe(409);
    expect(upsertProvider).not.toHaveBeenCalled();
  });

  // 创建成功但无法回读 Provider 时应返回稳定内部错误。
  test("returns an internal error when a created provider cannot be reloaded", async () => {
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(await res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "Provider could not be reloaded" } });
  });

  // 创建 Provider 时服务层业务异常应保留状态和错误码。
  test("maps provider creation business errors", async () => {
    stubConfigPg({
      getProvider: async () => {
        throw new ForbiddenError("tenant cannot create providers");
      },
    });
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "tenant cannot create providers" } });
  });

  // 创建 Provider 时未知异常应映射成内部错误。
  test("maps unexpected provider creation errors", async () => {
    stubConfigPg({
      getProvider: async () => {
        throw new Error("storage unavailable");
      },
    });
    const res = await request("/api/models/providers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "new" }),
    });
    expect(await res.json()).toEqual({ error: { code: "INTERNAL_ERROR", message: "storage unavailable" } });
  });

  // Provider 详情不存在时应返回资源标识对应的错误消息。
  test("returns not found for an unknown provider detail", async () => {
    const res = await request("/api/models/providers/missing");
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Provider 'missing' not found" } });
  });

  // Provider 详情 DTO 不应输出模型内部 options 字段。
  test("omits model options from provider detail DTOs", async () => {
    stubConfigPg({
      getProviderById: async () =>
        provider([
          {
            id: "m",
            modelId: "gpt",
            displayName: "GPT",
            modalities: ["text"],
            limitConfig: null,
            cost: null,
            options: { secret: "hidden" },
          },
        ]),
    });
    const res = await request("/api/models/providers/provider-a");
    const json = await res.json();
    expect("options" in json.models[0]).toBe(false);
  });

  // Provider 详情应将缺失模型字段标准化为 null。
  test("normalizes nullable model fields in provider detail", async () => {
    stubConfigPg({
      getProviderById: async () =>
        provider([
          {
            id: "m",
            modelId: "gpt",
            displayName: null,
            modalities: null,
            limitConfig: null,
            cost: null,
            options: null,
          },
        ]),
    });
    const res = await request("/api/models/providers/provider-a");
    expect(await res.json()).toMatchObject({
      models: [{ displayName: null, modalities: null, limitConfig: null, cost: null }],
    });
  });

  // 更新不存在的 Provider 不得调用写入服务。
  test("does not update a missing provider", async () => {
    const updateProviderById = mock(async () => true);
    stubConfigPg({ updateProviderById });
    const res = await request("/api/models/providers/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "X" }),
    });
    expect(res.status).toBe(404);
    expect(updateProviderById).not.toHaveBeenCalled();
  });

  // 更新 Provider 写入失败时应返回未找到。
  test("returns not found when provider update loses the row", async () => {
    stubConfigPg({ assertProviderInternalWritableById: async () => provider(), updateProviderById: async () => false });
    const res = await request("/api/models/providers/provider-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  // 更新 Provider 后回读失败应返回内部错误。
  test("returns internal error when updated provider cannot be reloaded", async () => {
    stubConfigPg({ assertProviderInternalWritableById: async () => provider(), updateProviderById: async () => true });
    const res = await request("/api/models/providers/provider-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
  });

  // 更新 Provider 请求体的未知字段不应进入服务数据。
  test("does not forward unknown provider update fields", async () => {
    const updateProviderById = mock(async () => true);
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider(),
      updateProviderById,
      getProviderById: async () => provider(),
    });
    await request("/api/models/providers/provider-a", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "Changed", ignored: "value" }),
    });
    expect(updateProviderById).toHaveBeenCalledWith(
      expect.anything(),
      "provider-a",
      { displayName: "Changed", protocol: "openai", baseUrl: undefined, apiKey: undefined, extraOptions: undefined },
      { publicReadable: undefined },
    );
  });

  // 删除 Provider 必须使用当前租户上下文和路径 ID。
  test("deletes a provider within the current tenant", async () => {
    const deleteProviderById = mock(async () => true);
    stubConfigPg({ deleteProviderById });
    const res = await request("/api/models/providers/provider-a", { method: "DELETE" });
    expect(await res.json()).toEqual({ id: "provider-a", deleted: true });
    expect(deleteProviderById).toHaveBeenCalledWith(
      { organizationId: "org-a", userId: "user-a", role: "owner" },
      "provider-a",
    );
  });

  // 删除不存在的 Provider 应返回未找到。
  test("returns not found when deleting an absent provider", async () => {
    stubConfigPg({ deleteProviderById: async () => false });
    const res = await request("/api/models/providers/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  // 删除 Provider 的服务层异常应映射为客户端错误。
  test("maps provider deletion business errors", async () => {
    stubConfigPg({
      deleteProviderById: async () => {
        throw new NotFoundError("Provider", "gone");
      },
    });
    const res = await request("/api/models/providers/provider-a", { method: "DELETE" });
    expect(await res.json()).toEqual({ error: { code: "NOT_FOUND", message: "Provider" } });
  });

  // Model 列表必须使用当前认证租户读取 Provider。
  test("passes tenant context when listing models", async () => {
    const getProviderById = mock(async () => provider());
    stubConfigPg({ getProviderById });
    await request("/api/models/providers/provider-a/models");
    expect(getProviderById).toHaveBeenCalledWith(
      { organizationId: "org-a", userId: "user-a", role: "owner" },
      "provider-a",
    );
  });

  // Model 列表应分页并保留 DTO 的 Provider 元数据。
  test("paginates model list items with provider metadata", async () => {
    stubConfigPg({
      getProviderById: async () =>
        provider([
          {
            id: "m1",
            modelId: "one",
            displayName: "One",
            modalities: null,
            limitConfig: null,
            cost: null,
            options: null,
          },
          {
            id: "m2",
            modelId: "two",
            displayName: "Two",
            modalities: null,
            limitConfig: null,
            cost: null,
            options: null,
          },
        ]),
    });
    const res = await request("/api/models/providers/provider-a/models?page=2&pageSize=1");
    expect(await res.json()).toMatchObject({
      total: 2,
      items: [{ providerId: "provider-a", providerName: "openai", id: "m2" }],
    });
  });

  // Model 列表不存在 Provider 时应返回未找到。
  test("returns not found for model list of an unknown provider", async () => {
    const res = await request("/api/models/providers/missing/models");
    expect(res.status).toBe(404);
  });

  // Model 列表查询也应拒绝超过上限的分页大小。
  test("rejects oversized model list page size", async () => {
    const res = await request("/api/models/providers/provider-a/models?pageSize=999");
    expect(res.status).toBe(422);
  });

  // 创建 Model 时 modelId 是必填输入。
  test("rejects model creation without modelId", async () => {
    const res = await request("/api/models/providers/provider-a/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  // 创建 Model 时限制配置中的数值必须是整数。
  test("rejects fractional model context limit", async () => {
    const res = await request("/api/models/providers/provider-a/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt", limitConfig: { context: 1.2 } }),
    });
    expect(res.status).toBe(422);
  });

  // 创建 Model 时不存在 Provider 不得写入模型。
  test("does not add a model to a missing provider", async () => {
    const addModel = mock(async () => "m");
    stubConfigPg({ addModel });
    const res = await request("/api/models/providers/missing/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt" }),
    });
    expect(res.status).toBe(404);
    expect(addModel).not.toHaveBeenCalled();
  });

  // 创建重复 Model ID 应在写入前返回冲突。
  test("returns conflict for a duplicate model ID", async () => {
    const addModel = mock(async () => "m2");
    stubConfigPg({
      assertProviderInternalWritableById: async () =>
        provider([
          {
            id: "m1",
            modelId: "gpt",
            displayName: null,
            modalities: null,
            limitConfig: null,
            cost: null,
            options: null,
          },
        ]),
      addModel,
    });
    const res = await request("/api/models/providers/provider-a/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt" }),
    });
    expect(res.status).toBe(409);
    expect(addModel).not.toHaveBeenCalled();
  });

  // 创建 Model 应把公开 DTO 字段原样传递给配置服务。
  test("maps model creation DTO fields to service data", async () => {
    const addModel = mock(async () => "m1");
    const model = {
      id: "m1",
      modelId: "gpt",
      displayName: "GPT",
      modalities: ["text"],
      limitConfig: { output: 100 },
      cost: { input: 1 },
      options: { tier: "x" },
    };
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider(),
      addModel,
      getProviderById: async () => provider([model]),
    });
    await request("/api/models/providers/provider-a/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        modelId: "gpt",
        displayName: "GPT",
        modalities: ["text"],
        limitConfig: { output: 100 },
        cost: { input: 1 },
        options: { tier: "x" },
      }),
    });
    expect(addModel).toHaveBeenCalledWith(expect.anything(), "provider-a", {
      modelId: "gpt",
      displayName: "GPT",
      modalities: ["text"],
      limitConfig: { output: 100 },
      cost: { input: 1 },
      options: { tier: "x" },
    });
  });

  // 创建 Model 后无法找到新条目时应返回内部错误。
  test("returns internal error when created model cannot be reloaded", async () => {
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider(),
      getProviderById: async () => provider(),
    });
    const res = await request("/api/models/providers/provider-a/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ modelId: "gpt" }),
    });
    expect(res.status).toBe(500);
  });

  // Model 详情 DTO 应拒绝数组类型 options 并标准化为 null。
  test("normalizes array model options to null in model detail", async () => {
    stubConfigPg({
      getProviderById: async () =>
        provider([
          {
            id: "m",
            modelId: "gpt",
            displayName: null,
            modalities: null,
            limitConfig: null,
            cost: null,
            options: ["not-object"],
          },
        ]),
    });
    const res = await request("/api/models/providers/provider-a/models/m");
    expect(await res.json()).toMatchObject({ options: null });
  });

  // Model 详情 DTO 应保留对象类型 options。
  test("preserves object model options in model detail", async () => {
    stubConfigPg({
      getProviderById: async () =>
        provider([
          {
            id: "m",
            modelId: "gpt",
            displayName: null,
            modalities: null,
            limitConfig: null,
            cost: null,
            options: { temperature: 0.2 },
          },
        ]),
    });
    const res = await request("/api/models/providers/provider-a/models/m");
    expect(await res.json()).toMatchObject({ options: { temperature: 0.2 } });
  });

  // Model 详情在 Provider 不存在时应返回未找到。
  test("returns not found when model detail provider is absent", async () => {
    const res = await request("/api/models/providers/missing/models/m");
    expect(res.status).toBe(404);
  });

  // Model 详情在模型不存在时应返回未找到。
  test("returns not found when model detail is absent", async () => {
    stubConfigPg({ getProviderById: async () => provider() });
    const res = await request("/api/models/providers/provider-a/models/missing");
    expect(res.status).toBe(404);
  });

  // 更新 Model 时不存在 Provider 不得调用更新服务。
  test("does not update a model when provider is absent", async () => {
    const updateModelById = mock(async () => true);
    stubConfigPg({ updateModelById });
    const res = await request("/api/models/providers/missing/models/m", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: "X" }),
    });
    expect(res.status).toBe(404);
    expect(updateModelById).not.toHaveBeenCalled();
  });

  // 更新不存在 Model 时应返回未找到。
  test("returns not found when model update does not affect a row", async () => {
    stubConfigPg({ assertProviderInternalWritableById: async () => provider(), updateModelById: async () => false });
    const res = await request("/api/models/providers/provider-a/models/missing", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  // 更新 Model 时 null 字段应按 API DTO 原样传给配置服务。
  test("maps nullable model update fields to service data", async () => {
    const updateModelById = mock(async () => true);
    const model = {
      id: "m",
      modelId: "gpt",
      displayName: null,
      modalities: null,
      limitConfig: null,
      cost: null,
      options: null,
    };
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider(),
      updateModelById,
      getProviderById: async () => provider([model]),
    });
    await request("/api/models/providers/provider-a/models/m", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ displayName: null, modalities: null, limitConfig: null, cost: null, options: null }),
    });
    expect(updateModelById).toHaveBeenCalledWith(expect.anything(), "provider-a", "m", {
      modalities: null,
      limitConfig: null,
      cost: null,
      options: null,
    });
  });

  // 更新 Model 后回读不到目标条目时应返回内部错误。
  test("returns internal error when updated model cannot be reloaded", async () => {
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider(),
      updateModelById: async () => true,
      getProviderById: async () => provider(),
    });
    const res = await request("/api/models/providers/provider-a/models/m", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(500);
  });

  // 删除 Model 时不存在 Provider 不得调用删除服务。
  test("does not delete a model when provider is absent", async () => {
    const removeModelById = mock(async () => true);
    stubConfigPg({ removeModelById });
    const res = await request("/api/models/providers/missing/models/m", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(removeModelById).not.toHaveBeenCalled();
  });

  // 删除不存在 Model 时应返回未找到。
  test("returns not found when deleting an absent model", async () => {
    stubConfigPg({ assertProviderInternalWritableById: async () => provider() });
    const res = await request("/api/models/providers/provider-a/models/missing", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  // 删除 Model 的写入失败应返回未找到而不是成功响应。
  test("returns not found when model deletion loses the row", async () => {
    const model = {
      id: "m",
      modelId: "gpt",
      displayName: null,
      modalities: null,
      limitConfig: null,
      cost: null,
      options: null,
    };
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider([model]),
      removeModelById: async () => false,
    });
    const res = await request("/api/models/providers/provider-a/models/m", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  // 删除 Model 成功响应应包含内部 ID、公共 modelId 和 Provider ID。
  test("returns stable identifiers after model deletion", async () => {
    const model = {
      id: "m",
      modelId: "gpt",
      displayName: null,
      modalities: null,
      limitConfig: null,
      cost: null,
      options: null,
    };
    const removeModelById = mock(async () => true);
    stubConfigPg({ assertProviderInternalWritableById: async () => provider([model]), removeModelById });
    const res = await request("/api/models/providers/provider-a/models/m", { method: "DELETE" });
    expect(await res.json()).toEqual({ providerId: "provider-a", id: "m", modelId: "gpt", deleted: true });
    expect(removeModelById).toHaveBeenCalledWith(
      { organizationId: "org-a", userId: "user-a", role: "owner" },
      "provider-a",
      "m",
    );
  });

  // 删除 Model 时服务层禁止错误应保留禁止状态。
  test("maps model deletion authorization errors", async () => {
    const model = {
      id: "m",
      modelId: "gpt",
      displayName: null,
      modalities: null,
      limitConfig: null,
      cost: null,
      options: null,
    };
    stubConfigPg({
      assertProviderInternalWritableById: async () => provider([model]),
      removeModelById: async () => {
        throw new ForbiddenError("shared provider is read-only");
      },
    });
    const res = await request("/api/models/providers/provider-a/models/m", { method: "DELETE" });
    expect(await res.json()).toEqual({ error: { code: "FORBIDDEN", message: "shared provider is read-only" } });
  });
});
