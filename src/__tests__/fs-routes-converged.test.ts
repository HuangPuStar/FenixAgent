// fs-routes-converged.test.ts —— W5b 收敛验证（P1-7b，D10）
// 同一套路由断言分别在本地（无 machine 配置）与远程（stub file-ws 在线）环境下
// 返回一致错误码：400（非法路径/越界上传）/ 404（环境不可见）/ 429（busy +
// Retry-After）/ 503（file-ws 未连接）。fs.ts 已删除全部 if (machineId) 双分支，
// 本地/远程执行统一收敛到 AgentFileService 门面。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubFileWsHandler } from "../test-utils/helpers";
import { BusyError } from "../transport/file-ws-requests";

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

/** 构造 multipart 上传请求：一个文件 + 可选 relativePaths（fileName 可伪造 multipart filename）。
 *  目标目录 user/sub：W6 作用域校验强制相对路径落在 user/ 前缀内。 */
function uploadRequest(relativePaths?: string[], fileName = "evil.txt"): Request {
  const formData = new FormData();
  formData.append("files", new File(["evil"], fileName));
  if (relativePaths !== undefined) formData.append("relativePaths", JSON.stringify(relativePaths));
  return new Request(`http://localhost/environments/${ENV_ID}/fs/user/sub`, {
    method: "POST",
    body: formData,
  });
}

/** workspace 目录（WORKSPACE_ROOT/org/user/env） */
function workspaceDir(): string {
  return join(workspaceRoot, ORG_ID, USER_ID, ENV_ID);
}

/** 断言响应为统一错误结构 { error: { type, message } } 且状态码一致 */
async function expectError(response: Response, status: number, type: string): Promise<void> {
  expect(response.status).toBe(status);
  expect((await response.json()) as unknown).toEqual({
    error: { type, message: expect.any(String) },
  });
}

