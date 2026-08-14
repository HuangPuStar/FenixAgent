// fs-zip-remote.test.ts —— W16（P1-7 zip 远程补齐）验证
// download-zip 远程 501 → 可用：file_op "zip" 单帧回传（base64）→ 服务端解码后流式转发
// （Content-Type / Content-Disposition 由路由设置，与本地同一 HTTP 契约）；>20MB →
// 413 + "建议选择子目录"（不截断，能力上限不对称 §2.4/§7.6）；机器端 zip 未实现
// （status:"error"）→ 503 明确错误路径（外部依赖未上线前不得静默回退）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { resetTestAuth, setTestAuth } from "../plugins/auth";
import { REMOTE_ZIP_LIMIT_MESSAGE } from "../services/remote-file-service";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubFileWsHandler } from "../test-utils/helpers";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";

const MB = 1024 * 1024;
// 单帧过渡版 zip 超时：60s + 20MB 上限 / 2MB/s 预算（remoteZip 契约，测试断言锁定）
const REMOTE_ZIP_TIMEOUT_MS = 70_000;

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
  workspaceRoot = await mkdtemp(join(tmpdir(), "fs-zip-remote-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  resetTestAuth();
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

/** 远程 download-zip 请求（path 相对路径，W6 作用域校验落在 user/ 内） */
function zipRequest(path: string): Request {
  return new Request(`http://localhost/environments/${ENV_ID}/fs/download-zip?path=${encodeURIComponent(path)}`);
}

describe("远程环境（stub file-ws 在线）", () => {
  beforeEach(() => {
    // 远程路由决策前置：machine 存在（W6 三分语义，machine 表存在性校验先于连接检查）
    stubDb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }),
    });
    setConfig({ defaultMachineId: MACHINE_ID });
  });

  test("zip 单帧回传 → 200 流式转发 + 头正确 + 内容一致", async () => {
    // W16 契约：download-zip 远程经 file_op "zip"（params 含 path + 服务端注入的
    // environmentId，超时按 20MB 上限派生 70s）单帧回传，解码后作为 zip 流响应，
    // 浏览器收到的字节与机器端打包结果完全一致
    const zipBytes = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x01]);
    const sendMock = mock(
      async (_machineId: string, operation: string, params: Record<string, unknown>, timeoutMs: number) => {
        expect(operation).toBe("zip");
        expect(params).toEqual({ path: "user", environmentId: ENV_ID });
        expect(timeoutMs).toBe(REMOTE_ZIP_TIMEOUT_MS);
        return { status: "ok", data: zipBytes.toString("base64") };
      },
    );
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendMock });

    const response = await fsRoutes.default.handle(zipRequest("user"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("application/zip");
    expect(response.headers.get("Content-Disposition")).toContain(".zip");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(zipBytes);
  });

  test(">20MB 单帧 → 413 + 建议选择子目录，不截断", async () => {
    // 单帧受 W8a 32MB WS 载荷约束（20MB 原数据 ≈ 27MB base64 帧）；超限必须明确 413
    // 并携带"建议选择子目录"用户可读文案，不得静默截断返回部分 zip（不完整包对消费者
    // 比失败更糟）
    const oversized = Buffer.alloc(20 * MB + 1, 7).toString("base64");
    stubFileWsHandler({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => ({ status: "ok", data: oversized }),
    });

    const response = await fsRoutes.default.handle(zipRequest("user"));

    expect(response.status).toBe(413);
    expect((await response.json()) as unknown).toEqual({
      error: { type: "payload_too_large", message: REMOTE_ZIP_LIMIT_MESSAGE },
    });
  });

  test("恰好 20MB 边界成功转发", async () => {
    // 边界语义：>20MB 拒绝、恰好 20MB 允许（与 upload 上限判断同构，base64 反推含 padding）
    const zipBytes = Buffer.alloc(20 * MB, 7);
    stubFileWsHandler({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => ({ status: "ok", data: zipBytes.toString("base64") }),
    });

    const response = await fsRoutes.default.handle(zipRequest("user"));

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).length).toBe(20 * MB);
  });

  test("机器端 zip 未实现（status error）→ 503 明确错误", async () => {
    // 机器端 zip 操作未上线（外部依赖未完成）：status:"error" 必须映射 503
    // file_service_unavailable 明确错误路径，不得静默回退本地或返回成功
    stubFileWsHandler({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => ({ status: "error", error: "zip not implemented" }),
    });

    const response = await fsRoutes.default.handle(zipRequest("user"));

    expect(response.status).toBe(503);
    expect((await response.json()) as unknown).toEqual({
      error: { type: "file_service_unavailable", message: expect.any(String) },
    });
  });
});
