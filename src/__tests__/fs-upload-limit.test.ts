// fs-upload-limit.test.ts —— W8b（P1-11b）upload 能力上限验证（D8 载荷治理 HTTP 侧）
// 能力上限不对称（§2.4/§7.6）：本地 100MB / 远程 20MB；远程 >20MB 从可上传变 413
// payload_too_large 是破坏性契约变更，必须携带用户可读文案。覆盖：
// 本地 100MB 上限保持（20MB 成功、>100MB 413）；远程 >20MB → 413 + 文案断言；
// 远程恰好 20MB 边界成功；remoteUploadFiles 发送前防线（base64 反推原大小提前抛错，
// 不构造 ~27MB 大帧后才被 W8a 32MB 载荷兜底）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { REMOTE_UPLOAD_LIMIT_MESSAGE } from "../services/file-types";
import { remoteUploadFiles } from "../services/remote-file-service";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubFileWsHandler } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";

const MB = 1024 * 1024;

// 动态 import 路由模块。environmentRepo / file-ws-handler 的 mock 是实时转发
// （setup-mocks.ts），属性访问总是转发到当前 stub，beforeEach 注入即可。
const fsRoutes = await import("../routes/web/fs");

let workspaceRoot: string;

beforeEach(async () => {
  resetAllStubs();
  stubEnvironmentRepo({
    getById: async () => ({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID }),
  });
  setTestAuth({
    user: { id: USER_ID, email: "user@fenix.com", name: "user" },
    authContext: { organizationId: ORG_ID, userId: USER_ID, role: "owner" },
  });
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-upload-limit-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
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
  // 本地 upload 100MB 上限保持：20MB 文件应成功上传落盘（不受远程 20MB 限制影响）
  test("本地 20MB 上传成功", async () => {
    const response = await fsRoutes.default.handle(uploadRequest(20 * MB, "big20.bin"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: { files: Array<{ path: string }> } };
    expect(body.success).toBe(true);
    expect(body.data.files[0]?.path).toBe("user/sub/big20.bin");
    const info = await stat(join(workspaceDir(), "user", "sub", "big20.bin"));
    expect(info.size).toBe(20 * MB);
  });

  // 本地超过 100MB 上限必须 413 payload_too_large（本地 100MB 上限保持）
  test("本地 >100MB 上传被拒（413 payload_too_large）", async () => {
    const response = await fsRoutes.default.handle(uploadRequest(100 * MB + 1, "huge.bin"));

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
    setConfig({ defaultMachineId: MACHINE_ID });
  });

  // 远程 >20MB 上传必须 413 + 用户可读文案（能力回退，破坏性契约变更），且不得向机器端发送任何帧
  test("远程 >20MB 上传 → 413 + 文案断言，不发送 file_op", async () => {
    const sendMock = mock(async () => ({ status: "ok", data: { files: [] } }));
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const response = await fsRoutes.default.handle(uploadRequest(20 * MB + 1, "over.bin"));

    expect(response.status).toBe(413);
    expect((await response.json()) as unknown).toEqual({
      error: { type: "payload_too_large", message: REMOTE_UPLOAD_LIMIT_MESSAGE },
    });
    // 门面在发送前拦截：不构造 ~27MB base64 帧
    expect(sendMock.mock.calls.length).toBe(0);
  });

  // 远程恰好 20MB 属于允许边界（≤20MB 成功），应正常经 file-ws 发送
  test("远程恰好 20MB 上传成功", async () => {
    const sendMock = mock(async () => ({
      status: "ok",
      data: { files: [{ name: "big20.bin", path: "user/sub/big20.bin", size: 20 * MB }] },
    }));
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const response = await fsRoutes.default.handle(uploadRequest(20 * MB, "big20.bin"));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { success: boolean; data: { files: Array<{ path: string }> } };
    expect(body.data.files[0]?.path).toBe("user/sub/big20.bin");
    expect(sendMock.mock.calls.length).toBe(1);
  });
});

describe("remoteUploadFiles 发送前防线（base64 反推原大小）", () => {
  // 防线：base64 反推原文件 >20MB 时必须提前抛 413，不产生 ~27MB 大帧
  test("base64 原文件 >20MB 提前抛 413，不调用 sendFileOpAndWait", async () => {
    const sendMock = mock(async () => ({ status: "ok", data: { files: [] } }));
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const over = Buffer.alloc(20 * MB + 1, 1).toString("base64");
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

  // 防线边界：恰好 20MB 原文件（含 padding 的 base64）必须放行并透传发送
  test("恰好 20MB 边界放行并透传发送", async () => {
    const sendMock = mock(async () => ({
      status: "ok",
      data: { files: [{ name: "big20.bin", path: "user/sub/big20.bin", size: 20 * MB }] },
    }));
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const exact = Buffer.alloc(20 * MB, 1).toString("base64");
    const result = await remoteUploadFiles(MACHINE_ID, ENV_ID, "user/sub", [
      { name: "big20.bin", content: exact, relativePath: "big20.bin" },
    ]);

    expect(result.files[0]?.path).toBe("user/sub/big20.bin");
    expect(sendMock.mock.calls.length).toBe(1);
  });
});
