import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setConfig } from "../config";
import { gate } from "../services/agent-file-service";
import {
  type FileAuthContext,
  type FileServiceError,
  LOCAL_UPLOAD_MAX_BYTES,
  REMOTE_UPLOAD_MAX_BYTES,
  type ReadResult,
  type UploadFileInput,
} from "../services/file-types";
import { resetAllStubs, stubDb, stubEnvironmentRepo, stubFileWsHandler } from "../test-utils/helpers";
import { BusyError } from "../transport/file-ws-requests";

const ORG_ID = "org-1";
const USER_ID = "user-1";
const ENV_ID = "env-1";
const MACHINE_ID = "mach_1";

const authCtx: FileAuthContext = {
  organizationId: ORG_ID,
  userId: USER_ID,
  role: "owner",
  actorId: USER_ID,
  source: "user",
};

let workspaceRoot: string;

/** 收集 ReadableStream 全部数据（断言流式结果用） */
async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk as Uint8Array);
  return Buffer.concat(chunks);
}

/** 构造上传输入（content 为原始字节，本地直接落盘 / 远程 base64 化） */
function uploadFile(name: string, content: string, relativePath?: string): UploadFileInput {
  return { name, content: Buffer.from(content), relativePath };
}

beforeEach(async () => {
  // 每个用例重建干净环境：stub 环境归属 + 独立 tmp workspace 根目录 + 本地路由
  resetAllStubs();
  stubEnvironmentRepo({
    getById: async () => ({ id: ENV_ID, organizationId: ORG_ID, userId: USER_ID }),
  });
  workspaceRoot = await mkdtemp(join(tmpdir(), "agent-file-service-"));
  process.env.WORKSPACE_ROOT = workspaceRoot;
  setConfig({ defaultMachineId: undefined });
});

afterEach(async () => {
  delete process.env.WORKSPACE_ROOT;
  await rm(workspaceRoot, { recursive: true, force: true });
  setConfig({ defaultMachineId: undefined });
});

describe("本地 LocalBackend（真实 tmp 目录）", () => {
  test("write 后 read（text 模式）往返一致，路径带 user/ 作用域", async () => {
    // 本地写读往返：写入内容应原样读回，返回路径为 displayPath（user/ 前缀）
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/hello.txt", "你好 fenix");
    const result = await fs.read("user/hello.txt", "text");
    expect(result).toMatchObject({ type: "text", content: "你好 fenix", encoding: "utf-8" });
  });

  test("list 返回目录条目且过滤隐藏文件", async () => {
    // 列目录：写入文件后应出现在条目中；.git 黑名单目录不应出现
    const fs = gate(ENV_ID, authCtx);
    await fs.mkdir("user/d1");
    await fs.write("user/d1/a.txt", "a");
    await fs.mkdir("user/d1/.git");
    const entries = await fs.list("user/d1");
    expect(entries.map((e) => e.name)).toEqual(["a.txt"]);
  });

  test("tree 递归返回全量路径与 mtime", async () => {
    // 递归树：写入嵌套文件后 tree 应包含其路径，且 mtime 已记录
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/nested/deep.txt", "deep");
    const result = await fs.tree();
    expect(result.paths).toContain("user/nested/deep.txt");
    expect(result.mtimes?.["user/nested/deep.txt"]).toBeGreaterThan(0);
  });

  test("stat 返回文件大小/目录标记/文本探测", async () => {
    // stat：文件应标记 isDirectory=false 且 isText=true；目录相反
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/s.txt", "hello");
    const fileStat = await fs.stat("user/s.txt");
    expect(fileStat).toMatchObject({ size: 5, isDirectory: false, isText: true });
    await fs.mkdir("user/dir1");
    const dirStat = await fs.stat("user/dir1");
    expect(dirStat.isDirectory).toBe(true);
  });

  test("read auto 模式：文本按 text 返回，含 NUL 字节按 binary 返回", async () => {
    // auto 探测：扩展名/内容探测决定返回 text 还是 binary，与现状 fs.ts 语义一致
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/t.txt", "plain text");
    const textResult = await fs.read("user/t.txt", "auto");
    expect(textResult).toMatchObject({ type: "text" });
    const { writeFile } = await import("node:fs/promises");
    const { resolveWorkspacePath } = await import("../services/workspace-fs");
    const resolved = await resolveWorkspacePath(ENV_ID, "user/b.bin");
    await writeFile(resolved!.resolved, Buffer.from([1, 0, 2, 3]));
    const binResult = await fs.read("user/b.bin", "auto");
    expect(binResult.type).toBe("binary");
    if (binResult.type === "binary") {
      expect(binResult.mimeType).toBe("application/octet-stream");
      expect((await collectStream(binResult.stream)).length).toBe(4);
    }
  });

  test("mkdir 创建目录并可重复创建（幂等）", async () => {
    // mkdir 应递归创建且幂等（mkdir -p 语义）
    const fs = gate(ENV_ID, authCtx);
    await fs.mkdir("user/a/b/c");
    await fs.mkdir("user/a/b/c");
    const info = await stat(join(workspaceRoot, ORG_ID, USER_ID, ENV_ID, "user", "a", "b", "c"));
    expect(info.isDirectory()).toBe(true);
  });

  test("rename 移动文件，旧路径不可再访问", async () => {
    // 重命名：移动后新路径可读、旧路径 404
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/a.txt", "mv");
    await fs.rename("user/a.txt", "user/sub/b.txt");
    expect((await fs.read("user/sub/b.txt", "text")).type).toBe("text");
    await expect(fs.read("user/a.txt", "text")).rejects.toMatchObject({ type: "not_found", statusCode: 404 });
  });

  test("delete 删除文件与目录（目录递归删除）", async () => {
    // 删除：文件与目录（含递归内容）删除后 stat 404
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/f.txt", "x");
    await fs.delete("user/f.txt");
    await expect(fs.stat("user/f.txt")).rejects.toMatchObject({ type: "not_found" });
    await fs.write("user/del/x.txt", "x");
    await fs.delete("user/del");
    await expect(fs.stat("user/del")).rejects.toMatchObject({ type: "not_found" });
  });

  test("upload 落盘并保留 relativePath 目录结构", async () => {
    // 上传：relativePath 应保留目录层级写入 workspace 内
    const fs = gate(ENV_ID, authCtx);
    const result = await fs.upload("user/sub", [uploadFile("a.txt", "hello", "nested/b.txt")]);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("user/sub/nested/b.txt");
    const content = await readFile(
      join(workspaceRoot, ORG_ID, USER_ID, ENV_ID, "user", "sub", "nested", "b.txt"),
      "utf-8",
    );
    expect(content).toBe("hello");
  });

  test("upload 拒绝 ../ 逃逸路径且不落盘（W2 修复随迁）", async () => {
    // D16 逃逸修复：../ relativePath 整批拒绝 400，workspace 外不得落盘
    const fs = gate(ENV_ID, authCtx);
    await expect(
      fs.upload("user/sub", [uploadFile("ok.txt", "x"), uploadFile("evil.txt", "y", "../../evil.txt")]),
    ).rejects.toMatchObject({ type: "validation_error", statusCode: 400 });
    await expect(stat(join(workspaceRoot, ORG_ID, USER_ID, "evil.txt"))).rejects.toThrow();
  });

  test("downloadZip 流式返回 zip 数据流（PK 头）", async () => {
    // 打包下载：系统 zip 流式输出应包含 zip 魔数，且不加载进内存
    const fs = gate(ENV_ID, authCtx);
    await fs.write("user/zip/z.txt", "zip me");
    const stream = await fs.downloadZip("user/zip");
    const buffer = await collectStream(stream);
    expect(buffer.subarray(0, 2).toString()).toBe("PK");
  });

  test("不存在的文件 read 抛 404 not_found", async () => {
    // 缺失文件：本地 read 应映射 404 而非 500
    const fs = gate(ENV_ID, authCtx);
    await expect(fs.read("user/missing.txt", "text")).rejects.toMatchObject({ type: "not_found", statusCode: 404 });
  });
});

