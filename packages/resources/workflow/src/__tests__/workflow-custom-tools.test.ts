import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createWebWorkflowCustomToolsRoutes } from "../server/routes/web/workflow-custom-tools";
import { initializeWorkflowModuleConfig, stubCustomTools } from "../server/testing";
import { createStubSessionAuthGuard } from "./guard-stubs";

const guard = createStubSessionAuthGuard();

// 路由经工厂构造并注入会话守卫替身：静态条件禁止包内测试依赖宿主 `@server/plugins/auth`，
// 而 Elysia 的 macro/state 是实例作用域的，守卫必须是构造时传入的同一实例。
const route = createWebWorkflowCustomToolsRoutes({ authGuardPlugin: guard });

describe("GET /web/workflow-custom-tools", () => {
  beforeEach(() => {
    // 模块配置与 DB 替身的初始化统一走包内 /server/testing（内部含 resetAllStubs）
    initializeWorkflowModuleConfig();
    guard.setActor({ organizationId: "org1", userId: "org1" });
    // 注入 fake registry 数据；模块替身由 ../server/testing 安装，此处只配置返回值
    stubCustomTools({
      getCustomToolsRegistry: () => ({
        list: () => [
          {
            name: "trim_galore",
            description: "FastQC 质控",
            inputs: { r1: { type: "string" } },
            produces: ["trimmed_r1"],
          },
        ],
      }),
    });
  });

  afterEach(() => {
    guard.setActor(null);
  });

  // 已登录返回 registry.list() 数据
  test("已登录返回 registry.list() 数据", async () => {
    const r = await route.handle(new Request("http://localhost/workflow-custom-tools"));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("trim_galore");
  });

  // 未登录返回 401
  test("未登录返回 401", async () => {
    guard.setActor(null);

    const r = await route.handle(new Request("http://localhost/workflow-custom-tools"));
    expect(r.status).toBe(401);
  });
});
