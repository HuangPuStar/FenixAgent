// fs-etag.test.ts —— W13' ETag 条件请求（P1-9，D9/D11 读侧）
// tree/list/read 三端点：响应恒带 ETag + Cache-Control: no-cache；
// If-None-Match 一致 → 304（无 body）；不带头恒 200；rename 后 tree ETag 必须变化
// （路径 hash 参与指纹，修复仅 max mtime + 条数的 304 误判）。本地 tmp 目录直连路由。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import {
  computeListFingerprint,
  computeReadFingerprint,
  computeTreeFingerprint,
  resolveWorkspacePath,
} from "../services/workspace-fs";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

// 动态 import 路由模块。environmentRepo 的 mock 是实时转发（setup-mocks.ts），
// 属性访问总是转发到当前 stub，beforeEach 注入即可（与 fs-routes-converged 同模式）。
const fsRoutes = await import("../routes/web/fs");

let workspaceRoot: string;

/** workspace 内文件的绝对路径（WORKSPACE_ROOT/org/user/env/rel） */
function workspaceFile(rel: string): string {
  return join(workspaceRoot, ORG_ID, USER_ID, ENV_ID, rel);
}

/** 经 resolveWorkspacePath 写入（其会先 mkdir user 作用域目录，保证父目录存在） */
async function writeWorkspaceFile(rel: string, content: string): Promise<void> {
  const resolved = await resolveWorkspacePath(ENV_ID, rel);
  await writeFile(resolved!.resolved, content);
}

function stubAuth() {
  setTestAuth({
    user: { id: USER_ID, email: "user@fenix.com", name: "user" },
    authContext: { organizationId: ORG_ID, userId: USER_ID, role: "owner" },
  });
}

function stubEnvironment() {
  stubEnvironmentRepo({
    getById: async () => ({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID }),
  });
}

/** 直连路由 handle（会话认证由 setTestAuth 注入） */
function handle(path: string, init?: RequestInit): Promise<Response> {
  return fsRoutes.default.handle(new Request(`http://localhost/environments/${ENV_ID}${path}`, init));
}