describe("远程 RemoteBackend（stub file-ws）", () => {
  /** machine 表存在性 stub（W6 三分语义：远程路由决策前置校验先查 DB machine 表） */
  function stubMachineExists() {
    stubDb({
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: MACHINE_ID }] }) }) }),
    });
  }

  /** 按操作返回机器端结果的 stub；断言调用参数时可用 sendFileOpMock */
  function stubConnectedRemote() {
    const sendFileOpMock = mock(
      async (
        _machineId: string,
        operation: string,
        _params: Record<string, unknown> = {},
      ): Promise<{ status: string; data?: unknown; error?: string }> => {
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
          case "read_binary":
            return {
              status: "ok",
              data: {
                name: "a.bin",
                path: "user/a.bin",
                data: Buffer.from("abc").toString("base64"),
                size: 3,
                mimeType: "application/octet-stream",
              },
            };
          case "write":
            return { status: "ok", data: { name: "a.txt", path: "user/a.txt", size: 3 } };
          case "upload":
            return { status: "ok", data: { files: [{ name: "a.txt", path: "user/a.txt", size: 3 }] } };
          case "delete":
            return { status: "ok", data: { ok: true } };
          case "mkdir":
            return { status: "ok", data: { path: "user/d" } };
          case "rename":
            return { status: "ok", data: { oldPath: "user/a", newPath: "user/b" } };
          case "stat":
            return { status: "ok", data: { size: 3, isDirectory: false, modifiedAt: 1 } };
          case "zip":
            return { status: "ok", data: Buffer.from("PK\x03\x04remote-zip").toString("base64") };
          default:
            throw new Error(`unexpected operation: ${operation}`);
        }
      },
    );
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendFileOpMock });
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineExists();
    return sendFileOpMock;
  }

  test("十个操作全部跑通且 environmentId 由服务端注入", async () => {
    // 远程十操作：每个操作应经 file-ws 透传，且 params 含服务端注入的 environmentId
    const sendFileOpMock = stubConnectedRemote();
    const fs = gate(ENV_ID, authCtx);
    const tree = await fs.tree();
    expect(tree.paths).toContain("user/a.txt");
    expect((await fs.list("user")).length).toBe(1);
    expect((await fs.read("user/a.txt", "text")).type).toBe("text");
    const bin = (await fs.read("user/a.bin", "binary")) as Extract<ReadResult, { type: "binary" }>;
    expect((await collectStream(bin.stream)).toString()).toBe("abc");
    await fs.write("user/a.txt", "abc");
    await fs.upload("user", [uploadFile("a.txt", "abc")]);
    await fs.delete("user/a.txt");
    await fs.mkdir("user/d");
    await fs.rename("user/a", "user/b");
    const info = await fs.stat("user/a.txt");
    expect(info.size).toBe(3);
    // W16：远程 downloadZip 经 file_op "zip" 单帧回传并解码为 zip 流（PK 头）
    const zipStream = await fs.downloadZip("user");
    expect((await collectStream(zipStream)).subarray(0, 2).toString()).toBe("PK");
    const writeCall = sendFileOpMock.mock.calls.find(([, operation]) => operation === "write");
    expect(writeCall?.[2]).toMatchObject({ environmentId: ENV_ID });
  });

  test("auto 模式文本失败回退二进制", async () => {
    // 远程 auto：text 操作失败（机器端不支持预览）应回退 read_binary，与现状 fs.ts 语义一致
    const sendFileOpMock = mock(async (_machineId: string, operation: string) => {
      if (operation === "read") return { status: "error", error: "cannot preview" };
      return {
        status: "ok",
        data: {
          name: "a.bin",
          path: "user/a.bin",
          data: Buffer.from("x").toString("base64"),
          size: 1,
          mimeType: "application/octet-stream",
        },
      };
    });
    stubFileWsHandler({ isFileWsConnected: () => true, sendFileOpAndWait: sendFileOpMock });
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineExists();
    const result = await gate(ENV_ID, authCtx).read("user/a.bin", "auto");
    expect(result.type).toBe("binary");
  });

  test("配置了 machine 但 file-ws 未连接 → 503 file_service_unavailable", async () => {
    // 拒绝静默回退：配了远程机器但未连接时所有操作 503，不得落本地
    stubFileWsHandler({ isFileWsConnected: () => false });
    setConfig({ defaultMachineId: MACHINE_ID });
    await expect(gate(ENV_ID, authCtx).list("user")).rejects.toMatchObject({
      type: "file_service_unavailable",
      statusCode: 503,
    });
  });

  test("机器端背压 busy → 429 busy", async () => {
    // W1 背压错误类型应映射 429（瞬时容量问题，不得映射 503）
    stubFileWsHandler({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => {
        throw new BusyError("file-op busy: pending limit reached");
      },
    });
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineExists();
    await expect(gate(ENV_ID, authCtx).list("user")).rejects.toMatchObject({ type: "busy", statusCode: 429 });
  });

  test("机器端执行错误 → 503 且 message 不泄露机器细节", async () => {
    // 机器端 status:error 应映射 503，message 为模板化文案（机器内部错误只进日志）
    stubFileWsHandler({
      isFileWsConnected: () => true,
      sendFileOpAndWait: async () => ({ status: "error", error: "EACCES: /mnt/internal/secret-path" }),
    });
    setConfig({ defaultMachineId: MACHINE_ID });
    stubMachineExists();
    const err = (await gate(ENV_ID, authCtx)
      .list("user")
      .catch((e) => e)) as FileServiceError;
    expect(err.type).toBe("file_service_unavailable");
    expect(err.statusCode).toBe(503);
    expect(err.message).not.toContain("secret-path");
  });
});

