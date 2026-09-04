import { describe, expect, test } from "bun:test";
import { dirname, relative, resolve } from "node:path";

const PACKAGE_ROOT = resolve(import.meta.dir, "../../packages/server-runtime");
const SOURCE_ROOT = resolve(PACKAGE_ROOT, "src");
const IMPORT_PATTERN = /(?:from\s+|import\s*\()(["'])([^"']+)\1/g;

async function listSourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for await (const path of new Bun.Glob("**/*.ts").scan({ cwd: SOURCE_ROOT, absolute: true })) files.push(path);
  return files;
}

describe("server-runtime package boundary", () => {
  // Runtime package 的相对导入不能逃逸 package，避免形成 packages → src 反向依赖。
  test("keeps relative imports inside the package", async () => {
    for (const file of await listSourceFiles()) {
      const source = await Bun.file(file).text();
      for (const match of source.matchAll(IMPORT_PATTERN)) {
        const specifier = match[2];
        if (!specifier?.startsWith(".")) continue;
        const target = resolve(dirname(file), specifier);
        expect(relative(PACKAGE_ROOT, target).startsWith("..")).toBe(false);
      }
    }
  });

  // 通用 Runtime 不能读取宿主进程配置或工作目录，edition 参数必须由模块工厂显式注入。
  test("does not read process environment or working directory", async () => {
    for (const file of await listSourceFiles()) {
      const source = await Bun.file(file).text();
      expect(source).not.toContain("process.env");
      expect(source).not.toContain("process.cwd(");
      expect(source).not.toContain("Bun.env");
    }
  });

  // Package 只能依赖 Elysia，不能把社区业务包带入稳定 Runtime 契约。
  test("declares only the Elysia runtime dependency", async () => {
    const manifest = await Bun.file(resolve(PACKAGE_ROOT, "package.json")).json();
    expect(manifest.dependencies).toEqual({ elysia: "^1.4.28" });
  });
});
