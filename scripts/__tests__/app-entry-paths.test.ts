import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

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
  const staticPlugin = readRepoFile("src/plugins/static.ts");

  expect(packageJson.scripts.dev).toBe("bun run apps/server/src/main.ts");
  expect(packageJson.scripts.start).toBe("bun run apps/server/src/main.ts");
  expect(packageJson.scripts["dev:web"]).toContain("apps/web/vite.config.ts");
  expect(packageJson.scripts["build:web"]).toContain("apps/web/vite.config.ts");
  expect(viteConfig).toContain("root: __dirname");
  expect(viteConfig).toContain('path.resolve(__dirname, "index.html")');
  expect(staticPlugin).toContain('"apps/web/dist"');
});

// 前端类型检查必须包含 apps 入口，否则 Router 的全局类型注册会在迁移后丢失。
test("前端类型检查使用 apps web 配置", () => {
  const packageJson = JSON.parse(readRepoFile("package.json")) as { scripts: Record<string, string> };
  const webTsconfig = readRepoFile("apps/web/tsconfig.json");

  expect(packageJson.scripts["typecheck:web"]).toContain("apps/web/tsconfig.json");
  expect(webTsconfig).toContain('"../../web/src/**/*.tsx"');
});

// 前端入口迁入 apps 后，Tailwind 仍须扫描保留在 web 下的页面与组件源码。
test("Tailwind 扫描 web 领域源码以生成页面 utility 样式", () => {
  const styles = readRepoFile("web/src/index.css");

  expect(styles).toContain('@source "../**/*.{ts,tsx}";');
});
