import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

// 动态 import 路由模块。environmentRepo 的 mock 是实时 Proxy（setup-mocks.ts），
// 属性访问总是转发到当前 stub，因此无需在 import 前设置，beforeEach 注入即可。
const fsRoutes = await import("../routes/web/fs");

let workspaceRoot: string;

beforeEach(async () => {
  // resetAllStubs 清除共享 stub（防其他测试文件残留干扰），随后重新注入本测试的环境记录；
  // 必须在每个用例前设置：全量运行时其他测试文件的 beforeEach 也会调用 resetAllStubs，
  // 共享的 _environmentRepoStub 可能被清空，不能只在模块顶层设置一次。
  resetAllStubs();
  stubEnvironmentRepo({
    getById: async () => ({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID }),
  });
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-upload-escape-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setTestAuth({
    user: { id: USER_ID, email: "user@fenix.com", name: "user" },
    authContext: { organizationId: ORG_ID, userId: USER_ID, role: "owner" },
  });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** 构造 multipart 上传请求：一个文件 + 可选 relativePaths 数组（fileName 可伪造 multipart filename）。
 *  目标目录 user/sub：W6 作用域校验强制相对路径落在 user/ 前缀内，越界用例（../）仍被整批拒绝。 */
function buildUploadRequest(relativePaths?: string[], fileName = "evil.txt"): Request {
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

/** 断言路径不存在 */
async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toThrow();
}

describe("本地 upload relativePath 越界修复（D16）", () => {
  // 携带 ".." 段的 relativePath 必须整批返回 400，且 workspace 外不得有任何文件落盘。
  test("rejects '..' escape and leaves no file outside workspace", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(["../../evil.txt"]));

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: {
        type: "validation_error",
        message: expect.stringContaining("relativePath"),
      },
    });
    // env 目录之外（user-1 目录下）不得出现逃逸写入的文件
    await expectMissing(join(workspaceRoot, ORG_ID, USER_ID, "evil.txt"));
    // workspace 内也不应有任何残留（整批拒绝，不落盘）
    await expectMissing(join(workspaceDir(), "user", "sub", "evil.txt"));
  });

  // 绝对路径同样属于越界输入，必须整批拒绝。
  test("rejects absolute relativePath", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(["/etc/passwd"]));

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: {
        type: "validation_error",
        message: expect.stringContaining("relativePath"),
      },
    });
  });

  // NUL 与控制字符不可出现在路径中，必须整批拒绝。
  test("rejects NUL and control characters", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(["a\u0000b.txt", "c\u001fd.txt"]));

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: {
        type: "validation_error",
        message: expect.stringContaining("relativePath"),
      },
    });
  });

  // 混合批次中只要有一个非法路径，整批拒绝，合法项也不得落盘。
  test("rejects whole batch when any path is invalid", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(["ok.txt", "../evil.txt"]));

    expect(response.status).toBe(400);
    // 合法项 ok.txt 也不得落盘（保持整批原子性）
    await expectMissing(join(workspaceDir(), "user", "sub", "ok.txt"));
  });

  // 正常相对路径（含目录层级与空格 trim 语义）应照常上传成功，落盘在 workspace 内。
  test("uploads normal relative path successfully", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(["folder/  note.txt"]));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      success: boolean;
      data: { files: Array<{ name: string; path: string }> };
    };
    expect(body.success).toBe(true);
    expect(body.data.files[0]?.path).toBe("user/sub/folder/  note.txt");
    expect(await readFile(join(workspaceDir(), "user", "sub", "folder", "  note.txt"), "utf-8")).toBe("evil");
  });

  // 未提供 relativePaths 时回退 file.name，既有上传行为不受影响。
  test("falls back to file name when relativePaths is empty", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(undefined, "plain.txt"));

    expect(response.status).toBe(200);
    expect(await readFile(join(workspaceDir(), "user", "sub", "plain.txt"), "utf-8")).toBe("evil");
  });

  // file.name 本身也是不可信输入：multipart filename 可伪造 ../ 段，回退路径同样禁止越界。
  test("rejects '..' escape via file.name fallback", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(undefined, "../../evil.txt"));

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: {
        type: "validation_error",
        message: expect.stringContaining("file name"),
      },
    });
    // env 目录之外（user-1 目录下）不得出现逃逸写入的文件
    await expectMissing(join(workspaceRoot, ORG_ID, USER_ID, "evil.txt"));
    // workspace 内也不应有任何残留（整批拒绝，不落盘）
    await expectMissing(join(workspaceDir(), "user", "sub", "evil.txt"));
  });

  // 反斜杠同样视为路径分隔符（防御 Windows 客户端路径），`..` 段一律拒绝。
  test("rejects '..' segments with backslash separators", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(["..\\..\\evil.txt"]));

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: {
        type: "validation_error",
        message: expect.stringContaining("relativePath"),
      },
    });
  });

  // relativePaths 是合法 JSON 但非数组（如 "null"）时视为未提供，回退 file.name 正常上传，不得 500。
  test("treats non-array relativePaths JSON as absent", async () => {
    const formData = new FormData();
    formData.append("files", new File(["evil"], "plain.txt"));
    formData.append("relativePaths", "null");
    const response = await fsRoutes.default.handle(
      new Request(`http://localhost/environments/${ENV_ID}/fs/user/sub`, {
        method: "POST",
        body: formData,
      }),
    );

    expect(response.status).toBe(200);
    expect(await readFile(join(workspaceDir(), "user", "sub", "plain.txt"), "utf-8")).toBe("evil");
  });

  // 空文件名无内容可写（回退链末端），必须整批拒绝而不是落到目录写入报 500。
  test("rejects empty file name", async () => {
    const response = await fsRoutes.default.handle(buildUploadRequest(undefined, ""));

    expect(response.status).toBe(400);
    expect((await response.json()) as unknown).toEqual({
      error: {
        type: "validation_error",
        message: expect.stringContaining("file name"),
      },
    });
  });
});
