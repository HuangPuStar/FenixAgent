import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { type ModelGatewayServices, setModelGatewayServices } from "../server/model-gateway";
import { createApiSystemModelGatewayRoutes } from "../server/routes/api/system-model-gateway";
import { initializeModelManagementModuleConfig, resetModelManagementModuleForTesting } from "../server/testing";
import { createStubSystemApiGuardPlugin } from "./guard-stubs";

/**
 * `/api/system/model-gateway` 协议层（系统管理面）的边界用例。
 *
 * 这层是**系统 key 面**：调用方是运维脚本与系统主键，不是组织成员。因此它不按组织过滤数据，路由的
 * 责任是另外三件事，也正是本文件覆盖的三类断言：
 *
 * 1. **整组路由由守卫把关**：无系统 key 时每个端点都在 handler 之前 401，不靠下游服务兜底。
 * 2. **网关绑定不可由调用方改写**：`gatewayProviderId` 由服务层解析（`ensureProvider`），query 里同名
 *    字段会被 schema 剥离——否则调用方可以借筛选参数把查询指到别的网关 Provider 上。
 * 3. **凭据不外泄**：`/config` 不得回显管理密钥；`/keys` 只投影白名单字段（加密凭据、上游 key 明文都
 *    留在服务层）；失败分支只回通用文案，不回显上游错误正文（其中可能带密钥）。
 *
 * 组织维度的数据隔离不在这层：`/keys`、`/budgets` 的可见范围由 `key-management` / `budget` / `subject`
 * 服务按 Fenix 主体解析（各服务用例已覆盖），路由只是把 query 原样交给服务。本文件对它的断言是间接的
 * ——**路由不得放大或改写调用方给出的筛选条件**（见第 2 类的透传断言）。
 */

const ADMIN_KEY = "sk-admin-secret-1a2b";
const KEY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_PROVIDER_ID = "gateway-provider-1";

/** 系统 key 守卫的授权开关；`beforeEach` 复位为放行。 */
let authorized = true;

const route = createApiSystemModelGatewayRoutes({
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(() => authorized),
});

function request(path: string, init?: RequestInit) {
  return route.handle(new Request(`http://localhost${path}`, init));
}