beforeEach(async () => {
  resetAllStubs();
  stubEnvironment();
  stubAuth();
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-etag-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

describe("tree 端点 ETag 条件请求", () => {
  test("连续两次请求第二次 304；不带头恒 200", async () => {
    // 条件请求语义：无 If-None-Match → 恒 200 + ETag；带相同 ETag → 304 无 body，
    // 304 响应保留 ETag 供客户端更新缓存；再次无条件请求仍 200（无状态设计不省扫描）
    await writeWorkspaceFile("user/a.txt", "hello");
    const first = await handle("/fs/tree");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const second = await handle("/fs/tree", { headers: { "If-None-Match": etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("etag")).toBe(etag);

    const third = await handle("/fs/tree");
    expect(third.status).toBe(200);
    expect(third.headers.get("etag")).toBe(etag);
  });

  test("rename 后 tree ETag 变化（路径 hash 参与指纹）", async () => {
    // rename 只改变路径集合、目录 mtime 可能不变：路径排序 hash 参与指纹后
    // ETag 必须变化，否则客户端会收到 304 误判"无变化"（D9 修复点）
    await writeWorkspaceFile("user/a.txt", "x");
    const before = await handle("/fs/tree");
    const etagBefore = before.headers.get("etag");
    expect(etagBefore).toBeTruthy();

    await rename(workspaceFile("user/a.txt"), workspaceFile("user/b.txt"));
    const after = await handle("/fs/tree");
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(etagBefore);
  });
});

describe("list 端点 ETag 条件请求", () => {
  test("304 命中；新增文件后指纹变化不再命中", async () => {
    // 目录条目指纹含条目内容：目录变化（新增文件）→ 指纹变化 → 带旧 ETag 的
    // 条件请求返回 200 全量；无变化时 304
    await writeWorkspaceFile("user/a.txt", "a");
    const first = await handle("/fs?path=user");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const unchanged = await handle("/fs?path=user", { headers: { "If-None-Match": etag! } });
    expect(unchanged.status).toBe(304);

    await writeWorkspaceFile("user/b.txt", "b");
    const changed = await handle("/fs?path=user", { headers: { "If-None-Match": etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });
});

describe("read 端点 ETag 条件请求", () => {
  test("304 命中；内容变化后指纹变化不再命中", async () => {
    // read 指纹为 size-mtimeMs：同一文件连续读 304；内容变化（size 变化）后 200
    await writeWorkspaceFile("user/a.txt", "hello");
    const first = await handle("/fs/user/a.txt");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    expect(first.headers.get("cache-control")).toBe("no-cache");

    const unchanged = await handle("/fs/user/a.txt", { headers: { "If-None-Match": etag! } });
    expect(unchanged.status).toBe(304);
    expect(await unchanged.text()).toBe("");

    await writeWorkspaceFile("user/a.txt", "hello world");
    const changed = await handle("/fs/user/a.txt", { headers: { "If-None-Match": etag! } });
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
  });

  test("二进制读（mode=binary 流）同样支持 304", async () => {
    // 流响应同样派生 ETag：mode=binary 连续两次（第二次带 If-None-Match）→ 304，
    // 304 时流被丢弃不消费（fd 由 destroy 释放，不泄漏）
    const { writeFile } = await import("node:fs/promises");
    const resolved = await resolveWorkspacePath(ENV_ID, "user/b.bin");
    await writeFile(resolved!.resolved, Buffer.from([1, 2, 3]));

    const first = await handle("/fs/user/b.bin?mode=binary");
    expect(first.status).toBe(200);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const unchanged = await handle("/fs/user/b.bin?mode=binary", { headers: { "If-None-Match": etag! } });
    expect(unchanged.status).toBe(304);
  });
});

describe("指纹纯函数弱指纹退化（远程数据源 mtime 缺失，§4.2 契约）", () => {
  test("read：无 mtime → size-only；有 mtime → size-mtimeMs", async () => {
    // 远程无 mtime 时退化为 size-only 弱指纹（内容同大小变更不可感知，契约接受边界）；
    // 有 mtime 时恢复强指纹；mtime=0 与缺省同义（不产生 "<size>-0" 强指纹假象）
    expect(computeReadFingerprint(3)).toBe('"3"');
    expect(computeReadFingerprint(3, 0)).toBe('"3"');
    expect(computeReadFingerprint(3, 12345)).toBe('"3-12345"');
  });

  test("tree：无 mtimes → 路径 hash + 条数；与全 0 mtimes 结果一致", async () => {
    // 远程 mtimes 缺失时指纹退化为路径集合维度；缺省与全 0 必须等值，
    // 否则机器端"补齐 mtime 但值恰为 0"会造成一次无意义失效
    expect(computeTreeFingerprint(["a.txt", "b.txt"])).toBe(computeTreeFingerprint(["a.txt", "b.txt"], {}));
    expect(computeTreeFingerprint(["a.txt"], { "a.txt": 0 })).toBe(computeTreeFingerprint(["a.txt"]));
    expect(computeTreeFingerprint(["a.txt"], { "a.txt": 7 })).not.toBe(computeTreeFingerprint(["a.txt"]));
  });

  test("list：modifiedAt 全 0 → hash(name+type+size)；任一 >0 → 强指纹", async () => {
    // 远程 list modifiedAt 全 0 时弱指纹：modifiedAt 缺省与 0 等值（同源条目不会
    // 混合，注释契约）；任一条目有 mtime 即整体强指纹，mtime 变化指纹必变
    const weak = [
      { name: "a.txt", type: "file", size: 3 },
      { name: "b.txt", type: "file", size: 4, modifiedAt: 0 },
    ];
    const weakSame = [
      { name: "a.txt", type: "file", size: 3, modifiedAt: 0 },
      { name: "b.txt", type: "file", size: 4 },
    ];
    const strongA = [{ name: "a.txt", type: "file", size: 3, modifiedAt: 9 }];
    const strongB = [{ name: "a.txt", type: "file", size: 3, modifiedAt: 10 }];
    expect(computeListFingerprint(weak)).toBe(computeListFingerprint(weakSame));
    expect(computeListFingerprint(weak)).not.toBe(computeListFingerprint(strongA));
    expect(computeListFingerprint(strongA)).not.toBe(computeListFingerprint(strongB));
  });
});
