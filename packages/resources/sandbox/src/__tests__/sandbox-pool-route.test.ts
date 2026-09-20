import { beforeEach, describe, expect, test } from "bun:test";
import { createWebSandboxPoolsRoutes } from "../routes/web/sandbox-pools";
import { initializeSandboxModuleConfig } from "../server/testing";
import { createStubSessionAuthGuardPlugin } from "./guard-stubs";

// 会话守卫替身按插件名去重，同一文件内共用一个实例。
const routes = createWebSandboxPoolsRoutes({
  authGuardPlugin: createStubSessionAuthGuardPlugin({ organizationId: "org-1", userId: "user-1" }),
});

describe("Web Sandbox Pool 路由", () => {
  beforeEach(() => {
    initializeSandboxModuleConfig({ sandboxEnabled: false });
  });

  // 沙盒关闭时必须返回空选项信封，且不得查询资源池（关闭状态下无资源池可暴露）。
  test("沙盒关闭时返回空选项信封", async () => {
    // 路径不含 `/web` 前缀：该前缀由宿主的 web 路由组添加，包内只声明相对于该组的路由。
    const response = await routes.handle(new Request("http://localhost/config/sandbox-pools"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true, data: { enabled: false, pools: [] } });
  });
});