function json(path: string, method: string, body: Record<string, unknown>) {
  return request(path, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** 未打桩的方法调用即抛错：漏配的替身会当场暴露，而不是静默返回 undefined 让断言失真。 */
function unstubbed(name: string): () => never {
  return () => {
    throw new Error(`模型网关服务替身未打桩：${name}`);
  };
}

/**
 * 只用被测端点实际调用的方法装配服务集。
 *
 * 这里的断言到 `ModelGatewayServices` 是必要的：路由从进程级注册表取整套服务，而用例只想控制被调用的
 * 那几个方法（其余保持"调用即失败"，把漏配变成显式失败）。逐个复刻五个服务的完整方法面会让本文件与
 * 服务实现同步漂移，代价大于收益。
 */
function installServices(overrides: Partial<ModelGatewayServices>): void {
  setModelGatewayServices({
    provider: {
      getConfiguration: unstubbed("provider.getConfiguration"),
      getProviderForCheck: unstubbed("provider.getProviderForCheck"),
      getProviderForUsage: unstubbed("provider.getProviderForUsage"),
      ensureProvider: unstubbed("provider.ensureProvider"),
      checkModels: unstubbed("provider.checkModels"),
      syncModels: unstubbed("provider.syncModels"),
      ...overrides.provider,
    },
    budget: {
      updateUserBudget: unstubbed("budget.updateUserBudget"),
      getUserBudget: unstubbed("budget.getUserBudget"),
      bulkUpdateUserBudgets: unstubbed("budget.bulkUpdateUserBudgets"),
      resetUserBudgets: unstubbed("budget.resetUserBudgets"),
      listUserBudgets: unstubbed("budget.listUserBudgets"),
      ...overrides.budget,
    },
    subject: {
      searchUsers: unstubbed("subject.searchUsers"),
      findUsers: unstubbed("subject.findUsers"),
      searchAgents: unstubbed("subject.searchAgents"),
      ...overrides.subject,
    },
    usage: { queryUsage: unstubbed("usage.queryUsage"), ...overrides.usage },
    keyManagement: {
      listKeys: unstubbed("keyManagement.listKeys"),
      removeKeys: unstubbed("keyManagement.removeKeys"),
      ...overrides.keyManagement,
    },
  } as unknown as ModelGatewayServices);
}

/** 系统网关 Provider 摘要夹具；形状对应 `ModelGatewayProviderSummary`。 */
function gatewayProviderSummary() {
  return {
    id: GATEWAY_PROVIDER_ID,
    name: "model-gateway",
    displayName: "Model Gateway",
    gatewayType: "litellm",
    baseUrl: "http://localhost:4000",
    modelCount: 2,
    owner: { email: "system@fenix.local", organizationSlug: "system" },
  };
}

/** 每个端点都挂着 `systemApiKeyAuth` 宏；请求体/查询按各自 schema 给足合法值以隔离"守卫 vs 校验"。 */
const SYSTEM_ROUTES: ReadonlyArray<{ method: string; path: string; body?: Record<string, unknown> }> = [
  { method: "GET", path: "/config" },
  { method: "GET", path: "/keys" },
  { method: "POST", path: "/keys/actions/remove", body: { ids: [KEY_ID] } },
  { method: "GET", path: "/models/status" },
  { method: "POST", path: "/models/actions/sync" },
  { method: "GET", path: "/budgets" },
  {
    method: "POST",
    path: "/budgets/actions/bulk-update",
    body: { userIds: ["user-1"], maxBudgetUsd: 5, duration: "monthly" },
  },
  { method: "POST", path: "/budgets/actions/bulk-reset", body: { userIds: ["user-1"] } },
  { method: "PUT", path: "/budgets/user-1", body: { maxBudgetUsd: 5, duration: "monthly" } },
  { method: "GET", path: "/subjects/users" },
  { method: "GET", path: "/subjects/agents" },
  { method: "GET", path: "/usage?startAt=2026-09-01&endAt=2026-09-20" },
];

describe("/api/system/model-gateway 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    resetModelManagementModuleForTesting();
    authorized = true;
    initializeModelManagementModuleConfig({
      modelGatewayAdminKey: ADMIN_KEY,
      modelGatewayDefaultUserBudgetUsd: 10,
      modelGatewayDefaultBudgetDuration: "monthly",
    });
    installServices({});
  });

  afterEach(() => {
    setModelGatewayServices(null);
    resetModelManagementModuleForTesting();
    resetAllStubs();
  });

  // 系统 key 缺失时整组端点必须在进入业务逻辑前 401；服务替身全部未打桩，绕守卫就会以抛错失败。
  test("缺少系统 key 时全部端点返回 401", async () => {
    authorized = false;

    for (const entry of SYSTEM_ROUTES) {
      const response =
        entry.body === undefined
          ? await request(`/api/system/model-gateway${entry.path}`, { method: entry.method })
          : await json(`/api/system/model-gateway${entry.path}`, entry.method, entry.body);

      expect(`${entry.method} ${entry.path} → ${response.status}`).toBe(`${entry.method} ${entry.path} → 401`);
      expect((await readJson(response)).error.code).toBe("UNAUTHORIZED");
    }
  });

  // /config 只投影网关摘要与控制台地址/默认预算；管理密钥（config 里显式标注"不得返回给浏览器"）必须缺席。
  test("配置响应投影白名单字段且不含管理密钥", async () => {
    installServices({ provider: { getConfiguration: async () => ({ provider: gatewayProviderSummary() }) } });

    const response = await request("/api/system/model-gateway/config");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain(ADMIN_KEY);
    expect(JSON.parse(text)).toEqual({
      provider: gatewayProviderSummary(),
      adminUiUrl: "http://localhost:4000/ui/",
      defaultBudget: { maxBudgetUsd: 10, duration: "monthly" },
    });
  });

  // 上游失败只回通用文案：适配器异常里可能带请求头或密钥，不能被响应体带走。
  test("配置读取失败返回通用错误且不回显上游正文", async () => {
    installServices({
      provider: {
        getConfiguration: async () => {
          throw new Error(`LiteLLM rejected admin key ${ADMIN_KEY}`);
        },
      },
    });

    const response = await request("/api/system/model-gateway/config");
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(text).not.toContain(ADMIN_KEY);
    expect(JSON.parse(text).error).toEqual({
      code: "MODEL_GATEWAY_ERROR",
      message: "Unable to get model gateway configuration",
    });
  });

  // /keys 只投影白名单字段：服务返回的加密凭据与上游 key 明文都不得进入响应体。
  test("Key 列表只投影白名单字段且不外泄凭据", async () => {
    const listKeys = mock(async () => ({
      items: [
        {
          id: KEY_ID,
          externalCredentialId: "litellm-credential-1",
          organizationId: "org-1",
          organizationName: "Org One",
          userId: "user-1",
          userName: "User One",
          agentConfigId: AGENT_ID,
          agentName: "Agent One",
          status: "active" as const,
          createdAt: new Date("2026-09-01T00:00:00.000Z"),
          updatedAt: new Date("2026-09-02T00:00:00.000Z"),
          usable: true,
          invalidReason: null,
          // 下面两个字段在服务层就被剥离/不应投影，出现在响应里就是凭据外泄。
          encryptedCredential: "enc:secret-blob",
          apiKey: "sk-live-secret-9f3a",
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    }));
    installServices({
      provider: { ensureProvider: async () => GATEWAY_PROVIDER_ID },
      keyManagement: { listKeys },
    });

    const response = await request("/api/system/model-gateway/keys?page=1&pageSize=20");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).not.toContain("enc:secret-blob");
    expect(text).not.toContain("sk-live-secret-9f3a");
    expect(JSON.parse(text)).toEqual({
      items: [
        {
          id: KEY_ID,
          externalCredentialId: "litellm-credential-1",
          organizationId: "org-1",
          organizationName: "Org One",
          userId: "user-1",
          userName: "User One",
          agentConfigId: AGENT_ID,
          agentName: "Agent One",
          status: "active",
          createdAt: "2026-09-01T00:00:00.000Z",
          updatedAt: "2026-09-02T00:00:00.000Z",
          usable: true,
          invalidReason: null,
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    });
    // 列表查询固定绑在系统 Gateway Provider 上，调用方不能指定别的 Provider。
    expect(listKeys).toHaveBeenCalledWith({ gatewayProviderId: GATEWAY_PROVIDER_ID, page: 1, pageSize: 20 });
  });

  // query 里的 `gatewayProviderId` 不是受支持字段：schema 必须把它剥离，否则调用方可以改写网关绑定。
  test("调用方不能通过 query 改写网关绑定", async () => {
    const queryUsage = mock(async () => ({ totalSpendUsd: 0, records: [], activeUserCount: 0 }));
    installServices({
      provider: { ensureProvider: async () => GATEWAY_PROVIDER_ID },
      usage: { queryUsage },
    });

    const response = await request(
      "/api/system/model-gateway/usage?startAt=2026-09-01&endAt=2026-09-20&organizationId=org-1&gatewayProviderId=someone-else",
    );

    expect(response.status).toBe(200);
    expect(queryUsage).toHaveBeenCalledWith({
      gatewayProviderId: GATEWAY_PROVIDER_ID,
      startAt: "2026-09-01",
      endAt: "2026-09-20",
      organizationId: "org-1",
    });
  });

  // 用量查询失败（含上游不可达）只回 400 通用文案，不回显上游正文。
  test("用量查询失败返回通用错误且不回显上游正文", async () => {
    installServices({
      provider: { ensureProvider: async () => GATEWAY_PROVIDER_ID },
      usage: {
        queryUsage: async () => {
          throw new Error(`LiteLLM usage endpoint rejected ${ADMIN_KEY}`);
        },
      },
    });

    const response = await request("/api/system/model-gateway/usage?startAt=2026-09-01&endAt=2026-09-20");
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain(ADMIN_KEY);
    expect(JSON.parse(text).error).toEqual({
      code: "MODEL_GATEWAY_ERROR",
      message: "Unable to query model gateway usage",
    });
  });

  // 主体查询把 Date 归一为 ISO 字符串：线上合同是字符串时间，不能让 Date 的序列化形态随宿主变化。
  test("用户主体列表把时间归一为 ISO 字符串", async () => {
    installServices({
      subject: {
        searchUsers: async () => ({
          items: [
            {
              id: "user-1",
              name: "User One",
              email: "user-1@fenix.local",
              emailVerified: true,
              phoneNumber: null,
              phoneNumberVerified: false,
              createdAt: new Date("2026-09-01T00:00:00.000Z"),
              updatedAt: new Date("2026-09-02T00:00:00.000Z"),
            },
          ],
          total: 1,
          page: 1,
          pageSize: 20,
        }),
      },
    });

    const body = await readJson(await request("/api/system/model-gateway/subjects/users?keyword=User"));

    expect(body.items[0].createdAt).toBe("2026-09-01T00:00:00.000Z");
    expect(body.items[0].updatedAt).toBe("2026-09-02T00:00:00.000Z");
  });

  // 网关不可用时状态检查返回 503（而不是把 unknown 吞成 200 的"已同步"）：前端据此显示连接失败。
  test("网关状态未知时返回 503 而不是 200", async () => {
    installServices({
      provider: {
        getProviderForCheck: async () => GATEWAY_PROVIDER_ID,
        checkModels: async () => ({ status: "unknown" as const, changes: [] }),
      },
    });

    const response = await request("/api/system/model-gateway/models/status");

    expect(response.status).toBe(503);
    expect((await readJson(response)).status).toBe("unknown");
  });

  // 查询参数越界必须在协议层拒绝，不得把非法分页交给服务层（服务层的不变量不处理负数页码）。
  test("查询参数越界时协议层拒绝", async () => {
    const response = await request("/api/system/model-gateway/keys?pageSize=500");

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
