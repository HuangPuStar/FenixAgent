// fs-opid-ifmatch.test.ts —— W12b（P2-15 HTTP 载体 + P2-17 If-Match）
// 写端点契约：X-File-Op-Id 头透传 service 并在成功/错误响应中原样回显（§7.2 幂等
// 重试标识）；If-Match（读时 ETag）不匹配 → 409 version_conflict + 当前版本回显
// （§4.4 覆盖可感知性）；不带头行为与现状一致。本地 tmp 目录直连路由，远程经
// stub sendFileOpAndWait 验证 op_id 帧透传与 remoteStat 版本比对。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { resolveWorkspacePath } from "../services/workspace-fs";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubFileWsHandler } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";

// 动态 import 路由模块。environmentRepo / file-ws-handler 的 mock 是实时转发
// （setup-mocks.ts），属性访问总是转发到当前 stub，beforeEach 注入即可。
const fsRoutes = await import("../routes/web/fs");

let workspaceRoot: string;

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

/** 经 resolveWorkspacePath 写入（其会先 mkdir user 作用域目录，保证父目录存在） */
async function writeWorkspaceFile(rel: string, content: string): Promise<void> {
  const resolved = await resolveWorkspacePath(ENV_ID, rel);
  await writeFile(resolved!.resolved, content);
}

/** PUT write 请求：content + 可选 X-File-Op-Id / If-Match 头 */
function putWrite(path: string, content: string, headers: Record<string, string> = {}): Promise<Response> {
  return handle(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ content }),
  });
}

/** 读文件响应中的当前 ETag（GET 响应头；服务端按 size-mtimeMs 派生） */
async function currentEtag(path: string): Promise<string> {
  const res = await handle(path);
  expect(res.status).toBe(200);
  const etag = res.headers.get("etag");
  expect(etag).toBeTruthy();
  return etag!;
}

beforeEach(async () => {
  resetAllStubs();
  stubEnvironment();
  stubAuth();
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-opid-ifmatch-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

describe("X-File-Op-Id 回显（§7.2）", () => {
  test("带 X-File-Op-Id 的 write 成功响应原样回显 op_id", async () => {
    // 幂等键契约：消费者携带 X-File-Op-Id 时，成功响应 { success, data, op_id }
    // 必须原样回显同值，消费者据此识别幂等重试
    const res = await putWrite("/fs/user/a.txt", "hello", { "X-File-Op-Id": "op-1" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; data: { path: string }; op_id?: string };
    expect(body.success).toBe(true);
    expect(body.data.path).toBe("user/a.txt");
    expect(body.op_id).toBe("op-1");
  });

  test("不带头行为与现状一致：成功响应无 op_id 字段", async () => {
    // 无 X-File-Op-Id 的写 = 至少一次无去重（§7.2 契约）；响应结构不得多出 op_id
    const res = await putWrite("/fs/user/a.txt", "hello");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { success: boolean; op_id?: string };
    expect(body.success).toBe(true);
    expect("op_id" in body).toBe(false);
  });

  test("错误响应同样回显 op_id（409 冲突场景）", async () => {
    // 错误响应回显契约：消费者据此识别"本次失败属于哪次幂等重试"；409 响应
    // 必须同时携带 op_id 与 currentVersion
    await writeWorkspaceFile("user/a.txt", "hello");
    const oldEtag = await currentEtag("/fs/user/a.txt");
    // 外部修改使版本前进（size 变化 → ETag 必变，与 mtime 精度无关）
    await writeWorkspaceFile("user/a.txt", "hello world");
    const res = await putWrite("/fs/user/a.txt", "new", {
      "X-File-Op-Id": "op-retry-1",
      "If-Match": oldEtag,
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { type: string };
      currentVersion?: { etag: string; mtimeMs: number; size: number };
      op_id?: string;
    };
    expect(body.error.type).toBe("version_conflict");
    expect(body.currentVersion?.etag).toBe(await currentEtag("/fs/user/a.txt"));
    expect(body.op_id).toBe("op-retry-1");
  });

  test("delete/rename/mkdir/upload/batch 成功响应均回显 op_id", async () => {
    // 全部写端点（write/upload/delete/mkdir/rename/batch）统一执行 §7.2 回显契约，
    // 防止个别端点漏实现导致消费者无法识别幂等重试
    await writeWorkspaceFile("user/a.txt", "x");
    await writeWorkspaceFile("user/b.txt", "y");

    const mkdirRes = await handle("/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-File-Op-Id": "op-mkdir" },
      body: JSON.stringify({ path: "user/sub" }),
    });
    expect(((await mkdirRes.json()) as { op_id: string }).op_id).toBe("op-mkdir");

    const renameRes = await handle("/fs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-File-Op-Id": "op-rename" },
      body: JSON.stringify({ oldPath: "user/a.txt", newPath: "user/a2.txt" }),
    });
    expect(((await renameRes.json()) as { op_id: string }).op_id).toBe("op-rename");

    const delRes = await handle("/fs/user/a2.txt", {
      method: "DELETE",
      headers: { "X-File-Op-Id": "op-delete" },
    });
    expect(((await delRes.json()) as { op_id: string }).op_id).toBe("op-delete");

    const upForm = new FormData();
    upForm.append("files", new File(["up"], "up.txt"));
    const upRes = await handle("/fs/user/sub", {
      method: "POST",
      headers: { "X-File-Op-Id": "op-upload" },
      body: upForm,
    });
    expect(((await upRes.json()) as { op_id: string }).op_id).toBe("op-upload");

    const batchRes = await handle("/fs/batch", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", "X-File-Op-Id": "op-batch" },
      body: JSON.stringify({ paths: ["user/b.txt", "user/missing.txt"] }),
    });
    expect(((await batchRes.json()) as { op_id: string }).op_id).toBe("op-batch");
  });
});

