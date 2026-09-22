import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveWorkspacePath } from "../server/services/workspace-resolver";
import { initializeAgentRuntimeModuleConfig } from "../server/testing";

/**
 * `resolveWorkspacePath` 的根取本模块配置的 `workspaceRoot`——1.7 C1 起不再直读 `process.env.WORKSPACE_ROOT`
 * （那是 review §8.1 第 9 条登记的 server 装配面唯一真违规）。用例因此经
 * `initializeAgentRuntimeModuleConfig()` 装配配置，而不是改环境变量：留着改 env 的写法会在配置未装进
 * 基础设施时静默通过，测不到真正的取数路径。
 *
 * Machine host port 那条路径的根语义（每次调用直读 `WORKSPACE_ROOT`）不在这里断言——它归宿主
 * `apps/server/src/bootstrap/workspace-path.ts`，由 machine 包的 fs 用例连同 workspace 根锁一起覆盖。
 */
describe("resolveWorkspacePath", () => {
  // 根取模块配置的 workspaceRoot，三段标识按 {root}/{org}/{user}/{env} 拼接
  test("按模块配置的 workspaceRoot 拼接路径", () => {
    initializeAgentRuntimeModuleConfig({ workspaceRoot: "/data/rcs" });

    expect(resolveWorkspacePath("org-1", "user-1", "env-1")).toBe("/data/rcs/org-1/user-1/env-1");
  });

  // 夹具缺省根是 cwd/workspaces，与宿主对空 env 的解析结果同形（避免用例静默依赖真实目录）
  test("夹具缺省根为 cwd/workspaces", () => {
    initializeAgentRuntimeModuleConfig();

    expect(resolveWorkspacePath("org-1", "user-1", "env-1")).toBe(
      join(process.cwd(), "workspaces", "org-1", "user-1", "env-1"),
    );
  });

  // 不同 orgId + userId + envId 组合产生不同路径
  test("不同 orgId + userId + envId 产生不同路径", () => {
    initializeAgentRuntimeModuleConfig({ workspaceRoot: "/data/rcs" });

    const path1 = resolveWorkspacePath("org-a", "user-1", "env-1");
    const path2 = resolveWorkspacePath("org-a", "user-1", "env-2");
    const path3 = resolveWorkspacePath("org-a", "user-2", "env-1");
    const path4 = resolveWorkspacePath("org-b", "user-1", "env-1");

    expect(path1).not.toBe(path2);
    expect(path1).not.toBe(path3);
    expect(path1).not.toBe(path4);
    expect(path2).not.toBe(path3);
    expect(path2).not.toBe(path4);
    expect(path3).not.toBe(path4);
  });

  // envId 不同时路径不同
  test("相同 org/user 下不同 envId 产生不同路径", () => {
    initializeAgentRuntimeModuleConfig({ workspaceRoot: "/data" });

    const pathA = resolveWorkspacePath("org-1", "user-1", "env-aaa");
    const pathB = resolveWorkspacePath("org-1", "user-1", "env-bbb");

    expect(pathA).toBe("/data/org-1/user-1/env-aaa");
    expect(pathB).toBe("/data/org-1/user-1/env-bbb");
    expect(pathA).not.toBe(pathB);
  });
});
