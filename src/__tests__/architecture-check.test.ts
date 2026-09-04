import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const CHECK_SCRIPT = resolve(import.meta.dir, "../../scripts/check-architecture.ts");
const CI_SCRIPT = resolve(import.meta.dir, "../../scripts/ci.ts");
const temporaryRoots: string[] = [];

interface CheckResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fenix-architecture-check-"));
  temporaryRoots.push(root);

  await Promise.all(
    ["src", "web/src", "web/components", "packages"].map((directory) =>
      mkdir(join(root, directory), { recursive: true }),
    ),
  );

  await Promise.all(
    Object.entries(files).map(async ([filePath, content]) => {
      const absolutePath = join(root, filePath);
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }),
  );

  return root;
}

async function runCli(command: string[], cwd: string): Promise<CheckResult> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stderr, stdout };
}

async function runCheck(root: string): Promise<CheckResult> {
  return runCli([process.execPath, CHECK_SCRIPT, "--root", root], root);
}

async function listPrecheckSteps(): Promise<CheckResult> {
  return runCli([process.execPath, CI_SCRIPT, "--list"], resolve(import.meta.dir, "../.."));
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("architecture check CLI", () => {
  // 配置的源码根缺失属于检查配置损坏，必须失败并保留具体目录上下文。
  test("rejects repositories with missing configured source roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "fenix-architecture-check-missing-root-"));
    temporaryRoots.push(root);

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("配置的源码目录不可用: src");
  });

  // 浏览器生产代码引入服务端入口时，precheck 必须在进入构建前给出可定位的失败。
  test("rejects server-only imports from browser production code", async () => {
    const root = await createFixture({
      "web/src/pages/AgentPage.tsx": 'import { createSessionDoc } from "@fenix/chat-channel/server";\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("browser-no-server-imports");
    expect(result.stdout).toContain(relative(root, join(root, "web/src/pages/AgentPage.tsx")));
  });

  // Service 和 Repository 反向依赖 Route 会破坏分层，必须在合入前直接失败。
  test("rejects route imports from lower backend layers", async () => {
    const root = await createFixture({
      "src/services/task-service.ts": 'import { taskRoutes } from "../routes/web/tasks";\nvoid taskRoutes;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("backend-no-route-imports");
    expect(result.stdout).toContain("src/services/task-service.ts");
  });

  // Workspace 包只能通过公开导出复用，直接依赖 src 内部实现必须被阻断。
  test("rejects imports that bypass workspace package exports", async () => {
    const root = await createFixture({
      "src/services/chat-service.ts":
        'import { gateway } from "@fenix/chat-channel/src/channel/gateway";\nvoid gateway;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("package-no-internal-imports");
    expect(result.stdout).toContain("@fenix/chat-channel/src/channel/gateway");
  });

  // Workspace 之间使用相对路径进入另一个包的 src，同样属于绕过公开导出。
  test("rejects relative imports into another workspace package internals", async () => {
    const root = await createFixture({
      "packages/consumer/src/client.ts":
        'import { gateway } from "../../chat-channel/src/channel/gateway";\nvoid gateway;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("package-no-internal-imports");
    expect(result.stdout).toContain("../../chat-channel/src/channel/gateway");
  });

  // 项目统一使用 Zod v4 入口，旧入口会让边界 Schema 的运行时与类型行为分裂。
  test("rejects imports from the legacy Zod entrypoint", async () => {
    const root = await createFixture({
      "src/schemas/task.ts": 'import { z } from "zod";\nexport const taskSchema = z.object({});\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("zod-v4-entrypoint");
    expect(result.stdout).toContain('应从 "zod/v4" 导入');
  });

  // 显式选择其他 Zod 版本入口仍违反统一 v4 契约，不能只拦截包根入口。
  test("rejects explicit non-v4 Zod entrypoints", async () => {
    const root = await createFixture({
      "src/schemas/task.ts": 'import { z } from "zod/v3";\nexport const taskSchema = z.object({});\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("zod-v4-entrypoint");
    expect(result.stdout).toContain("zod/v3");
  });

  // 模型品牌图标必须经统一组件映射，业务页面直接依赖图标包会泄漏 UI 实现边界。
  test("rejects model icon imports outside the model icon module", async () => {
    const root = await createFixture({
      "web/src/pages/ModelPage.tsx": 'import { OpenAI } from "@lobehub/icons";\nvoid OpenAI;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("model-icon-boundary");
    expect(result.stdout).toContain("web/components/model-icon/");
  });

  // 前端请求只能使用当前协议前缀，重新引入历史 /v1、/v2 URL 必须失败。
  test("rejects legacy API prefixes in browser production code", async () => {
    const root = await createFixture({
      "web/src/api/tasks.ts": 'declare function request(path: string): unknown;\nvoid request("/v1/tasks");\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("frontend-no-legacy-api-prefix");
    expect(result.stdout).toContain("/v1/tasks");
  });

  // 合法公开入口、测试专用服务端工具和模型图标封装必须保持可用，避免规则误伤正常分层。
  test("accepts imports through documented public boundaries", async () => {
    const root = await createFixture({
      "src/services/chat-service.ts": 'import { createYjsStore } from "@fenix/chat-channel";\nvoid createYjsStore;\n',
      "web/components/model-icon/model-icon-map.ts": 'import { OpenAI } from "@lobehub/icons";\nvoid OpenAI;\n',
      "web/src/__tests__/session.test.ts":
        'import { createSessionDoc } from "@fenix/chat-channel/server";\nvoid createSessionDoc;\n',
      "web/src/api/tasks.ts":
        'import { z } from "zod/v4";\nexport const tasksUrl = z.literal("/web/tasks");\nexport const externalApiPath = "/v1/chat/completions";\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("✓ architecture-check");
  });

  // precheck 必须持续包含 architecture 阶段，避免检查器存在但接线被误删。
  test("keeps architecture check wired into precheck", async () => {
    const result = await listPrecheckSteps();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "format",
      "import-sort",
      "architecture",
      "tsc (server)",
      "tsc (web)",
      "lint",
      "test",
    ]);
  });
});