beforeEach(async () => {
  resetAllStubs();
  stubEnvironment();
  stubAuth();
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-routes-converged-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

/** 本地/远程共用错误契约：同一输入必须返回同一错误码（§2.4 收敛保证）。
 *  覆盖 400（越界上传/绝对路径）与 404（环境不可见）；429/503 为远程传输层
 *  状态，仅远程 describe 覆盖。 */
async function expectCommonErrorContract(): Promise<void> {
  resetAllStubs();
  stubEnvironment();
  stubAuth();
  // 越界上传（.. 段）→ 400 validation_error（D16 回归，W2 行为随迁）
  const escapeRes = await fsRoutes.default.handle(uploadRequest(["../evil.txt"]));
  await expectError(escapeRes, 400, "validation_error");
  // 绝对路径读文件 → 400 validation_error（门面统一前置校验，本地/远程一致）
  const absRead = await handle("/fs//etc/passwd");
  await expectError(absRead, 400, "validation_error");
  // 环境不存在或不可见 → 404 not_found（门面归属校验，先于路由决策）
  resetAllStubs();
  stubEnvironmentRepo({ getById: async () => null });
  stubAuth();
  const missing = await handle("/fs?path=user");
  await expectError(missing, 404, "not_found");
}

describe("本地环境（无 machine 配置）", () => {
  test("九个端点本地跑通：写读往返 + 树/列目录 + 上传 + 移动 + 删除 + 打包", async () => {
    // 本地全链路：write→read→list→tree→upload→mkdir→rename→batch→delete→download-zip 均成功
    const writeRes = await handle("/fs/user/hello.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "你好 fenix" }),
    });
    expect(writeRes.status).toBe(200);
    const writeBody = (await writeRes.json()) as { success: boolean; data: { path: string } };
    expect(writeBody.success).toBe(true);
    expect(writeBody.data.path).toBe("user/hello.txt");

    const readRes = await handle("/fs/user/hello.txt");
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { success: boolean; data: { content: string } };
    expect(readBody.data.content).toBe("你好 fenix");

    const listRes = await handle("/fs?path=user");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      success: boolean;
      data: { entries: Array<{ name: string }> };
    };
    expect(listBody.data.entries.map((e) => e.name)).toContain("hello.txt");

    const treeRes = await handle("/fs/tree");
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { success: boolean; data: { paths: string[] } };
    expect(treeBody.data.paths).toContain("user/hello.txt");

    const upForm = new FormData();
    upForm.append("files", new File(["up"], "a.txt"));
    const upRes = await handle("/fs/user/sub", { method: "POST", body: upForm });
    expect(upRes.status).toBe(200);
    const upBody = (await upRes.json()) as { success: boolean; data: { files: Array<{ path: string }> } };
    expect(upBody.data.files[0]?.path).toBe("user/sub/a.txt");

    const mkdirRes = await handle("/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "user/sub/nested" }),
    });
    expect(mkdirRes.status).toBe(200);

    const renameRes = await handle("/fs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "user/sub/a.txt", newPath: "user/sub/b.txt" }),
    });
    expect(renameRes.status).toBe(200);

    const batchRes = await handle("/fs/batch", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["user/sub/b.txt", "user/missing.txt"] }),
    });
    expect(batchRes.status).toBe(200);
    const batchBody = (await batchRes.json()) as {
      success: boolean;
      data: { deleted: string[]; failed: Array<{ path: string }> };
    };
    expect(batchBody.data.deleted).toEqual(["user/sub/b.txt"]);
    expect(batchBody.data.failed.map((f) => f.path)).toEqual(["user/missing.txt"]);

    const delRes = await handle("/fs/user/hello.txt", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    await expectError(await handle("/fs/user/hello.txt"), 404, "not_found");

    const zipRes = await handle("/fs/download-zip?path=user/sub");
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("Content-Type")).toBe("application/zip");
    expect(zipRes.headers.get("Content-Disposition")).toContain(".zip");
    expect(
      Buffer.from(await zipRes.arrayBuffer())
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
  });

  test("GET /fs 无 path 返回 200：默认列 workspace 根目录", async () => {
    // F1 回归：user/ 作用域强制删除后，无 path 的 GET /fs 必须默认列根目录
    // （query path 缺省 → "."），且根目录下 user/ 目录可见（resolveWorkspacePath
    // 会按需创建 userDir）
    const response = await handle("/fs");
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { entries: Array<{ name: string; type: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.entries.map((e) => e.name)).toContain("user");
  });

  test("非 user 路径（workspace 根 README.md）可写可读", async () => {
    // F1 回归：workspace 根内全部相对路径均合法，README.md 这类非 user/ 前缀
    // 路径可写、可读、可入树，不再被 user/ 作用域强制拦截
    const writeRes = await handle("/fs/README.md", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "# workspace readme" }),
    });
    expect(writeRes.status).toBe(200);
    const writeBody = (await writeRes.json()) as { success: boolean; data: { path: string } };
    expect(writeBody.data.path).toBe("README.md");

    const readRes = await handle("/fs/README.md");
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { success: boolean; data: { content: string } };
    expect(readBody.data.content).toBe("# workspace readme");

    // 根目录列表与树均可见根级 README.md（非 user 条目）
    const listRes = await handle("/fs");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      success: boolean;
      data: { entries: Array<{ name: string }> };
    };
    expect(listBody.data.entries.map((e) => e.name)).toContain("README.md");

    const treeRes = await handle("/fs/tree");
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { success: boolean; data: { paths: string[] } };
    expect(treeBody.data.paths).toContain("README.md");
  });

  test("本地错误契约：400（越界/绝对路径）+ 404（环境不可见）", async () => {
    // 本地场景错误码与远程一致（门面统一校验与归属检查，不依赖执行后端）
    await expectCommonErrorContract();
  });

  test("upload 成功文件落盘在 workspace 内", async () => {
    // 正常上传：文件应写入 WORKSPACE_ROOT/org/user/env/user 之下，内容一致
    const response = await fsRoutes.default.handle(uploadRequest(["folder/  note.txt"], "plain.txt"));
    expect(response.status).toBe(200);
    expect(await readFile(join(workspaceDir(), "user", "sub", "folder", "  note.txt"), "utf-8")).toBe("evil");
  });
});

