import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveCtrlStaticAssetsDirectory } from "../../apps/server/src/plugins/static";

const repoRoot = resolve(import.meta.dir, "../..");

function readRepoFile(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

// 应用启动只能从 apps 目录进入，根目录不再保留第二个入口。
test("server 与 web 只有 apps 下的应用入口", () => {
  expect(existsSync(resolve(repoRoot, "apps/server/src/main.ts"))).toBe(true);
  expect(existsSync(resolve(repoRoot, "apps/web/src/main.tsx"))).toBe(true);
  expect(existsSync(resolve(repoRoot, "src/index.ts"))).toBe(false);
  expect(existsSync(resolve(repoRoot, "web/src/main.tsx"))).toBe(false);
  expect(existsSync(resolve(repoRoot, "web/src/bootstrap.ts"))).toBe(false);
  expect(readRepoFile("apps/server/src/main.ts")).toContain("new Elysia");
  expect(readRepoFile("apps/web/src/main.tsx")).toContain("createRoot");
});

// 根命令、Vite 和静态托管必须一致地指向新应用入口与产物。
test("开发、构建和静态托管使用 apps 入口", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const viteConfig = readRepoFile("apps/web/vite.config.ts");
  const staticPlugin = readRepoFile("apps/server/src/plugins/static.ts");
  const dockerfile = readRepoFile("Dockerfile");

  expect(packageJson.scripts.dev).toBe("bun run apps/server/src/main.ts");
  expect(packageJson.scripts.start).toBe("bun run apps/server/src/main.ts");
  expect(packageJson.scripts["dev:web"]).toContain("apps/web/vite.config.ts");
  expect(packageJson.scripts["build:web"]).toContain("apps/web/vite.config.ts");
  expect(viteConfig).toContain("root: __dirname");
  expect(viteConfig).toContain('path.resolve(__dirname, "index.html")');
  expect(staticPlugin).toContain('"apps/web/dist"');
  expect(staticPlugin).toContain("RCS_APPLICATION_ROOT");
  expect(staticPlugin).not.toContain('resolve(__dirname, "../../../web/dist")');
  expect(dockerfile).toContain("COPY apps/server/src ./apps/server/src");
  expect(dockerfile).toContain("COPY apps/web ./apps/web");
  expect(dockerfile).toContain("bun build apps/server/src/main.ts");
  expect(dockerfile).toContain("/app/apps/web/dist ./apps/web/dist");
  expect(dockerfile).toContain("ENV RCS_APPLICATION_ROOT=/app");
  expect(dockerfile).toContain('CMD ["bun", "dist/index.js"]');
  expect(readRepoFile("docker-compose.yml")).toContain("run dist/index.js");
  expect(readRepoFile("docker/prod/docker-compose.yml")).toContain("run dist/index.js");
});

// 源码模式必须从模块位置推导应用根，不能受调用进程的工作目录影响。
test("静态资源 fallback 指向 apps web 构建产物", () => {
  expect(resolveCtrlStaticAssetsDirectory(undefined)).toBe(resolve(repoRoot, "apps/web/dist"));
});

// Bun bundle 会将 server 模块输出到 /app/dist；静态资源必须仍从运行时应用根读取，不能按 bundle 文件位置回退到 /web。
test("编译 bundle 在非仓库工作目录仍从应用根读取静态资源", () => {
  expect(resolveCtrlStaticAssetsDirectory("/app")).toBe("/app/apps/web/dist");
});

// 编译产物的 import.meta.url 位于 dist；即使进程工作目录不在仓库，Docker 声明的应用根仍必须定位到控制台资源。
test("编译后的静态插件从非仓库工作目录读取应用根", async () => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "fenix-static-bundle-"));

  try {
    const bundleDir = join(fixtureRoot, "bundle");
    const applicationRoot = join(fixtureRoot, "app");
    const isolatedWorkingDirectory = join(fixtureRoot, "non-repository-cwd");
    await Promise.all([
      mkdir(bundleDir, { recursive: true }),
      mkdir(join(applicationRoot, "apps/web/dist"), { recursive: true }),
      mkdir(isolatedWorkingDirectory, { recursive: true }),
    ]);

    const result = await Bun.build({
      entrypoints: [resolve(repoRoot, "apps/server/src/plugins/static.ts")],
      outdir: bundleDir,
      target: "bun",
    });
    expect(result.success).toBe(true);
    const bundlePath = result.outputs[0]?.path;
    expect(bundlePath).toBeDefined();

    const child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `import { resolveCtrlStaticAssetsDirectory } from ${JSON.stringify(bundlePath)}; console.log(resolveCtrlStaticAssetsDirectory());`,
      ],
      {
        cwd: isolatedWorkingDirectory,
        env: { ...process.env, RCS_APPLICATION_ROOT: applicationRoot },
        stdout: "pipe",
      },
    );
    const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe(join(applicationRoot, "apps/web/dist"));
  } finally {
    await rm(fixtureRoot, { force: true, recursive: true });
  }
});

// 质量门禁必须扫描唯一的 server 源码目录，避免根 src 删除后脚本悄悄跳过后端代码。
test("质量脚本使用 apps server 源码目录", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const ciScript = readRepoFile("scripts/ci.ts");
  const githubWorkflow = readRepoFile(".github/workflows/ci.yml");

  for (const script of ["lint", "lint:fix", "format", "format:check"]) {
    expect(packageJson.scripts[script]).toContain("apps/server/src/");
    expect(packageJson.scripts[script]).not.toMatch(/(?:^|\s)src\//);
  }
  expect(ciScript).toContain("apps/server/src/__tests__/");
  expect(ciScript).not.toContain("bun test src/__tests__/");
  expect(githubWorkflow).toContain("find apps/server/src/__tests__");
  expect(githubWorkflow).not.toContain("find src/__tests__");
});

// 前端类型检查必须包含 apps 入口，否则 Router 的全局类型注册会在迁移后丢失。
test("前端类型检查使用 apps web 配置", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const webTsconfig = readRepoFile("apps/web/tsconfig.json");

  expect(packageJson.scripts["typecheck:web"]).toContain("apps/web/tsconfig.json");
  expect(webTsconfig).toContain('"src/**/*.tsx"');
});

// 前端入口迁入 apps 后，Tailwind 必须继续扫描应用壳源码以生成页面 utility 样式。
test("Tailwind 扫描 apps web 应用壳源码以生成页面 utility 样式", () => {
  const styles = readRepoFile("apps/web/src/index.css");

  expect(styles).toContain('@source "../**/*.{ts,tsx}";');
});
