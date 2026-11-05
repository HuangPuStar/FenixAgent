import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConsoleRoutes } from "../console";

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
// 登录壳可公开加载，数据仍须通过 API 鉴权，静态路由不暴露目录里的其他文件。
test("serves the login shell and hashed assets with restrictive headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "cluster-ui-"));
  dirs.push(root);
  await Bun.write(join(root, "index.html"), '<html><div id="root"></div></html>');
  await Bun.write(join(root, "assets/index-test.js"), 'console.log("login")');
  await Bun.write(join(root, "private.txt"), "secret");
  const app = createConsoleRoutes(root);
  const home = await app.handle(new Request("http://cluster/"));
  expect(home.status).toBe(200);
  expect(home.headers.get("cache-control")).toBe("no-store");
  expect(home.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect((await app.handle(new Request("http://cluster/assets/index-test.js"))).status).toBe(200);
  expect((await app.handle(new Request("http://cluster/assets/private.txt"))).status).toBe(404);
  expect((await app.handle(new Request("http://cluster/private.txt"))).status).toBe(404);
});
