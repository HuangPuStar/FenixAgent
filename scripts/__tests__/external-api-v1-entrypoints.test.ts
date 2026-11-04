import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXTERNAL_V1_OPERATIONS } from "../../apps/server/src/test-utils/external-v1-operations";

// 三个入口各自列出完整覆盖范围，不混入其他类别的接口。
test.each([
  { file: "test-agent-api-v1.ts", operations: EXTERNAL_V1_OPERATIONS.filter((path) => !path.includes("/workflows/")) },
  { file: "test-workflow-api-v1.ts", operations: ["POST /api/v1/workflows/{workflowId}/execute"] },
  { file: "test-workflow-v2-api-v1.ts", operations: ["POST /api/v1/workflow-v2/workflows/{id}/run"] },
])("$file 独立列出接口", ({ file, operations }) => {
  const path = new URL(`../${file}`, import.meta.url).pathname;
  const result = Bun.spawnSync(["bun", path, "--list"], { stdout: "pipe", stderr: "pipe" });
  expect(result.exitCode).toBe(0);
  const listed = result.stdout
    .toString()
    .split("\n")
    .filter((line) => /^(GET|POST|PATCH|DELETE) /.test(line));
  expect(listed.sort()).toEqual(operations);
});

// 默认模式无终端也应连续完成所有步骤；-t 必须明确要求交互终端。
test.each([false, true])("CLI interactive=%s 选择对应执行模式", async (interactive) => {
  const root = await mkdtemp(join(tmpdir(), "external-api-cli-"));
  const lib = join(root, "lib/external-api-v1");
  try {
    await mkdir(lib, { recursive: true });
    for (const file of ["manual-cli.ts", "runner.ts"]) {
      await copyFile(new URL(`../lib/external-api-v1/${file}`, import.meta.url), join(lib, file));
    }
    await writeFile(
      join(root, "test-external-api-v1.config.local.ts"),
      'export const AGENT_CONFIG = { baseUrl: "http://localhost", apiKey: "fixture", timeoutMs: 1000 };',
    );
    const entrypoint = join(root, "test.ts");
    await writeFile(
      entrypoint,
      `import { runManualScenario } from "./lib/external-api-v1/manual-cli";
await runManualScenario({
  configName: "AGENT_CONFIG", description: "fixture", operations: [], validate: () => {},
  run: async (_, runner) => {
    await runner.step("first", async () => runner.print("输出", "first"));
    await runner.step("second", async () => runner.print("输出", "second"));
  },
});`,
    );
    const proc = Bun.spawn([process.execPath, entrypoint, ...(interactive ? ["-t"] : [])], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (interactive) {
      expect(exitCode).toBe(1);
      expect(stderr).toContain("-t");
      expect(stderr).toContain("交互式终端");
      expect(stdout).not.toContain("输出 first");
    } else {
      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(stdout).toContain("输出 first");
      expect(stdout).toContain("输出 second");
      expect(stdout).not.toContain("按回车");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
