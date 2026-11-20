import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../index.ts");
const packageRoot = resolve(import.meta.dir, "../..");
const allowed =
  /^(react(?:\/|$)|react-i18next$|lucide-react$|codemirror$|@codemirror\/|@milkdown\/|remark-frontmatter$|@fenix\/ui-components\/)/;

/** Walks actual transpiler imports, including lazy modules, instead of matching comments or type declarations. */
function graph(start: string) {
  const visited = new Set<string>();
  const forbidden: string[] = [];
  const queue = [start];
  while (queue.length) {
    const file = queue.pop();
    if (!file || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, "utf8");
    const scanned = new Bun.Transpiler({ loader: file.endsWith(".tsx") ? "tsx" : "ts" }).scan(source);
    for (const dependency of scanned.imports) {
      const specifier = dependency.path;
      if (specifier.startsWith(".")) {
        const base = resolve(dirname(file), specifier);
        const target = [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(existsSync);
        if (!target?.startsWith(packageRoot) || relative(packageRoot, target).startsWith("src/"))
          forbidden.push(`${file}: ${specifier}`);
        else queue.push(target);
      } else if (!allowed.test(specifier)) forbidden.push(`${file}: ${specifier}`);
    }
  }
  return { visited, forbidden };
}

// web 出口及动态编辑器必须保持浏览器安全，Machine/Runtime 与服务端模块均不可达。
test("web runtime import graph has no host or server dependency", () => {
  const result = graph(entry);
  expect(result.forbidden).toEqual([]);
  expect([...result.visited].map((file) => relative(packageRoot, file))).toContain("web/hooks/editing-store.ts");
  expect([...result.visited].map((file) => relative(packageRoot, file))).toContain(
    "web/editors/markdown-frontmatter.ts",
  );
});

// 构建器实际解析整个独立浏览器出口，避免静态图对失效说明符产生假阳性。
test("web export compiles for browsers with editor dependencies externalized", async () => {
  const result = await Bun.build({ entrypoints: [entry], target: "browser", packages: "external" });
  expect(result.logs.filter((log) => log.level === "error").map((log) => log.message)).toEqual([]);
  expect(result.success).toBe(true);
});
