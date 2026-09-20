import { beforeEach, describe, expect, test } from "bun:test";
import { createAcpRoutes } from "@fenix/agent-runtime/server";
import { stubEnvironmentRepo } from "@server/test-utils/stubs/module-stubs";
import { initializeAgentRuntimeModuleConfig } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, createStubAuthenticateRequest, setTestAuth } from "./guard-stubs";

// 路由工厂 + 宿主依赖替身（1.4 W2）：守卫供 HTTP 路由的 `sessionAuth` 宏，请求级认证供 WS 升级路径。
const acpRoute = createAcpRoutes({
  authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
  authenticateRequest: createStubAuthenticateRequest(),
});

function request(path: string) {
  return acpRoute.handle(new Request(`http://localhost${path}`));
}

describe("/acp 路由的宿主注入认证", () => {
  beforeEach(() => {
    // 内含 resetAllStubs：替身会话会被一并复位，因此 setTestAuth 必须在它之后调用。
    // 环境仓储走宿主 preload 的实时 Proxy（未配置时只有 `getById`），用例按需登记方法。
    initializeAgentRuntimeModuleConfig();
  });

  // 未认证请求必须被注入的守卫挡在 handler 之前，不得落到业务层查库——
  // 这是「认证先于业务」的装配契约，过去由包内直接 import 宿主 `authGuardPlugin` 保证，
  // 现在改由注入实例保证，本用例覆盖这次接缝替换。
  test("未认证访问 /acp/agents 返回 401 且不触达业务层", async () => {
    const res = await request("/acp/agents");

    expect(res.status).toBe(401);
  });

  // 已认证时守卫放行到 handler，handler 用注入的身份读环境列表；
  // 仓储替身只提供空列表，因此断言的是「按当前用户放行 + 无环境时返回空数组」，
  // 组织维度的过滤谓词在 SQL 层（`where(organizationId = ...)`），不在此处断言。
  test("已认证访问 /acp/agents 放行并按当前身份查询", async () => {
    setTestAuth({ organizationId: "org-injected", userId: "user-1" });
    stubEnvironmentRepo({ listByOrganizationId: async () => [] });

    const res = await request("/acp/agents");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });
});
