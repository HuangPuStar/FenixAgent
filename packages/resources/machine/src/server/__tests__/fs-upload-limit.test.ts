// 上传容量边界：本地和远程均允许恰好 92MB，超限整批拒绝。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stubDb } from "@fenix/platform-sdk/testing";
import { createStubSessionAuthGuardPlugin, resetTestAuth, setTestAuth } from "../../__tests__/guard-stubs";
import { createWebFsRoutes } from "../routes/web/fs";
import { REMOTE_UPLOAD_LIMIT_MESSAGE } from "../services/file-types";
import { remoteUploadFiles } from "../services/remote-file-service";
import {
  initializeMachineModuleConfig,
  lockMachineWorkspaceRoot,
  stubFileWsTransport,
  stubMachineConfig,
  stubMachineEnvironmentRecord,
  unlockMachineWorkspaceRoot,
} from "../testing";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";

const MB = 1024 * 1024;

// 路由实例文件级构造一次：会话守卫替身按请求期读取当前会话（setTestAuth 即时生效）；
// 环境读取与 file-ws 传输经包内句柄替换（stubMachineEnvironmentRecord / stubFileWsTransport）
// 按调用时读取，beforeEach 或用例内注入即可。
const fsRoutes = createWebFsRoutes({ authGuardPlugin: createStubSessionAuthGuardPlugin() });

let workspaceRoot: string;