describe("If-Match 条件写（§4.4）", () => {
  test("If-Match 与当前版本一致 → 正常写入", async () => {
    // 读改写闭环：消费者读到的 ETag 原样写回比对一致 → 200，内容覆盖为新值
    await writeWorkspaceFile("user/a.txt", "hello");
    const etag = await currentEtag("/fs/user/a.txt");
    const res = await putWrite("/fs/user/a.txt", "updated", { "If-Match": etag });
    expect(res.status).toBe(200);
    const read = await handle("/fs/user/a.txt");
    expect(((await read.json()) as { data: { content: string } }).data.content).toBe("updated");
  });

  test("If-Match 旧值 → 409 version_conflict + 当前 ETag/mtime，写入被拒绝", async () => {
    // 消费者-消费者冲突：读取后文件被他人修改，保存必须 409 且携带当前版本
    // （ETag/mtime/size）供提示与重试；旧内容不得被覆盖（LWW 必须显式冲突而非静默）
    await writeWorkspaceFile("user/a.txt", "hello");
    const oldEtag = await currentEtag("/fs/user/a.txt");
    await writeWorkspaceFile("user/a.txt", "hello world");
    const res = await putWrite("/fs/user/a.txt", "new", { "If-Match": oldEtag });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { type: string; message: string };
      currentVersion: { etag: string; mtimeMs: number; size: number };
    };
    expect(body.error.type).toBe("version_conflict");
    expect(body.currentVersion.etag).toBe(await currentEtag("/fs/user/a.txt"));
    expect(body.currentVersion.size).toBe(11);
    expect(body.currentVersion.mtimeMs).toBeGreaterThan(0);
    const read = await handle("/fs/user/a.txt");
    expect(((await read.json()) as { data: { content: string } }).data.content).toBe("hello world");
  });

  test("目标不存在 + If-Match → 409（HTTP 语义：资源缺失即失败）", async () => {
    // 消费者读到文件后文件被删：条件写必须失败而非静默重建（资源缺失 ≠ 可创建）
    const res = await putWrite("/fs/user/missing.txt", "x", { "If-Match": '"1-1"' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("version_conflict");
    expect(body.error.message).toContain("不存在");
  });

  test("If-Match 通配 * → 放行（资源存在即匹配）", async () => {
    // HTTP If-Match 通配语义：* 表示"资源必须存在"，当前文件存在 → 正常写入
    await writeWorkspaceFile("user/a.txt", "hello");
    const res = await putWrite("/fs/user/a.txt", "star", { "If-Match": "*" });
    expect(res.status).toBe(200);
  });
});

describe("远程环境（stub file-ws）：op_id 帧透传 + remoteStat 比对", () => {
  beforeEach(() => {
    stubDb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }),
    });
    stubFileWsHandler({ isFileWsConnected: () => true });
    setConfig({ defaultMachineId: MACHINE_ID });
  });

  /** 记录 file_op 调用的 stub：stat 返回固定版本（size=5, modifiedAt=1000），
   *  其他操作返回 ok；调用记录供断言 op_id 帧透传 */
  function stubRemoteWithLog() {
    const calls: Array<{ operation: string; options?: Record<string, unknown> }> = [];
    const sendFileOpMock = mock(
      async (
        _machineId: string,
        operation: string,
        _params: Record<string, unknown> = {},
        _timeoutMs?: number,
        options?: Record<string, unknown>,
      ): Promise<{ status: string; data?: unknown }> => {
        calls.push({ operation, options });
        if (operation === "stat") {
          return { status: "ok", data: { size: 5, isDirectory: false, modifiedAt: 1000 } };
        }
        if (operation === "write") return { status: "ok", data: { name: "a.txt", path: "user/a.txt", size: 5 } };
        throw new Error(`unexpected operation: ${operation}`);
      },
    );
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendFileOpMock });
    return calls;
  }

  test("write 带 X-File-Op-Id → 帧携带 op_id，响应回显同值", async () => {
    // 远程写操作：opId 必须透传到 file_op 帧（机器端 (machine, env, op_id) 去重
    // 缓存的载体），HTTP 响应回显同值，契约闭环
    const calls = stubRemoteWithLog();
    const res = await putWrite("/fs/user/a.txt", "hello", { "X-File-Op-Id": "op-remote" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { op_id: string }).op_id).toBe("op-remote");
    const writeCall = calls.find((c) => c.operation === "write");
    expect(writeCall?.options?.opId).toBe("op-remote");
  });

  test("If-Match 与 remoteStat 派生 ETag 不一致 → 409 + 当前版本", async () => {
    // 远程条件写：比对发生在服务端（remoteStat 的 size+modifiedAt 派生 ETag，
    // 与读侧指纹同规则）；stat 成功但版本不一致 → 409 携带当前版本
    stubRemoteWithLog();
    // 远程版本为 size=5, modifiedAt=1000 → ETag "5-1000"；携带旧值必然冲突
    const res = await putWrite("/fs/user/a.txt", "hello", { "If-Match": '"5-999"' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { type: string };
      currentVersion: { etag: string };
    };
    expect(body.error.type).toBe("version_conflict");
    expect(body.currentVersion.etag).toBe('"5-1000"');
  });
});
