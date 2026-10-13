import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../../../..");

interface ImportResult {
  exitCode: number;
  output: string;
}

async function importInFreshProcess(modulePath: string): Promise<ImportResult> {
  const child = Bun.spawn([process.execPath, "-e", `await import(${JSON.stringify(modulePath)})`], {
    cwd: REPOSITORY_ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, output: `${stdout}${stderr}` };
}

describe("source route imports", () => {
  // 资源包路由必须能在全新 ESM 进程中初始化，避免宿主 schema barrel 循环产生 TDZ。
  test("资源包路由可由源码入口独立加载", async () => {
    const modulePaths = [
      "./packages/resources/skill/src/server/routes/web/config/skills.ts",
      "./packages/resources/agent-config/src/server/routes/web/sidebar-config.ts",
    ];

    for (const modulePath of modulePaths) {
      const result = await importInFreshProcess(modulePath);
      expect(result.exitCode, `${modulePath}\n${result.output}`).toBe(0);
    }
  });
});
