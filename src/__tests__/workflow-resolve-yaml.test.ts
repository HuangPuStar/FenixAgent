/**
 * resolveYaml 版本回退逻辑测试。
 *
 * resolveYaml 通过依赖注入接受 getWorkflowDef / getVersionYaml，测试时传入 mock 即可。
 */
import { describe, expect, mock, test } from "bun:test";
import type { ResolveYamlDeps } from "../services/workflow/resolve-yaml";
import { resolveYaml } from "../services/workflow/resolve-yaml";

function makeDeps(opts: {
  workflow?: { latestVersion: number | null; storagePath: string | null } | null;
  yamlByVersion?: Record<number, string | null>;
}): ResolveYamlDeps {
  // mock 返回类型与 ResolveYamlDeps 不完全兼容，通过双重断言处理
  return {
    getWorkflowDef: mock(
      async (_id: string, _orgId: string) => opts.workflow ?? null,
    ) as unknown as ResolveYamlDeps["getWorkflowDef"],
    getVersionYaml: mock(
      async (
        _id: string,
        version: number,
        _opts?: { organizationId: string; storagePath?: string | null },
      ): Promise<string | null> => opts.yamlByVersion?.[version] ?? null,
    ) as unknown as ResolveYamlDeps["getVersionYaml"],
  };
}

describe("resolveYaml", () => {
  // 直接传入 yaml 时无视 workflowId 和 version
  test("payload 包含 yaml 时直接返回 yaml，忽略 workflowId", async () => {
    const deps = makeDeps({});
    const result = await resolveYaml({ yaml: "name: test", workflowId: "wf1", version: 5 }, "org1", deps);
    expect(result).toBe("name: test");
    expect(deps.getWorkflowDef).toHaveBeenCalledTimes(0);
    expect(deps.getVersionYaml).toHaveBeenCalledTimes(0);
  });

  // 无 yaml 且无 workflowId → null
  test("无 yaml 且无 workflowId 时返回 null", async () => {
    const deps = makeDeps({});
    const result = await resolveYaml({ params: {} }, "org1", deps);
    expect(result).toBeNull();
  });

  // 仅 workflowId → 查 DB 获取 latestVersion ?? 0
  test("仅 workflowId 时以 latestVersion 作为目标版本", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: 3, storagePath: "/wf" },
      yamlByVersion: { 3: "name: v3" },
    });
    const result = await resolveYaml({ workflowId: "wf1" }, "org1", deps);
    expect(result).toBe("name: v3");
    expect(deps.getWorkflowDef).toHaveBeenCalledTimes(1);
    expect(deps.getVersionYaml).toHaveBeenCalledWith("wf1", 3, {
      organizationId: "org1",
      storagePath: "/wf",
    });
  });

  // latestVersion 为 null → 退回 version=0（草稿）
  test("latestVersion 为 null 时退回到 version=0", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: null, storagePath: "/wf" },
      yamlByVersion: { 0: "name: draft" },
    });
    const result = await resolveYaml({ workflowId: "wf1" }, "org1", deps);
    expect(result).toBe("name: draft");
    expect(deps.getVersionYaml).toHaveBeenCalledWith("wf1", 0, {
      organizationId: "org1",
      storagePath: "/wf",
    });
  });

  // 显式指定 version → 使用指定版本（同时验证 workflow 归属）
  test("显式指定 version 时使用指定版本并校验 workflow 归属", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: 3, storagePath: "/wf" },
      yamlByVersion: { 1: "name: v1" },
    });
    const result = await resolveYaml({ workflowId: "wf1", version: 1 }, "org1", deps);
    expect(result).toBe("name: v1");
    // 显式 version 也需要查 workflow（验证 organizationId 归属）
    expect(deps.getWorkflowDef).toHaveBeenCalledTimes(1);
    expect(deps.getVersionYaml).toHaveBeenCalledWith("wf1", 1, {
      organizationId: "org1",
      storagePath: "/wf",
    });
  });

  // workflow 不存在 → null
  test("workflow 不存在时返回 null", async () => {
    const deps = makeDeps({ workflow: null });
    const result = await resolveYaml({ workflowId: "nope" }, "org1", deps);
    expect(result).toBeNull();
  });

  // 指定 version 存在但对应 YAML 缺失 → null
  test("指定版本存在但 YAML 文件缺失时返回 null", async () => {
    const deps = makeDeps({
      workflow: { latestVersion: 1, storagePath: "/wf" },
      yamlByVersion: {},
    });
    const result = await resolveYaml({ workflowId: "wf1", version: 1 }, "org1", deps);
    expect(result).toBeNull();
  });
});