describe("门面统一错误映射与能力常量", () => {
  test("环境不可见（无归属）→ 404 not_found", async () => {
    // 归属校验：环境不存在或不属于该组织时映射 404（与 403 角色错误区分，W17 启用）
    stubEnvironmentRepo({ getById: async () => null });
    await expect(gate(ENV_ID, authCtx).list("user")).rejects.toMatchObject({ type: "not_found", statusCode: 404 });
  });

  test("非法路径（绝对路径 / ../）→ 400 validation_error", async () => {
    // 统一前置校验：绝对路径与 .. 段在进入 backend 前被拒，本地与远程一致
    const fs = gate(ENV_ID, authCtx);
    await expect(fs.read("/etc/passwd", "text")).rejects.toMatchObject({ type: "validation_error", statusCode: 400 });
    await expect(fs.read("user/../secret.txt", "text")).rejects.toMatchObject({
      type: "validation_error",
      statusCode: 400,
    });
  });

  test("能力上限常量：本地 100MB / 远程 20MB", async () => {
    // 能力不对称条款：常量声明即契约（W8b 据此实施检查）
    expect(LOCAL_UPLOAD_MAX_BYTES).toBe(100 * 1024 * 1024);
    expect(REMOTE_UPLOAD_MAX_BYTES).toBe(20 * 1024 * 1024);
  });
});
