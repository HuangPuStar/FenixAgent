import { expect, test } from "bun:test";

import {
  collectChangedPaths,
  loadWorkspacePackages,
  resolveAffectedTests,
  type WorkspacePackage,
} from "../lib/affected-tests";

/** 包清单夹具：目录不必真实存在，命中「无测试目录」分支时会被跳过并留下说明。 */
function pkg(dir: string, name: string, deps: readonly string[] = []): WorkspacePackage {
  return { dir, name, deps };
}

function stepNames(changedPaths: readonly string[], packages: readonly WorkspacePackage[] = []): string[] {
  return resolveAffectedTests(changedPaths, packages).steps.map((step) => step.name);
}

// 工作区无改动时不跑任何测试，避免空跑一整批。
test("无改动时不产生测试步骤", () => {
  expect(stepNames([])).toEqual([]);
});

// 宿主后端与脚本改动落到宿主测试批（该批同时覆盖 scripts/__tests__ 与 platform-sdk）。
test("宿主与脚本改动命中宿主测试批", () => {
  expect(stepNames(["apps/server/src/main.ts"])).toEqual(["server-and-script-tests"]);
  expect(stepNames(["scripts/ci.ts"])).toEqual(["server-and-script-tests"]);
});

// 宿主前端改动落到 web 测试批，与后端批相互独立。
test("宿主前端改动命中 web 测试批", () => {
  expect(stepNames(["apps/web/src/api/branding.ts"])).toEqual(["web-app-tests"]);
});

// platform-sdk 已是宿主测试批的组成部分：改动它只跑宿主批，不额外重复跑一次包批。
test("platform-sdk 改动归宿主批且不重复执行", () => {
  const packages = [pkg("packages/platform/platform-sdk", "@fenix/platform-sdk")];

  expect(stepNames(["packages/platform/platform-sdk/src/index.ts"], packages)).toEqual(["server-and-script-tests"]);
});

// 共享契约（根清单、锁文件、tsconfig、biome、drizzle 配置）的测试映射不可判定，保守跑全量三批。
test("共享契约变更保守跑全量三批", () => {
  const expected = ["server-and-script-tests", "package-tests", "web-app-tests"];

  expect(stepNames(["package.json"])).toEqual(expected);
  expect(stepNames(["tsconfig.base.json"])).toEqual(expected);
  expect(stepNames(["drizzle.config.ts"])).toEqual(expected);
});

// 归属无法判定的根文件同样保守跑全量三批，而不是静默跳过。
test("归属未知的根文件保守跑全量三批", () => {
  expect(stepNames(["unknown-root-file.txt"])).toEqual(["server-and-script-tests", "package-tests", "web-app-tests"]);
});

// 文档等与单测无关的路径直接跳过，并留下判定说明供核对。
test("与单测无关的路径被跳过并留下说明", () => {
  const result = resolveAffectedTests(["docs/arch/19-yjs-chat-streaming.md", "e2e/foo.spec.ts"], []);

  expect(result.steps).toEqual([]);
  expect(result.notes.join("\n")).toContain("改动未落到任何测试根");
});

// 包内没有测试目录时必须跳过：`bun test <无测试目录>` 会以失败退出，误加入批次等于制造假红灯。
test("包内无测试目录时跳过并说明", () => {
  const result = resolveAffectedTests(["packages/ghost/src/a.ts"], [pkg("packages/ghost", "@fenix/ghost")]);

  expect(result.steps).toEqual([]);
  expect(result.notes.join("\n")).toContain("packages/ghost 没有 __tests__ 目录");
});

// 包目录取最长前缀匹配：`packages/<分组>/<包>/**` 归那个具体包，不能被它的分组目录截胡。
test("包归属按最长目录前缀匹配", () => {
  const packages = [
    pkg("packages/groups", "@fenix/groups"),
    pkg("packages/groups/alpha/beta", "@fenix/groups-alpha-beta"),
  ];
  const result = resolveAffectedTests(["packages/groups/alpha/beta/src/a.ts"], packages);
  const notes = result.notes.join("\n");

  expect(notes).toContain("packages/groups/alpha/beta 没有 __tests__ 目录");
  expect(notes).not.toContain("packages/groups 没有 __tests__ 目录");
});

// 反向依赖闭包必须传递：改最底层的包会把中间层与顶层消费方一并纳入，只跑前者会漏检消费方边界。
test("反向依赖闭包覆盖传递依赖", () => {
  const packages = [
    pkg("packages/base", "@fenix/base"),
    pkg("packages/mid", "@fenix/mid", ["@fenix/base"]),
    pkg("packages/top", "@fenix/top", ["@fenix/mid"]),
  ];
  const result = resolveAffectedTests(["packages/base/src/a.ts"], packages);
  const notes = result.notes.join("\n");

  expect(notes).toContain("packages/mid（@fenix/mid）反向依赖变更包 → 纳入测试");
  expect(notes).toContain("packages/top（@fenix/top）反向依赖变更包 → 纳入测试");
});

// 真实仓库包清单：改动有测试的包生成该包整体测试步骤，且反向依赖它的消费方包一并纳入。
test("真实包清单下命中包测试并纳入消费方包", () => {
  const result = resolveAffectedTests(["packages/chat-channel/src/util/json-rpc.ts"], loadWorkspacePackages());
  const byName = new Map(result.steps.map((step) => [step.name, step]));

  expect(byName.has("tests (packages/chat-channel)")).toBe(true);
  // `@fenix/agent-runtime` 依赖 `@fenix/chat-channel`：只跑前者等于漏检消费方的边界行为。
  expect(byName.has("tests (packages/agent-runtime)")).toBe(true);
  // 包内可能留有 tmp 夹具：必须带忽略口径，否则测试目录里的临时文件会被当成用例收集。
  expect(byName.get("tests (packages/chat-channel)")?.cmd).toContain("--path-ignore-patterns");
});

// 改动收集结果供稳定排序与去重：判定与说明的输出不随 git 的返回顺序变化。
test("改动路径收集去重且排序稳定", () => {
  const paths = collectChangedPaths();

  expect(paths).toEqual([...new Set(paths)].sort());
});
