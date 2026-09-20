import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ActorContext, MemberRole } from "@fenix/platform-sdk";
import { readJson, resetAllStubs } from "@fenix/platform-sdk/testing";
import { type ModelGatewayServices, setModelGatewayServices } from "../server/model-gateway";
import { ModelGatewayProviderNotVisibleError } from "../server/model-gateway/provider-service";
import { createWebModelGatewayRoutes } from "../server/routes/web/model-gateway";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

/**
 * `GET /web/model-gateway/:providerId/usage`（控制台用量页唯一的数据入口）的错误码边界用例。
 *
 * 这个端点此前把一切失败收敛成 400 `MODEL_GATEWAY_ERROR`，而页面的 forbidden 分支只在 `UNAUTHORIZED`
 * 时成立——于是「Provider 不可见」在页面上走可重试分支，渲染出一个永远失败的重试按钮。本文件钉住的
 * 正是这条分界（前端归一规则见 `web/__tests__/model-gateway-usage-page-states.test.tsx`）：
 *
 * 1. 不可见 → 403，且 `code` 必须是前端 `request` 层认识的 `UNAUTHORIZED`（自定义码会原样透传，页面
 *    仍然匹配不到 forbidden 分支）；
 * 2. 其余上游/网关类失败 → 400 `MODEL_GATEWAY_ERROR`，且不回显上游正文（其中可能带密钥）；
 * 3. 身份与网关绑定只能来自会话与服务解析：query 里的 `userId` 不得改写被查询的主体。
 *
 * 装配方式与 `/api/system/model-gateway` 用例一致：注入守卫替身 + 服务替身，不触碰宿主 `apps/server`。
 */

/** 当前请求的身份；守卫替身按取值函数读取。 */
let currentActor: ActorContext | null = null;

const route = createWebModelGatewayRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin(() => currentActor) });

function actorFixture(organizationId = "org-1", userId = "user-1", role: MemberRole = "owner"): ActorContext {
  return { kind: "user", userId, activeOrganizationId: organizationId, memberships: [{ organizationId, role }] };
}

function request(path: string) {
  return route.handle(new Request(`http://localhost${path}`));
}

/** 合法日期范围；两条必填 query 由 schema 强制，缺一即 422 而不是进入 handler。 */
const RANGE = "startAt=2026-09-01&endAt=2026-09-20";

/**
 * 未打桩的方法调用即失败：漏配的替身会当场暴露，而不是静默返回 undefined 让断言失真。
 *
 * 刻意用 `async` 而不是同步抛错：handler 里用量与预算是 `Promise.all` 的并行兄弟，若未打桩的一方同步
 * 抛错，已创建的另一方（本例是 `queryUsage` 的拒绝）就再没有处理器，bun 会把它当成未处理拒绝并把用例
 * 判失败——错误信息指向被覆盖的实现，而不是漏配的替身。
 */
function unstubbed(name: string): () => Promise<never> {
  return async () => {
    throw new Error(`模型网关服务替身未打桩：${name}`);
  };
}

/** 只用被测端点实际调用的三个服务装配；其余方法保持「调用即失败」。 */
function installServices(overrides: {
  provider?: Partial<ModelGatewayServices["provider"]>;
  budget?: Partial<ModelGatewayServices["budget"]>;
  usage?: Partial<ModelGatewayServices["usage"]>;
}): void {
  setModelGatewayServices({
    provider: { getProviderForUsage: unstubbed("provider.getProviderForUsage"), ...overrides.provider },
    budget: { getUserBudget: unstubbed("budget.getUserBudget"), ...overrides.budget },
    usage: { queryUsage: unstubbed("usage.queryUsage"), ...overrides.usage },
  } as unknown as ModelGatewayServices);
}

/** 网关 Provider 摘要夹具；形状对应 `getProviderForUsage` 的返回。 */
function gatewayProviderFixture() {
  return { id: "gateway-provider-1", name: "fenix-model-gateway", displayName: "全局模型网关" };
}

