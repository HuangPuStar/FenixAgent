// fs-symlink-escape.test.ts —— F2 symlink 逃逸修复验证（P0 安全闭环）
// resolveWorkspacePath 引入 realpath 真实路径越界检查后：workspace 内指向外部
// 目录的 symlink 在读/写/删/rename/list 操作层全部被拒（404 not_found）；
// workspace 内部 symlink 与 WORKSPACE_ROOT 自身为 symlink 的场景不受影响（不误伤）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWebFsRoutes } from "../server/routes/web/fs";
import {
  initializeMachineModuleConfig,
  lockMachineWorkspaceRoot,
  stubMachineEnvironmentRecord,
  unlockMachineWorkspaceRoot,
} from "../server/testing";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "./guard-stubs";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

// 路由实例文件级构造一次：会话守卫替身按请求期读取当前会话，用例内 setTestAuth 即时生效；
// 环境读取经包内句柄替换（stubMachineEnvironmentRecord），beforeEach 注入即可。
const fsRoutes = createWebFsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

let workspaceRoot: string;
let outsideDir: string;

function stubAuth() {
  setTestAuth({
    user: { id: USER_ID, email: "user@fenix.com", name: "user" },
    authContext: { organizationId: ORG_ID, userId: USER_ID, role: "owner" },
  });
}

function stubEnvironment() {
  stubMachineEnvironmentRecord({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID });
}

/** fs 路由直连 handle（会话认证由 setTestAuth 注入） */
function fsHandle(path: string, init?: RequestInit): Promise<Response> {
  return fsRoutes.handle(new Request(`http://localhost/environments/${ENV_ID}${path}`, init));
}

/** workspace 目录（WORKSPACE_ROOT/org/user/env） */
function envDir(): string {
  return join(workspaceRoot, ORG_ID, USER_ID, ENV_ID);
}

/** user 子目录 */
function userDir(): string {
  return join(envDir(), "user");
}

/** 断言响应为统一 404 错误结构（§2.4 契约：not_found，与 fs-routes-converged 同构） */
async function expectNotFound(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect((await response.json()) as unknown).toEqual({
    error: { type: "not_found", message: expect.any(String) },
  });
}

beforeEach(async () => {
  initializeMachineModuleConfig();
  stubEnvironment();
  stubAuth();
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-symlink-escape-"));
  outsideDir = await mkdtemp(join(tmpdir(), "fs-symlink-outside-"));
  await lockMachineWorkspaceRoot(workspaceRoot);
  // 外部目录预置一个文件，供读/删/rename 逃逸断言
  await writeFile(join(outsideDir, "secret.txt"), "top-secret", "utf-8");
  // workspace 结构：user/ + 指向外部的逃逸 symlink（link）+ 指向内部的合法 symlink（link2）
  await mkdir(userDir(), { recursive: true });
  await symlink(outsideDir, join(userDir(), "link"), "dir");
  await mkdir(join(envDir(), "docs"), { recursive: true });
  await symlink(join(envDir(), "docs"), join(userDir(), "link2"), "dir");
});

afterEach(async () => {
  resetTestAuth();
  // 根状态由解锁负责清除（未持锁时是空操作，不会替并发持有者改根），不再手动 delete
  unlockMachineWorkspaceRoot();
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe("symlink 逃逸防护", () => {
  test("读取外部 symlink 目标被拒绝（404，不得返回外部文件内容）", async () => {
    // user/link → /tmp/outside，读 link/secret.txt 必须 404，防读出 workspace 外文件
    const res = await fsHandle("/fs/user/link/secret.txt");
    await expectNotFound(res);
  });

  test("写入外部 symlink 目标被拒绝且外部目录未被写入", async () => {
    // PUT 到 user/link/evil.txt（目标不存在，落点由祖先 link 的真实位置决定）必须 404，且外部目录不得出现新文件
    const res = await fsHandle("/fs/user/link/evil.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "evil" }),
    });
    await expectNotFound(res);
    expect(await readdir(outsideDir)).not.toContain("evil.txt");
  });

  test("删除外部 symlink 目标被拒绝且外部文件未被删除", async () => {
    // DELETE 外部文件（经 user/link 解析）必须 404，外部文件保留
    const res = await fsHandle("/fs/user/link/secret.txt", { method: "DELETE" });
    await expectNotFound(res);
    expect(await readFile(join(outsideDir, "secret.txt"), "utf-8")).toBe("top-secret");
  });

  test("重命名外部 symlink 目标被拒绝", async () => {
    // rename 源为外部文件（经 user/link 解析）必须 404，外部文件保留
    const res = await fsHandle("/fs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "user/link/secret.txt", newPath: "user/moved.txt" }),
    });
    await expectNotFound(res);
    expect(await readFile(join(outsideDir, "secret.txt"), "utf-8")).toBe("top-secret");
  });

  test("列出外部 symlink 目录被拒绝", async () => {
    // list 外部目录（经 user/link 解析）必须 404，防展示层泄漏外部条目
    const res = await fsHandle("/fs?path=user/link");
    await expectNotFound(res);
  });
});

describe("不误伤", () => {
  test("workspace 内部 symlink 读写放行", async () => {
    // user/link2 → ../docs（workspace 根内）：读、写都必须成功，落点确在 workspace 内
    await writeFile(join(envDir(), "docs", "readme.md"), "hello", "utf-8");
    const readRes = await fsHandle("/fs/user/link2/readme.md");
    expect(readRes.status).toBe(200);
    const writeRes = await fsHandle("/fs/user/link2/new.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "data" }),
    });
    expect(writeRes.status).toBe(200);
    expect(await readFile(join(envDir(), "docs", "new.txt"), "utf-8")).toBe("data");
  });

  test("WORKSPACE_ROOT 本身为 symlink 时读写正常", async () => {
    // 基准用 realpath(workspaceDir) 规范化：WORKSPACE_ROOT 指向真实根目录的软链不应误伤正常读写
    const realRoot = await mkdtemp(join(tmpdir(), "fs-symlink-realroot-"));
    const linkRoot = join(tmpdir(), `fs-root-link-${Math.random().toString(36).slice(2)}`);
    await symlink(realRoot, linkRoot, "dir");
    // 本用例会在运行中把根切到软链目录：必须重新经锁独占（契约见 workspace-root-lock.ts 的
    // 「含按用例切换根的」）。先释放本文件 beforeEach 持有的根再重新排队——直接二次取锁会等自己
    // 的释放而空等到锁的等待上限；直接改 process.env 则会把并发文件正在读的根换掉。
    unlockMachineWorkspaceRoot();
    await lockMachineWorkspaceRoot(linkRoot);
    try {
      const writeRes = await fsHandle("/fs/user/ok.txt", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "fine" }),
      });
      expect(writeRes.status).toBe(200);
      const readRes = await fsHandle("/fs/user/ok.txt");
      expect(readRes.status).toBe(200);
      expect(await readFile(join(realRoot, ORG_ID, USER_ID, ENV_ID, "user", "ok.txt"), "utf-8")).toBe("fine");
    } finally {
      // 恢复（删除）根必须在解锁之前：反序会让下一个文件立刻写入它的根，本次删除就把对方的根改坏了
      unlockMachineWorkspaceRoot();
      await rm(realRoot, { recursive: true, force: true });
    }
  });
});