beforeEach(async () => {
  initializeMachineModuleConfig();
  stubMachineEnvironmentRecord({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID });
  setTestAuth({
    user: { id: USER_ID, email: "user@fenix.com", name: "user" },
    authContext: { organizationId: ORG_ID, userId: USER_ID, role: "owner" },
  });
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-upload-limit-"));
  await lockMachineWorkspaceRoot(workspaceRoot);
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  unlockMachineWorkspaceRoot();
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** 构造 multipart 上传请求：单个 sizeBytes 大小的文件上传到 user/sub */
function uploadRequest(sizeBytes: number, fileName = "big.bin"): Request {
  const formData = new FormData();
  formData.append("files", new File([Buffer.alloc(sizeBytes, 1)], fileName));
  return new Request(`http://localhost/environments/${ENV_ID}/fs/user/sub`, { method: "POST", body: formData });
}

/** workspace 目录（WORKSPACE_ROOT/org/user/env） */
function workspaceDir(): string {
  return join(workspaceRoot, ORG_ID, USER_ID, ENV_ID);
}

describe("本地环境（无 machine 配置）", () => {
  // 同名文件上传返回可供前端 ApiError 分类的409 code，并保留已上传原字节。
  test("上传冲突响应携带 path_conflict code", async () => {
    expect((await fsRoutes.handle(uploadRequest(1, "same.txt"))).status).toBe(200);
    const response = await fsRoutes.handle(uploadRequest(2, "same.txt"));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "path_conflict", type: "path_conflict" } });
    expect(await readFile(join(workspaceDir(), "user/sub/same.txt"))).toEqual(Buffer.alloc(1, 1));
  });

  // 本地恰好 92MB 必须完整落盘，不因 multipart 封装而误拒绝。
  test("本地恰好 92MB 上传成功", async () => {
    const response = await fsRoutes.handle(uploadRequest(92 * MB, "big92.bin"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: { files: Array<{ path: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.files[0]?.path).toBe("user/sub/big92.bin");
    const info = await stat(join(workspaceDir(), "user", "sub", "big92.bin"));
    expect(info.size).toBe(92 * MB);
  });

  // 本地超过 92MB 上限必须 413 payload_too_large（本地 92MB 上限保持）
  test("本地 >92MB 上传被拒（413 payload_too_large）", async () => {
    const response = await fsRoutes.handle(uploadRequest(92 * MB + 1, "huge.bin"));

    expect(response.status).toBe(413);
    expect((await response.json()) as unknown).toEqual({
      error: { type: "payload_too_large", message: REMOTE_UPLOAD_LIMIT_MESSAGE },
    });
    // 超限整批拒绝：workspace 内不得有任何落盘残留
    await expect(stat(join(workspaceDir(), "user", "sub", "huge.bin"))).rejects.toThrow();
  });
});

describe("远程环境（stub file-ws 在线）", () => {
  beforeEach(() => {
    // 远程路由决策需要 machineId 配置 + file-ws 在线 + machine 存在（W6 三分语义）
    stubDb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }),
    });
    stubMachineConfig({ defaultMachineId: MACHINE_ID });
  });

  // 远程 >92MB 上传必须 413 + 用户可读文案（能力回退，破坏性契约变更），且不得向机器端发送任何帧
  test("远程 >92MB 上传 → 413 + 文案断言，不发送 file_op", async () => {
    const sendMock = mock(async () => ({ status: "ok", data: { files: [] } }));
    stubFileWsTransport({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const response = await fsRoutes.handle(uploadRequest(92 * MB + 1, "over.bin"));

    expect(response.status).toBe(413);
    expect((await response.json()) as unknown).toEqual({
      error: { type: "payload_too_large", message: REMOTE_UPLOAD_LIMIT_MESSAGE },
    });
    // 门面在发送前拦截：不构造 ~133MB base64 帧
    expect(sendMock.mock.calls.length).toBe(0);
  });

  // 远程恰好 92MB 属于允许边界（≤92MB 成功），应正常经 file-ws 发送
  test("远程恰好 92MB 上传成功", async () => {
    const sendMock = mock(async () => ({
      status: "ok",
      data: { files: [{ name: "big92.bin", path: "user/sub/big92.bin", size: 92 * MB }] },
    }));
    stubFileWsTransport({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const response = await fsRoutes.handle(uploadRequest(92 * MB, "big92.bin"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: { files: Array<{ path: string }> } };
    expect(body.data.files[0]?.path).toBe("user/sub/big92.bin");
    expect(sendMock.mock.calls.length).toBe(1);
  });
});

describe("remoteUploadFiles 发送前防线（base64 反推原大小）", () => {
  // 两个均未超单文件上限的文件也不能合成超过安全预算的 Base64 消息。
  test("远程多文件总量超过92MB时在发送前拒绝", async () => {
    const sendMock = mock(async () => ({ status: "ok", data: { files: [] } }));
    stubFileWsTransport({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });
    const content = Buffer.alloc(47 * MB).toString("base64");
    await expect(
      remoteUploadFiles(MACHINE_ID, ENV_ID, "user", [
        { name: "a.bin", content, relativePath: "a.bin" },
        { name: "b.bin", content, relativePath: "b.bin" },
      ]),
    ).rejects.toMatchObject({ statusCode: 413, code: "payload_too_large" });
    expect(sendMock).not.toHaveBeenCalled();
  });

  // 防线：base64 反推原文件 >92MB 时必须提前抛 413，不产生 ~133MB 大帧
  test("base64 原文件 >92MB 提前抛 413，不调用 sendFileOpAndWait", async () => {
    const sendMock = mock(async () => ({ status: "ok", data: { files: [] } }));
    stubFileWsTransport({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const over = Buffer.alloc(92 * MB + 1, 1).toString("base64");
    await expect(
      remoteUploadFiles(MACHINE_ID, ENV_ID, "user/sub", [
        { name: "over.bin", content: over, relativePath: "over.bin" },
      ]),
    ).rejects.toMatchObject({
      statusCode: 413,
      code: "payload_too_large",
      message: REMOTE_UPLOAD_LIMIT_MESSAGE,
    });
    expect(sendMock.mock.calls.length).toBe(0);
  });

  // 远程运行时若忽略 dir 并返回根级路径，主服务必须 fail closed，不能把错误引用交给 Chat。
  test("远程上传响应路径与请求目录不一致时拒绝结果", async () => {
    const sendMock = mock(async () => ({
      status: "ok",
      data: { files: [{ name: "a.txt", path: "a.txt", size: 1 }] },
    }));
    stubFileWsTransport({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    await expect(
      remoteUploadFiles(MACHINE_ID, ENV_ID, "user", [
        { name: "a.txt", content: Buffer.from("a").toString("base64"), relativePath: "a.txt" },
      ]),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: "remote_response_invalid",
    });
  });

  // 防线边界：恰好 92MB 原文件（含 padding 的 base64）必须放行并透传发送
  test("恰好 92MB 边界放行并透传发送", async () => {
    const sendMock = mock(async () => ({
      status: "ok",
      data: { files: [{ name: "big92.bin", path: "user/sub/big92.bin", size: 92 * MB }] },
    }));
    stubFileWsTransport({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const exact = Buffer.alloc(92 * MB, 1).toString("base64");
    const result = await remoteUploadFiles(MACHINE_ID, ENV_ID, "user/sub", [
      { name: "big92.bin", content: exact, relativePath: "big92.bin" },
    ]);

    expect(result.files[0]?.path).toBe("user/sub/big92.bin");
    expect(sendMock.mock.calls.length).toBe(1);
  });
});
