import { describe, expect, test } from "bun:test";
import { listPoolOptions } from "../services/sandbox/sandbox-admin-service";

describe("Sandbox Pool 配置查询", () => {
  // 沙盒关闭时不应向前端暴露任何可选资源池。
  test("沙盒关闭返回空选项", async () => {
    const result = await listPoolOptions("org-1", false, async () => {
      throw new Error("disabled sandbox should not query pools");
    });

    expect(result).toEqual({ enabled: false, pools: [] });
  });

  // 控制台只需要资源池标识和名称，不能拿到 Provider 或资源配置。
  test("沙盒开启返回组织可读 Pool 的轻量选项", async () => {
    const result = await listPoolOptions("org-1", true, async (organizationId) => {
      expect(organizationId).toBe("org-1");
      return [
        {
          id: "default",
          name: "默认沙盒",
          organizationId: null,
          providerKey: "opensandbox-cluster",
          image: "private/image:latest",
          defaultResources: { cpu: 1 },
          extra: { secret: "must-not-leak" },
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ];
    });

    expect(result).toEqual({ enabled: true, pools: [{ id: "default", name: "默认沙盒" }] });
  });
});