describe("/web/model-gateway/:providerId/usage 路由", () => {
  beforeEach(() => {
    resetAllStubs();
    currentActor = actorFixture();
    installServices({});
  });

  afterEach(() => {
    setModelGatewayServices(null);
    currentActor = null;
    resetAllStubs();
  });

  // Provider 不可见（不存在或超出可见范围）是确定性权限失败：必须 403，页面才走 forbidden 分支不给重试。
  test("不可见的 Provider 返回 403 且错误码是前端的 UNAUTHORIZED", async () => {
    installServices({
      provider: {
        getProviderForUsage: async (_actor, providerId) => {
          throw new ModelGatewayProviderNotVisibleError(providerId);
        },
      },
    });

    const response = await request(`/model-gateway/other-org-provider/usage?${RANGE}`);

    expect(response.status).toBe(403);
    // 归一码而不是自定义码：`normalizeErrorCode` 只放行已知码，否则页面匹配不到 forbidden 分支。
    expect((await readJson(response)).error).toEqual({
      code: "UNAUTHORIZED",
      message: "Model gateway provider is not visible to the current user",
    });
  });

  // 上游/网关类失败可能自愈：保持 400，页面据此给出重试入口；正文不得回显上游错误（可能带密钥）。
  test("上游查询失败返回 400 且不回显上游正文", async () => {
    installServices({
      provider: { getProviderForUsage: async () => gatewayProviderFixture() },
      budget: { getUserBudget: async () => null },
      usage: {
        queryUsage: async () => {
          throw new Error("litellm rejected admin key sk-admin-secret-1a2b");
        },
      },
    });

    const response = await request(`/model-gateway/gateway-provider-1/usage?${RANGE}`);
    const text = await response.text();

    expect(response.status).toBe(400);
    expect(text).not.toContain("sk-admin-secret-1a2b");
    expect(JSON.parse(text).error).toEqual({ code: "MODEL_GATEWAY_ERROR", message: "Unable to query usage" });
  });

  // Provider 不是本网关类型属于配置类故障（不是权限结果）：同样 400，不能伪装成 403 终态。
  test("Provider 不是本网关类型时返回 400", async () => {
    installServices({
      provider: {
        getProviderForUsage: async () => {
          throw new Error("model gateway provider is unavailable");
        },
      },
    });

    const response = await request(`/model-gateway/gateway-provider-1/usage?${RANGE}`);

    expect(response.status).toBe(400);
    expect((await readJson(response)).error.code).toBe("MODEL_GATEWAY_ERROR");
  });

  // 被查询主体与网关绑定只能来自会话与服务解析：query 里的 userId 不得改写身份，否则可读他人用量。
  test("query 不能改写被查询用户，用量按会话身份查询", async () => {
    const queryUsage = mock(async () => ({ totalSpendUsd: 1.5, records: [], activeUserCount: 1 }));
    installServices({
      provider: { getProviderForUsage: async () => gatewayProviderFixture() },
      budget: { getUserBudget: async () => null },
      usage: { queryUsage },
    });

    const response = await request(
      `/model-gateway/gateway-provider-1/usage?${RANGE}&userId=user-2&gatewayProviderId=other&organizationId=org-2`,
    );

    expect(response.status).toBe(200);
    expect(queryUsage).toHaveBeenCalledWith({
      gatewayProviderId: "gateway-provider-1",
      userId: "user-1",
      includeBreakdowns: true,
      startAt: "2026-09-01",
      endAt: "2026-09-20",
      organizationId: "org-2",
    });
    // 200 响应必须带上网关摘要与预算投影（页面标题与预算卡片依赖它们，缺一即渲染退化）。
    const body = await readJson(response);
    expect(body.gatewayProvider).toEqual(gatewayProviderFixture());
    expect(body.budget).toBeNull();
  });
});
