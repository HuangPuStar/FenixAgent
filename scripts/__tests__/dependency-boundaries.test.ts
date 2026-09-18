import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

import { compareBoundaryViolations } from "../check-dependency-boundaries";
import { type ArchitectureException, exceptionFingerprint } from "../lib/architecture-exceptions";

const repoRoot = resolve(import.meta.dir, "../..");
const configPath = join(repoRoot, ".dependency-cruiser.cjs");

/** 在临时 workspace 中运行与 CI 相同的依赖边界校验。 */
async function validateFixture(files: Record<string, string>): Promise<string> {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "fenix-dependency-boundaries-"));

  try {
    await Promise.all(
      Object.entries(files).map(async ([relativePath, content]) => {
        const filePath = join(fixtureRoot, relativePath);
        await $`mkdir -p ${filePath.substring(0, filePath.lastIndexOf("/"))}`.quiet();
        await writeFile(filePath, content);
      }),
    );

    const result = await $`bunx depcruise --config ${configPath} --output-type err-long ${fixtureRoot}`
      .quiet()
      .nothrow();
    return `${result.stdout.toString()}${result.stderr.toString()}`;
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
}

// 公开包入口是 workspace package 间唯一允许的导入面。
test("允许通过 package export 的公开导入", async () => {
  const output = await validateFixture({
    "packages/agent-runtime/consumer.ts": 'import "@fenix/platform-sdk";\n',
    "packages/platform/platform-sdk/package.json": '{"name":"@fenix/platform-sdk"}\n',
  });

  expect(output).not.toContain("error");
});

// package 间不得越过 export 直接读取对方 src 实现。
test("拒绝跨 package 的 src 内部导入", async () => {
  const output = await validateFixture({
    "packages/agent-runtime/consumer.ts": 'import "../platform/platform-sdk/src/internal";\n',
    "packages/platform/platform-sdk/src/internal.ts": "export const internal = true;\n",
  });

  expect(output).toContain("no-cross-package-src");
  expect(output).toContain("consumer.ts");
  expect(output).toContain("internal.ts");
});

// 包依赖必须保持有向无环，避免装配顺序和发布边界不确定。
test("拒绝 workspace package 循环依赖", async () => {
  const output = await validateFixture({
    "packages/agent-runtime/index.ts": 'import "../resources/agent-config";\n',
    "packages/resources/agent-config/index.ts": 'import "../../agent-runtime";\n',
  });

  expect(output).toContain("no-circular");
  expect(output).toContain("packages/agent-runtime/index.ts");
  expect(output).toContain("packages/resources/agent-config/index.ts");
});

// platform 只能作为被依赖的基础层，不能反向进入上层模块。
test("拒绝 platform 反向依赖 agent-runtime", async () => {
  const output = await validateFixture({
    "packages/platform/platform-sdk/index.ts": 'import "../../agent-runtime";\n',
    "packages/agent-runtime/index.ts": "export const agentRuntime = true;\n",
  });

  expect(output).toContain("platform-not-to-agent-runtime-resources-apps");
});

// agent-runtime 与 resources 的依赖方向由资源闭环设计决定，不能提前反向耦合。
test("拒绝 agent-runtime 反向依赖 resources", async () => {
  const output = await validateFixture({
    "packages/agent-runtime/index.ts": 'import "../resources/agent-config";\n',
    "packages/resources/agent-config/index.ts": "export const resource = true;\n",
  });

  expect(output).toContain("agent-runtime-not-to-resources");
});

/** 构造台账条目；只有 rule / from / to 参与判定，其余字段是加载器的非空要求。 */
function exception(rule: string, from: string, to: string): ArchitectureException {
  return { from, owner: "1.1", rationale: "单元测试夹具", removeWhen: "夹具销毁", rule, to };
}

function ledgerOf(entries: readonly ArchitectureException[]): Map<string, ArchitectureException> {
  return new Map(entries.map((entry) => [exceptionFingerprint(entry.rule, entry.from, entry.to), entry]));
}

// 未登记的包级边是新违规，必须失败并把包对与命中次数一起报出来。
test("未登记的边界违规计入未登记并聚合命中次数", () => {
  const comparison = compareBoundaryViolations({
    exceptions: ledgerOf([]),
    ownRuleNames: ["no-circular"],
    violations: [
      { from: "@fenix/a", rule: "no-circular", to: "@fenix/b" },
      { from: "@fenix/a", rule: "no-circular", to: "@fenix/b" },
      { from: "@fenix/c", rule: "no-circular", to: "@fenix/d" },
    ],
  });

  expect(comparison.registeredCount).toBe(0);
  expect(comparison.stale).toEqual([]);
  expect(comparison.unregistered).toEqual([
    { count: 2, from: "@fenix/a", rule: "no-circular", to: "@fenix/b" },
    { count: 1, from: "@fenix/c", rule: "no-circular", to: "@fenix/d" },
  ]);
});

// 登记过的包对整体放行，无论该边命中多少文件：台账粒度是包对而不是文件。
test("已登记的包对整体放行且不产生未登记项", () => {
  const registered = ledgerOf([exception("no-circular", "@fenix/a", "@fenix/b")]);

  const comparison = compareBoundaryViolations({
    exceptions: registered,
    ownRuleNames: ["no-circular"],
    violations: [
      { from: "@fenix/a", rule: "no-circular", to: "@fenix/b" },
      { from: "@fenix/a", rule: "no-circular", to: "@fenix/b" },
    ],
  });

  expect(comparison.registeredCount).toBe(1);
  expect(comparison.unregistered).toEqual([]);
  expect(comparison.stale).toEqual([]);
});

// 规则名不同即不同指纹：循环与跨包穿透可能指向同一对包，不能互相顶替。
test("规则名参与指纹，不同规则的同一条包对独立判定", () => {
  const comparison = compareBoundaryViolations({
    exceptions: ledgerOf([exception("no-circular", "@fenix/a", "@fenix/b")]),
    ownRuleNames: ["no-circular", "no-cross-package-src:packages/a"],
    violations: [{ from: "@fenix/a", rule: "no-cross-package-src:packages/a", to: "@fenix/b" }],
  });

  expect(comparison.unregistered).toEqual([
    { count: 1, from: "@fenix/a", rule: "no-cross-package-src:packages/a", to: "@fenix/b" },
  ]);
  expect(comparison.stale).toEqual([exception("no-circular", "@fenix/a", "@fenix/b")]);
});

// 台账由两个门禁共用，各自的规则名互不可见；越界判定会把对方生效中的条目误报成失效。
test("只把本门禁负责的规则条目标记为失效", () => {
  const exceptions = ledgerOf([
    exception("no-circular", "@fenix/a", "@fenix/b"),
    exception("apps-boundary", "@fenix/c", "@fenix/server-app"),
  ]);

  const comparison = compareBoundaryViolations({ exceptions, ownRuleNames: ["no-circular"], violations: [] });

  expect(comparison.stale.map((entry) => entry.rule)).toEqual(["no-circular"]);
});
