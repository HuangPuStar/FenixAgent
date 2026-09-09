import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { $ } from "bun";

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
    "packages/agent/consumer.ts": 'import "@fenix/platform-sdk";\n',
    "packages/platform/platform-sdk/package.json": '{"name":"@fenix/platform-sdk"}\n',
  });

  expect(output).not.toContain("error");
});

// package 间不得越过 export 直接读取对方 src 实现。
test("拒绝跨 package 的 src 内部导入", async () => {
  const output = await validateFixture({
    "packages/agent/consumer.ts": 'import "../platform/platform-sdk/src/internal";\n',
    "packages/platform/platform-sdk/src/internal.ts": "export const internal = true;\n",
  });

  expect(output).toContain("no-cross-package-src");
  expect(output).toContain("consumer.ts");
  expect(output).toContain("internal.ts");
});

// 包依赖必须保持有向无环，避免装配顺序和发布边界不确定。
test("拒绝 workspace package 循环依赖", async () => {
  const output = await validateFixture({
    "packages/agent/index.ts": 'import "../resources/agent-config";\n',
    "packages/resources/agent-config/index.ts": 'import "../../agent";\n',
  });

  expect(output).toContain("no-circular");
  expect(output).toContain("packages/agent/index.ts");
  expect(output).toContain("packages/resources/agent-config/index.ts");
});

// platform 只能作为被依赖的基础层，不能反向进入上层模块。
test("拒绝 platform 反向依赖 agent", async () => {
  const output = await validateFixture({
    "packages/platform/platform-sdk/index.ts": 'import "../../agent";\n',
    "packages/agent/index.ts": "export const agent = true;\n",
  });

  expect(output).toContain("platform-not-to-agent-resources-apps");
});

// agent 与 resources 的依赖方向由资源闭环设计决定，不能提前反向耦合。
test("拒绝 agent 反向依赖 resources", async () => {
  const output = await validateFixture({
    "packages/agent/index.ts": 'import "../resources/agent-config";\n',
    "packages/resources/agent-config/index.ts": "export const resource = true;\n",
  });

  expect(output).toContain("agent-not-to-resources");
});