describe("远程环境（stub file-ws 在线）", () => {
  beforeEach(() => {
    // 远程路由决策需要 machineId 配置 + file-ws 在线 + machine 存在（W6 三分语义，
    // machine 表存在性校验在 file-ws 连接检查之前）；每个用例独立 stub
    stubDb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }),
    });
    stubFileWsHandler({ isFileWsConnected: () => true });
    setConfig({ defaultMachineId: MACHINE_ID });
  });

  /** 按操作返回机器端结果的 stub（对齐 remote-file-service 的返回结构） */
  function stubRemoteOk() {
    const sendFileOpMock = mock(
      async (
        _machineId: string,
        operation: string,
        _params: Record<string, unknown> = {},
      ): Promise<{ status: string; data?: unknown }> => {
        switch (operation) {
          case "tree":
            return { status: "ok", data: { paths: ["user/a.txt"], mtimes: { "user/a.txt": 1 } } };
          case "list":
            return {
              status: "ok",
              data: { entries: [{ name: "a.txt", path: "user/a.txt", type: "file", size: 3, modifiedAt: 1 }] },
            };
          case "read":
            return {
              status: "ok",
              data: { name: "a.txt", path: "user/a.txt", content: "abc", size: 3, encoding: "utf-8" },
            };
          case "write":
            return { status: "ok", data: { name: "a.txt", path: "user/a.txt", size: 3 } };
          case "upload":
            return { status: "ok", data: { files: [{ name: "a.txt", path: "user/sub/a.txt", size: 3 }] } };
          case "delete":
            return { status: "ok", data: { ok: true } };
          case "mkdir":
            return { status: "ok", data: { path: "user/d" } };
          case "rename":
            return { status: "ok", data: { oldPath: "user/sub/a.txt", newPath: "user/sub/b.txt" } };
          case "zip":
            return { status: "ok", data: Buffer.from("PK\x03\x04remote-zip").toString("base64") };
          default:
            throw new Error(`unexpected operation: ${operation}`);
        }
      },
    );
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendFileOpMock });
    return sendFileOpMock;
  }

  test("九个端点全部经 file-ws 跑通（读操作自动回退语义保留）", async () => {
    // 远程全链路：所有操作经 file-ws 透传并返回统一成功结构；read auto 先文本
    stubRemoteOk();
    const treeRes = await handle("/fs/tree");
    expect(treeRes.status).toBe(200);
    const treeBody = (await treeRes.json()) as { success: boolean; data: { paths: string[] } };
    expect(treeBody.data.paths).toContain("user/a.txt");

    const listRes = await handle("/fs?path=user");
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as {
      success: boolean;
      data: { entries: Array<{ name: string }> };
    };
    expect(listBody.data.entries[0]?.name).toBe("a.txt");

    const readRes = await handle("/fs/user/a.txt");
    expect(readRes.status).toBe(200);
    const readBody = (await readRes.json()) as { success: boolean; data: { content: string } };
    expect(readBody.data.content).toBe("abc");

    const writeRes = await handle("/fs/user/a.txt", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "abc" }),
    });
    expect(writeRes.status).toBe(200);

    const upForm = new FormData();
    upForm.append("files", new File(["up"], "a.txt"));
    const upRes = await handle("/fs/user/sub", { method: "POST", body: upForm });
    expect(upRes.status).toBe(200);
    const upBody = (await upRes.json()) as { success: boolean; data: { files: Array<{ path: string }> } };
    expect(upBody.data.files[0]?.path).toBe("user/sub/a.txt");

    const mkdirRes = await handle("/fs/mkdir", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "user/d" }),
    });
    expect(mkdirRes.status).toBe(200);

    const renameRes = await handle("/fs/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ oldPath: "user/sub/a.txt", newPath: "user/sub/b.txt" }),
    });
    expect(renameRes.status).toBe(200);

    const batchRes = await handle("/fs/batch", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: ["user/sub/a.txt", "user/x.txt"] }),
    });
    expect(batchRes.status).toBe(200);
    const batchBody = (await batchRes.json()) as { success: boolean; data: { deleted: string[] } };
    expect(batchBody.data.deleted).toEqual(["user/sub/a.txt", "user/x.txt"]);

    const delRes = await handle("/fs/user/a.txt", { method: "DELETE" });
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { success: boolean; data: { ok: boolean } };
    expect(delBody.data.ok).toBe(true);
  });

  test("机器端背压 busy → 429 + Retry-After: 1", async () => {
    // W1 背压错误经门面映射 429（瞬时容量问题），响应必须带 Retry-After 头供调用方退避
    stubFileWsHandler({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => {
        throw new BusyError("file-op busy: pending limit reached");
      },
    });
    setConfig({ defaultMachineId: MACHINE_ID });
    const response = await handle("/fs?path=user");
    expect(response.headers.get("Retry-After")).toBe("1");
    await expectError(response, 429, "busy");
  });

  test("配置了 machine 但 file-ws 未连接 → 503 file_service_unavailable", async () => {
    // 拒绝静默回退本地：配了远程机器但未连接时返回 503，不得落本地（错误类型统一，无 remote_error）
    stubFileWsHandler({ isFileWsConnected: () => false });
    setConfig({ defaultMachineId: MACHINE_ID });
    await expectError(await handle("/fs?path=user"), 503, "file_service_unavailable");
  });

  test("download-zip 远程经 file_op zip 流转（W16 补齐）", async () => {
    // W16：远程打包走 file_op "zip" 单帧回传 → 解码为 zip 流响应，HTTP 契约
    // （Content-Type / Content-Disposition / zip 魔数）与本地一致，不再 501
    stubRemoteOk();
    const zipRes = await handle("/fs/download-zip?path=user");
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get("Content-Type")).toBe("application/zip");
    expect(zipRes.headers.get("Content-Disposition")).toContain(".zip");
    expect(
      Buffer.from(await zipRes.arrayBuffer())
        .subarray(0, 2)
        .toString(),
    ).toBe("PK");
  });

  test("远程错误契约与本地一致：400（越界/绝对路径）+ 404（环境不可见）", async () => {
    // 远程场景 400/404 与本地同一断言（门面统一校验与归属检查先于路由决策）
    await expectCommonErrorContract();
  });
});
