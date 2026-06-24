import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { resetTestAuth, setTestAuth } from "../../plugins/auth";
import webWorkflowCustomTools from "../../routes/web/workflow-custom-tools";
import { setTestOrgContext } from "../../services/org-context";
import { resetAllStubs, stubAuthApi } from "../../test-utils/helpers";
import { stubCustomTools } from "../../test-utils/stubs/module-stubs";

describe("GET /web/workflow-custom-tools", () => {
  beforeEach(() => {
    resetAllStubs();
    setTestAuth({
      user: { id: "u1", email: "test@test.com", name: "Tester" },
      authContext: { organizationId: "org1", userId: "u1", role: "owner" },
    });
    setTestOrgContext({ organizationId: "org1", userId: "u1", role: "owner" });
    // 注入 fake registry 数据；setup-mocks.ts 已 mock 模块，此处只配置返回值
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
    resetTestAuth();
    setTestOrgContext(null);
  });

  // 已登录返回 registry.list() 数据
  test("已登录返回 registry.list() 数据", async () => {
    const r = await webWorkflowCustomTools.handle(new Request("http://localhost/workflow-custom-tools"));
    expect(r.status).toBe(200);
    const json = await r.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0].name).toBe("trim_galore");
  });

  // 未登录返回 401
  test("未登录返回 401", async () => {
    resetTestAuth();
    setTestOrgContext(null);
    stubAuthApi({ getSession: async () => null });

    const r = await webWorkflowCustomTools.handle(new Request("http://localhost/workflow-custom-tools"));
    expect(r.status).toBe(401);
  });
});
