// packages/resources/skill/src/__tests__/skill-source-boundary.test.ts
// Skill 的包边界契约测试（任务 1.3 W2 交付物）。与 mcp / sandbox 的同名文件同口径：断言的是**引用面**
// 与**导出形态**，不是「文件存在」——包必须能在没有宿主解析环境（`apps/server` 的 tsconfig 与
// `apps/web` 的 vite 别名）时独立构建，而「源码里出现一条宿主导入」正是这件事失效的最小证据。
//
// 只读文件、不 import 被测模块：把这些文件 import 进来会把懒加载的宿主单例与 Elysia 实例带进测试进程。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PKG_ROOT = resolve(import.meta.dir, "../..");
const SOURCE_DIRS = ["src", "web"];

/** 表定义迁出归任务 1.7，本任务作为显式残留保留这一条精确路径（§5）。 */
const ALLOWED_HOST_IMPORT = "@server/db/schema";

/** 剥掉行注释与块注释：注释里会举例写出宿主别名与旧路径，直接匹配会误报。 */
function stripComments(code: string): string {
  return code.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...listSourceFiles(full));
    else if (/\.tsx?$/.test(entry)) files.push(full);
  }
  return files;
}

/** 取模块说明符（import/export 的 from 子句）；`import type` 同样计入——类型导入也写进包内引用面。 */
function specifiers(code: string): string[] {
  return [...code.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((match) => match[1] ?? "");
}

const ALL_SOURCE_FILES = SOURCE_DIRS.flatMap((dir) => listSourceFiles(join(PKG_ROOT, dir)));

describe("skill 包边界契约", () => {
  // 生产代码只允许表定义这一条宿主导入：任何别的 `@server/*` 都意味着包重新伸手取宿主内部实现。
  test("@server 引用面只剩表定义", () => {
    const offenders: string[] = [];
    const allowedFiles = new Set<string>();
    for (const file of ALL_SOURCE_FILES) {
      for (const specifier of specifiers(stripComments(readFileSync(file, "utf8")))) {
        if (!specifier.startsWith("@server/")) continue;
        if (specifier === ALLOWED_HOST_IMPORT) allowedFiles.add(relative(PKG_ROOT, file));
        else offenders.push(`${relative(PKG_ROOT, file)} → ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
    // 残留清单写死：新增一处表定义引用（例如第二个模块也直接摸表）必须让这条断言失败并被复核。
    expect([...allowedFiles].sort()).toEqual([
      "src/server/access/skill-resource.ts",
      "src/server/repositories/agent-config-skill.ts",
      "src/server/repositories/skill.ts",
    ]);
  });

  // 会话鉴权路由必须可注入守卫（工厂 + 无 default export）：宿主要接回自己的认证实例，而不是包自建一份。
  test("会话鉴权路由以工厂导出且不保留已构造的 default 实例", () => {
    for (const routePath of ["src/server/routes/api/skills.ts", "src/server/routes/web/config/skills.ts"]) {
      const code = stripComments(readFileSync(join(PKG_ROOT, routePath), "utf8"));
      expect(code).toMatch(/export function create\w+Routes\(deps: SkillRouteDependencies\)/);
      expect(code).toContain(".use(deps.authGuardPlugin)");
      expect(code).not.toMatch(/export default/);
    }
    // 下载端点凭令牌自授权、无 session 主体，因此按实例导出而不是工厂——这条是刻意的例外。
    const downloadRoutes = stripComments(readFileSync(join(PKG_ROOT, "src/server/routes/skills.ts"), "utf8"));
    expect(downloadRoutes).toContain("export const skillDownloadRoutes = new Elysia");
  });

  // 依赖类型文件只放类型：一旦引入运行时代码，就会形成「入口 → 工厂 → 入口」的循环导入。
  test("routes/dependencies.ts 只有类型导入", () => {
    const code = stripComments(readFileSync(join(PKG_ROOT, "src/server/routes/dependencies.ts"), "utf8"));
    const importLines = code.split("\n").filter((line) => /^[ \t]*import\b/.test(line));
    expect(importLines.length).toBeGreaterThan(0);
    expect(importLines.filter((line) => !line.includes("import type"))).toEqual([]);
  });

  // 模块 id 是 registry 的索引键：清单与组合根不一致会让装配取到别的模块；`create` 必须惰性，
  // 否则索引层就会把 Drizzle / Elysia 拉进模块图。
  test("fenix.module.ts 的 id 与组合根一致且 create 保持惰性", () => {
    const manifest = readFileSync(join(PKG_ROOT, "fenix.module.ts"), "utf8");
    expect(manifest).toContain('id: "skill"');
    expect(manifest).toContain('create: () => import("./src/module").then((module) => module.createSkillModule())');
    expect(readFileSync(join(PKG_ROOT, "src/module.ts"), "utf8")).toContain('readonly id: "skill"');
  });

  // 浏览器入口的包导出契约：消费方只认子路径，改指向文件即断链（vite 别名与宿主 i18n 都按此解析）。
  test("package.json 声明 ./web 与 ./web/i18n 出口", () => {
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, string>;
    };
    expect(pkg.exports["./web"]).toBe("./web/index.ts");
    expect(pkg.exports["./web/i18n"]).toBe("./web/i18n/index.ts");
  });

  // README 是交付物的一部分：缺节会让读者以为能力不存在（本包 README 曾写「没有 web/index.ts」）。
  test("README 五节齐备且非占位", () => {
    const readme = readFileSync(join(PKG_ROOT, "README.md"), "utf8");
    for (const section of ["定位与 owner", "服务端交付物", "web 面与 i18n", "边界残留", "已知项"]) {
      expect(readme).toContain(`## ${section}`);
    }
    expect(readme.length).toBeGreaterThanOrEqual(1500);
    for (const placeholder of ["TODO", "待补", "占位", "Lorem"]) expect(readme).not.toContain(placeholder);
  });
});
