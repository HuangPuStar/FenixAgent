import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const mainSource = readFileSync(resolve(import.meta.dir, "../main.ts"), "utf8");

// 启动 builtin 同步会写入公开读取授权，权限端口必须在它之前由宿主完成装配。
test("configures resource permission ports before builtin synchronization", () => {
  expect(mainSource.indexOf("configureResourcePermissionRepository(pgResourcePermissionRepo)")).toBeGreaterThan(-1);
  expect(mainSource.indexOf("await syncBuiltin()")).toBeGreaterThan(-1);
  expect(mainSource.indexOf("configureResourcePermissionRepository(pgResourcePermissionRepo)")).toBeLessThan(
    mainSource.indexOf("await syncBuiltin()"),
  );
});
