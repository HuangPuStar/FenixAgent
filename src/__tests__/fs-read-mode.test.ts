// fs-read-mode.test.ts —— W13' 读 mode 显式（P2-16，D9 读侧）
// GET /fs/* 的 mode 参数（text|binary|auto）：text 失败返回明确错误（404=文件被
// 移动或删除、503=机器断连、其余=暂不支持预览），不再静默回退二进制下载；
// binary 直接流；auto 按扩展名/内容探测并显式标记类型。本地 tmp 目录直连路由。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { resolveWorkspacePath } from "../services/workspace-fs";
import { resetAllStubs, stubEnvironmentRepo } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";

const fsRoutes = await import("../routes/web/fs");

let workspaceRoot: string;

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

function handle(path: string, init?: RequestInit): Promise<Response> {
  return fsRoutes.default.handle(new Request(`http://localhost/environments/${ENV_ID}${path}`, init));
}

/** 写入二进制字节文件（绕过文本 API，构造含 NUL 的真实二进制） */
async function writeBinary(rel: string, bytes: number[]): Promise<void> {
  const resolved = await resolveWorkspacePath(ENV_ID, rel);
  await writeFile(resolved!.resolved, Buffer.from(bytes));
}

beforeEach(async () => {
  resetAllStubs();
  stubEnvironment();
  stubAuth();
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-read-mode-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

describe("mode=text 显式失败语义", () => {
  test("text 模式读二进制文件 → 400 明确错误，非二进制下载", async () => {
    // §7.8：text 探测失败必须显式报错（"该文件不是文本文件，暂不支持预览"），
    // 禁止静默回退成二进制下载——响应必须是 JSON 错误而非文件流
    await writeBinary("user/b.bin", [1, 0, 2, 3]);
    const res = await handle("/fs/user/b.bin?mode=text");
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: { type: "validation_error", message: expect.any(String) },
    });
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  test("text 模式读不存在文件 → 404（文件已被移动或删除）", async () => {
    // 404 分类语义：文件不存在提示"已被移动或删除"，而非笼统 500
    const res = await handle("/fs/user/not-exist.txt?mode=text");
    expect(res.status).toBe(404);
    expect((await res.json()) as unknown).toEqual({
      error: { type: "not_found", message: expect.any(String) },
    });
  });

  test("非法 mode 值 → 400 validation_error", async () => {
    // 模式显式：非法值不猜测语义，明确拒绝
    await writeWorkspaceFile("user/a.txt", "hello");
    const res = await handle("/fs/user/a.txt?mode=blob");
    expect(res.status).toBe(400);
    expect((await res.json()) as unknown).toEqual({
      error: { type: "validation_error", message: expect.any(String) },
    });
  });
});

describe("mode=binary 直接流", () => {
  test("二进制文件直接返回流与下载头，内容字节一致", async () => {
    // binary 模式跳过文本探测：响应为 application/octet-stream 流 +
    // Content-Disposition 下载头 + X-File-Type 显式标记，body 为原始字节
    await writeBinary("user/b.bin", [1, 0, 2, 3, 255]);
    const res = await handle("/fs/user/b.bin?mode=binary");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    expect(res.headers.get("x-file-type")).toBe("binary");
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body]).toEqual([1, 0, 2, 3, 255]);
  });

  test("binary 模式读文本文件同样返回流（不做文本解析）", async () => {
    // binary 是无条件流：即使文件是文本也不返回 JSON，body 为原始字节
    await writeWorkspaceFile("user/a.txt", "hello");
    const res = await handle("/fs/user/a.txt?mode=binary");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-file-type")).toBe("binary");
    const body = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(body).toString("utf-8")).toBe("hello");
  });
});

describe("mode=auto 探测", () => {
  test("文本文件返回 JSON 且显式标记 type=text", async () => {
    // auto 探测文本：JSON 响应带 type:"text"（§7.8 显式标记）
    await writeWorkspaceFile("user/a.txt", "hello fenix");
    const res = await handle("/fs/user/a.txt?mode=auto");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({ content: "hello fenix", type: "text" });
  });

  test("二进制文件（含 NUL）回退流并显式标记 X-File-Type: binary", async () => {
    // auto 探测二进制：无文本扩展名 + 内容含 NUL → binary 流，显式标记而非伪装
    await writeBinary("user/b.bin", [1, 0, 2, 3]);
    const res = await handle("/fs/user/b.bin?mode=auto");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-file-type")).toBe("binary");
    const body = new Uint8Array(await res.arrayBuffer());
    expect([...body]).toEqual([1, 0, 2, 3]);
  });
});

describe("兼容行为（未传 mode）", () => {
  test("未传 mode 默认 auto：文本返回 JSON（历史行为不变）", async () => {
    // 向后兼容：不传 mode 时与现状一致（auto 探测），现有消费者无感
    await writeWorkspaceFile("user/a.txt", "hello");
    const res = await handle("/fs/user/a.txt");
    expect(res.status).toBe(200);
    const json = (await res.json()) as { success: boolean; data: Record<string, unknown> };
    expect(json.data).toMatchObject({ content: "hello", type: "text" });
  });

  test("preview=true 兼容：直接返回流（预览语义）", async () => {
    // preview 参数保留（旧前端预览 URL）：文本文件也返回流 + 内容类型，而非 JSON
    await writeWorkspaceFile("user/a.txt", "hello");
    const res = await handle("/fs/user/a.txt?preview=true");
    expect(res.status).toBe(200);
    expect(res.headers.get("x-file-type")).toBe("binary");
    expect(res.headers.get("content-type")).toBe("text/plain");
  });
});
