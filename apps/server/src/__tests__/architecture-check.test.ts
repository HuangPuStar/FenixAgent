import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const CHECK_SCRIPT = resolve(import.meta.dir, "../../../../scripts/check-architecture.ts");
const CI_SCRIPT = resolve(import.meta.dir, "../../../../scripts/ci.ts");
const temporaryRoots: string[] = [];

interface CheckResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** 与根 package.json 一致的 workspace 声明；依赖类规则只有声明了包边界才有意义。 */
const WORKSPACE_ROOT_MANIFEST = '{"name":"fixture-root","workspaces":["packages/*","packages/*/*","apps/*"]}\n';

/** 生成一份最小台账；`owner` / `removeWhen` / `rationale` 非空是加载器的硬性要求。 */
function ledger(exceptions: readonly { rule: string; from: string; to: string }[]): string {
  return `${JSON.stringify(
    {
      exceptions: exceptions.map((entry) => ({
        ...entry,
        owner: "1.1",
        removeWhen: "夹具用条目，验收后随夹具销毁",
        rationale: "行为夹具：验证台账的放行与失效判定，不代表真实仓库的债务。",
      })),
    },
    null,
    2,
  )}\n`;
}

async function createFixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "fenix-architecture-check-"));
  temporaryRoots.push(root);

  await Promise.all(
    ["apps/server/src", "apps/web/src", "apps/web/components", "packages"].map((directory) =>
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
  return runCli([process.execPath, CI_SCRIPT, "--list"], resolve(import.meta.dir, "../../../.."));
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
    expect(result.stderr).toContain("配置的源码目录不可用: apps/server/src");
  });

  // 浏览器生产代码引入服务端入口时，precheck 必须在进入构建前给出可定位的失败。
  test("rejects server-only imports from browser production code", async () => {
    const root = await createFixture({
      "apps/web/src/pages/AgentPage.tsx": 'import { createSessionDoc } from "@fenix/chat-channel/server";\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("browser-entry-server-import");
    expect(result.stdout).toContain(relative(root, join(root, "apps/web/src/pages/AgentPage.tsx")));
  });

  // Service 和 Repository 反向依赖 Route 会破坏分层，必须在合入前直接失败。
  test("rejects route imports from lower backend layers", async () => {
    const root = await createFixture({
      "apps/server/src/services/task-service.ts":
        'import { taskRoutes } from "../routes/web/tasks";\nvoid taskRoutes;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("backend-no-route-imports");
    expect(result.stdout).toContain("apps/server/src/services/task-service.ts");
  });

  // Workspace 包只能通过公开导出复用，直接依赖 src 内部实现必须被阻断。
  test("rejects imports that bypass workspace package exports", async () => {
    const root = await createFixture({
      "apps/server/src/services/chat-service.ts":
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

  // resources 下的嵌套 workspace 同样只能经公开入口相互依赖，不能因目录层级绕过检查。
  test("rejects relative imports into nested resource package internals", async () => {
    const root = await createFixture({
      "packages/resources/consumer/src/client.ts":
        'import { gateway } from "../../model-management/src/server/model-gateway";\nvoid gateway;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("package-no-internal-imports");
    expect(result.stdout).toContain("../../model-management/src/server/model-gateway");
  });

  // 项目统一使用 Zod v4 入口，旧入口会让边界 Schema 的运行时与类型行为分裂。
  test("rejects imports from the legacy Zod entrypoint", async () => {
    const root = await createFixture({
      "apps/server/src/schemas/task.ts": 'import { z } from "zod";\nexport const taskSchema = z.object({});\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("zod-v4-entrypoint");
    expect(result.stdout).toContain('应从 "zod/v4" 导入');
  });

  // 显式选择其他 Zod 版本入口仍违反统一 v4 契约，不能只拦截包根入口。
  test("rejects explicit non-v4 Zod entrypoints", async () => {
    const root = await createFixture({
      "apps/server/src/schemas/task.ts": 'import { z } from "zod/v3";\nexport const taskSchema = z.object({});\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("zod-v4-entrypoint");
    expect(result.stdout).toContain("zod/v3");
  });

  // 模型品牌图标必须经统一组件映射，业务页面直接依赖图标包会泄漏 UI 实现边界。
  test("rejects model icon imports outside the model icon module", async () => {
    const root = await createFixture({
      "apps/web/src/pages/ModelPage.tsx": 'import { OpenAI } from "@lobehub/icons";\nvoid OpenAI;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("model-icon-boundary");
    expect(result.stdout).toContain("model-management 的 model-icon 组件");
  });

  // 前端请求只能使用当前协议前缀，重新引入历史 /v1、/v2 URL 必须失败。
  test("rejects legacy API prefixes in browser production code", async () => {
    const root = await createFixture({
      "apps/web/src/api/tasks.ts": 'declare function request(path: string): unknown;\nvoid request("/v1/tasks");\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("frontend-no-legacy-api-prefix");
    expect(result.stdout).toContain("/v1/tasks");
  });

  // 合法公开入口、测试专用服务端工具和模型图标封装必须保持可用，避免规则误伤正常分层。
  test("accepts imports through documented public boundaries", async () => {
    const root = await createFixture({
      "apps/server/src/services/chat-service.ts":
        'import { createYjsStore } from "@fenix/chat-channel";\nvoid createYjsStore;\n',
      "packages/resources/model-management/web/components/model-icon/model-icon-map.ts":
        'import { OpenAI } from "@lobehub/icons";\nvoid OpenAI;\n',
      "apps/web/src/__tests__/session.test.ts":
        'import { createSessionDoc } from "@fenix/chat-channel/server";\nvoid createSessionDoc;\n',
      "apps/web/src/api/tasks.ts":
        'import { z } from "zod/v4";\nexport const tasksUrl = z.literal("/web/tasks");\nexport const externalApiPath = "/v1/chat/completions";\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("✓ architecture-check");
  });

  // workspace 包导入另一个包却没有在 package.json 声明依赖时，依赖会被根 workspace 的偶然提升掩盖。
  test("rejects workspace imports without a declared dependency", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/platform/platform-sdk/package.json": '{"name":"@fenix/platform-sdk"}\n',
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/src/client.ts":
        'import { getDatabase } from "@fenix/platform-sdk";\nvoid getDatabase;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("undeclared-workspace-dependency");
    expect(result.stdout).toContain("未声明依赖");
  });

  // 无 scope 的 workspace 包（`acp-link`）曾因规则按 `@fenix/` 前缀推断包名而整包逃过检查。
  test("rejects undeclared imports of unscoped workspace packages", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/acp-link/package.json": '{"name":"acp-link"}\n',
      "packages/plugin-consumer/package.json": '{"name":"@fenix/plugin-consumer"}\n',
      "packages/plugin-consumer/src/handler.ts": 'import { startServer } from "acp-link/client";\nvoid startServer;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("undeclared-workspace-dependency");
    expect(result.stdout).toContain("acp-link");
  });

  // 包名解析必须以根 workspaces 声明为准，否则与 workspace 同名但非 workspace 的依赖会被误报。
  test("ignores scoped specifiers that are not workspace packages", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/src/client.ts": 'import { helper } from "@fenix/external-sdk";\nvoid helper;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ architecture-check");
  });

  // 声明了 workspace 依赖的导入必须放行，否则规则会逼出无意义的重复声明。
  test("accepts workspace imports backed by a declared dependency", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/platform/platform-sdk/package.json": '{"name":"@fenix/platform-sdk"}\n',
      "packages/resources/consumer/package.json":
        '{"name":"@fenix/consumer","dependencies":{"@fenix/platform-sdk":"workspace:*"}}\n',
      "packages/resources/consumer/src/client.ts":
        'import { getDatabase } from "@fenix/platform-sdk";\nvoid getDatabase;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ architecture-check");
  });

  // 应用是唯一的 composition root；资源包反向读取宿主实现会让模块无法独立装配。
  test("rejects package imports of the server application internals", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/src/client.ts": 'import { db } from "@server/db";\nvoid db;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("apps-boundary");
    expect(result.stdout).toContain("不得依赖应用");
  });

  // web contribution 只被浏览器 bundle 消费，反向读取宿主实现会让资源页面无法独立演进。
  test("rejects web contributions that reach into the host application", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/web/page.tsx": 'import { request } from "@/src/api/request";\nvoid request;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("web-package-not-to-app");
    expect(result.stdout).toContain("@/src/api/request");
  });

  // 相对路径越过包目录进入宿主同属这条边界，且只能由一条规则报出：两条规则都报会让同一处导入
  // 需要两条台账记录，「不再违规即删除」的语义随之失效。
  test("reports relative host escapes once, under the web contribution rule", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/web/page.tsx":
        'import { cn } from "../../../../apps/web/src/lib/utils";\nvoid cn;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[web-package-not-to-app]");
    expect(result.stdout).not.toContain("[apps-boundary]");
  });

  // §2.3 禁止 resource 依赖 platform-impl：授权只能经 platform-sdk 的 AccessControlModule 契约。
  test("rejects resource imports of the concrete access control implementation", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/platform/platform-sdk/package.json": '{"name":"@fenix/platform-sdk"}\n',
      "packages/platform/access-control/package.json": '{"name":"@fenix/access-control"}\n',
      "packages/resources/consumer/package.json":
        '{"name":"@fenix/consumer","dependencies":{"@fenix/access-control":"workspace:*"}}\n',
      "packages/resources/consumer/src/client.ts":
        'import { createAccessControl } from "@fenix/access-control";\nvoid createAccessControl;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("special-dependency");
  });

  // §6.1 的 schema 组装期例外：Drizzle 的 .references() 只接受列对象，跨模块外键只能在 db/schema.ts
  // 里导入对方的表对象，因此 db/** 的跨包导入不由 §2.3 判定。
  test("allows cross-package table imports under db/", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/platform/identity/package.json": '{"name":"@fenix/identity"}\n',
      "packages/platform/identity/db/schema.ts": "export const user = {};\n",
      "packages/resources/consumer/package.json":
        '{"name":"@fenix/consumer","dependencies":{"@fenix/identity":"workspace:*"}}\n',
      "packages/resources/consumer/db/schema.ts": 'import { user } from "@fenix/identity/db";\nvoid user;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
  });

  // 例外只作用于 db/ 路径：同一包在 src/ 里导入对方的表对象仍是 §2.3 的违规。若按包对登记例外，
  // 这条会被一起放行——那正是路径作用域判定要防的事。
  test("still rejects cross-package table imports under src/", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/platform/identity/package.json": '{"name":"@fenix/identity"}\n',
      "packages/platform/identity/db/schema.ts": "export const user = {};\n",
      "packages/resources/consumer/package.json":
        '{"name":"@fenix/consumer","dependencies":{"@fenix/identity":"workspace:*"}}\n',
      "packages/resources/consumer/src/repository.ts": 'import { user } from "@fenix/identity/db";\nvoid user;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[special-dependency]");
  });

  // 组装期跨模块外键只能用裸说明符 `@fenix/<pkg>/db`（§6.1 的例外口径）。这条固化「db 只对相对
  // 路径生效」这一半：同一个目标换成公开出口就不再是内部穿透，避免日后把 db 一并加进说明符分支。
  test("accepts db specifiers that go through the package export", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/agent-runtime/package.json": '{"name":"@fenix/agent-runtime"}\n',
      "packages/agent-runtime/db/schema.ts": "export const environment = {};\n",
      "packages/resources/channel/package.json":
        '{"name":"@fenix/resource-channel","dependencies":{"@fenix/agent-runtime":"workspace:*"}}\n',
      "packages/resources/channel/db/schema.ts":
        'import { environment } from "@fenix/agent-runtime/db";\nvoid environment;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
  });

  // 另一半：相对路径伸进对方 db/ 与伸进 src/ 同罪——都绕过了公开导出。这条在收窄前 exit 0，
  // 是 §8.4 第 5 条登记的判别力缺口（跨包内部路径判定原先只认 src / web/src）。
  test("rejects relative imports into another workspace package db/", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/agent-runtime/package.json": '{"name":"@fenix/agent-runtime"}\n',
      "packages/agent-runtime/db/schema.ts": "export const environment = {};\n",
      "packages/resources/channel/package.json": '{"name":"@fenix/resource-channel"}\n',
      "packages/resources/channel/db/schema.ts":
        'import { environment } from "../../../agent-runtime/db/schema";\nvoid environment;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("package-no-internal-imports");
    expect(result.stdout).toContain("../../../agent-runtime/db/schema");
  });

  // §158 要求同类别内部的方向也能被门禁判定：identity 与 access-control 同属 platform-impl，
  // 矩阵只允许 access-control → identity，反向边必须被拒。
  test("rejects identity imports of the access control implementation", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/platform/platform-sdk/package.json": '{"name":"@fenix/platform-sdk"}\n',
      "packages/platform/access-control/package.json": '{"name":"@fenix/access-control"}\n',
      "packages/platform/identity/package.json":
        '{"name":"@fenix/identity","dependencies":{"@fenix/access-control":"workspace:*"}}\n',
      "packages/platform/identity/src/client.ts":
        'import { createAccessControl } from "@fenix/access-control";\nvoid createAccessControl;\n',
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("[special-dependency]");
    expect(result.stdout).toContain('"@fenix/identity" → "@fenix/access-control"');
  });

  // 登记过的包对放行存量违规，门禁只阻断未登记的新增，这样阶段 2 可以在真实债务上推进。
  test("accepts boundary violations registered in the ledger", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/src/client.ts": 'import { db } from "@server/db";\nvoid db;\n',
      "scripts/architecture/exceptions.json": ledger([
        {
          rule: "apps-boundary",
          from: "@fenix/consumer",
          to: "@fenix/server-app",
        },
      ]),
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 条已登记例外");
  });

  // 台账是待清偿清单：某条边不再违规后仍留在台账里，等于把豁免永久化，必须失败要求删除。
  test("rejects ledger entries that no longer match a violation", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/src/client.ts": "export const consumer = true;\n",
      "scripts/architecture/exceptions.json": ledger([
        {
          rule: "apps-boundary",
          from: "@fenix/consumer",
          to: "@fenix/server-app",
        },
      ]),
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("已不再违规，必须删除");
    expect(result.stdout).toContain("apps-boundary @fenix/consumer @fenix/server-app");
  });

  // 台账由两个门禁共用：本门禁看不到 dependency-cruiser 规则的违规，不能把对方的生效条目误判为失效。
  test("ignores ledger entries owned by the dependency-cruiser gate", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/consumer/package.json": '{"name":"@fenix/consumer"}\n',
      "packages/resources/consumer/src/client.ts": "export const consumer = true;\n",
      "scripts/architecture/exceptions.json": ledger([
        {
          rule: "no-circular",
          from: "@fenix/consumer",
          to: "@fenix/consumer",
        },
      ]),
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("✓ architecture-check");
  });

  // `handwrittenRegistryBaseline` 是过渡期字段，规则删除后必须一并消失，不能再被静默接受。
  test("rejects the retired handwritten registry baseline field", async () => {
    const root = await createFixture({
      "package.json": WORKSPACE_ROOT_MANIFEST,
      "packages/resources/agent-config/package.json": '{"name":"@fenix/agent-config"}\n',
      "apps/server/src/main.ts": 'import "@fenix/agent-config";\n',
      "scripts/architecture/exceptions.json": `${JSON.stringify(
        {
          handwrittenRegistryBaseline: ["@fenix/agent-config"],
          exceptions: [],
        },
        null,
        2,
      )}\n`,
    });

    const result = await runCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("架构例外台账格式非法");
  });

  // precheck 必须持续包含 architecture 阶段，避免检查器存在但接线被误删。
  test("keeps architecture check wired into precheck", async () => {
    const result = await listPrecheckSteps();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toEqual([
      "format",
      "import-sort",
      "module-registry",
      "web-contributions",
      "owner-inventory",
      "schema-ddl-drift",
      "architecture",
      "tsc (server)",
      "tsc (web)",
      "tsc (app skeletons)",
      "tsc (packages)",
      "dependency-boundaries",
      "lint",
      "server-and-script-tests",
      "package-tests",
      "web-app-tests",
    ]);
  });
});
