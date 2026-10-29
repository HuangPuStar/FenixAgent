import { describe, expect, test } from "bun:test";
import { CloudDriveError, notConfiguredError } from "../server/client/cloud-drive-error";
import type { CloudDriveGateway } from "../server/client/cloud-drive-gateway";
import { createCloudDriveFacade } from "../server/facades/cloud-drive-facade";
import {
  CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES,
  CLOUD_DRIVE_MCP_WRITE_TEXT_MAX_BYTES,
  type CloudDriveMcpTool,
} from "../server/mcp/tool-support";
import { selectCloudDriveTools } from "../server/mcp/tools";
import { fakeGateway, makeFile, makeMutation, makeSearchHit, makeUpload } from "./cloud-drive-fixtures";

const USER_A = { userId: "user-a" };

function toolsFor(scope: "read" | "write") {
  return selectCloudDriveTools(scope);
}

function findTool(scope: "read" | "write", name: string): CloudDriveMcpTool {
  const tool = toolsFor(scope).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`工具不存在：${name}`);
  return tool;
}

function context(gateway: CloudDriveGateway) {
  return {
    actor: USER_A,
    facade: createCloudDriveFacade({ resolveGateway: () => gateway }),
  };
}

/** 取出工具结果的 JSON 文本，便于断言模型实际看到的内容。 */
function text(outcome: { result: { content: Array<{ text: string }> } }): string {
  return outcome.result.content[0]?.text ?? "";
}

describe("CloudDrive MCP 工具面", () => {
  // 只读 token 的列表里不能出现任何写工具：这是 scope 过滤的唯一权威实现。
  test("read scope 只暴露 7 个只读工具", () => {
    const names = toolsFor("read").map((tool) => tool.name);

    expect(names).toEqual([
      "cloud_drive_me",
      "cloud_drive_list",
      "cloud_drive_stat",
      "cloud_drive_search",
      "cloud_drive_read_markdown",
      "cloud_drive_versions",
      "cloud_drive_trash_list",
    ]);
    expect(toolsFor("write").map((tool) => tool.name)).toEqual([
      ...names,
      "cloud_drive_mkdir",
      "cloud_drive_write_text",
      "cloud_drive_move",
      "cloud_drive_rename",
    ]);
  });

  // 主体只能来自 token：工具参数里的 uid 字段必须被拒绝，且不触达网关。
  test("越权字段 uid 被拒绝且不调用网关", async () => {
    let called = false;
    const gateway = fakeGateway({
      listFiles: async () => {
        called = true;
        return { items: [], nextCursor: null };
      },
    });

    const outcome = await findTool("read", "cloud_drive_list").run(context(gateway), { uid: "user-b" });

    expect(called).toBe(false);
    expect(outcome.result.isError).toBe(true);
    expect(outcome.errorCode).toBe("INVALID_ARGUMENT");
    expect(text(outcome)).toContain('"fields":["uid"]');
  });

  // actor 必须原样成为 CloudDrive subject；跨用户隔离的最后一环在这里。
  test("工具使用 token 派生主体作为 CloudDrive subject", async () => {
    const subjects: string[] = [];
    const gateway = fakeGateway({
      listFiles: async (subject) => {
        subjects.push(subject);
        return { items: [makeFile()], nextCursor: null };
      },
    });

    const outcome = await findTool("read", "cloud_drive_list").run(context(gateway), {});

    expect(subjects).toEqual(["user-a"]);
    expect(outcome.result.isError).toBeUndefined();
  });

  // 读结果超过 64KiB 时必须截断、保留游标，并明确告诉模型结果不完整。
  test("markdown 结果超过 64KiB 时截断并保留游标", async () => {
    const content = "a".repeat(CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES + 10_000);
    const gateway = fakeGateway({
      getFile: async () => makeFile(),
      getMarkdown: async () => ({
        content,
        nextCursor: "cursor-2",
        versionId: "version-1",
        conversionStatus: "ready",
        truncated: false,
      }),
    });

    const outcome = await findTool("read", "cloud_drive_read_markdown").run(context(gateway), { file_id: "file-1" });
    const payload = outcome.result.structuredContent as { content: string; truncated: boolean; nextCursor: string };

    expect(new TextEncoder().encode(text(outcome)).byteLength).toBeLessThanOrEqual(CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES);
    expect(payload.truncated).toBe(true);
    expect(payload.nextCursor).toBe("cursor-2");
    expect(payload.content.length).toBeLessThan(content.length);
  });

  // 列表类结果超限时按条目截断，保持 JSON 可解析。
  test("搜索列表超限时按条目截断", async () => {
    const longName = `${"file".repeat(100)}.txt`;
    const gateway = fakeGateway({
      getFile: async () => makeFile({ name: longName, path: `/${longName}` }),
      search: async () => ({
        items: Array.from({ length: 50 }, (_, index) =>
          makeSearchHit({
            fileId: `file-${index}`,
            path: `/${longName}`,
            snippet: `${"x".repeat(400)} keyword ${"y".repeat(400)}`,
          }),
        ),
        nextCursor: "next",
      }),
    });

    const outcome = await findTool("read", "cloud_drive_search").run(context(gateway), { query: "keyword", limit: 50 });
    const payload = outcome.result.structuredContent as { items: unknown[]; truncated: boolean; nextCursor: string };

    expect(new TextEncoder().encode(text(outcome)).byteLength).toBeLessThanOrEqual(CLOUD_DRIVE_MCP_RESULT_LIMIT_BYTES);
    expect(payload.truncated).toBe(true);
    expect(payload.items.length).toBeLessThan(50);
    expect(payload.nextCursor).toBe("next");
  });

  // 上游失败只映射成稳定 code 与固定文案，不把上游 message/URL/密钥带出去。
  test("错误映射稳定且不泄漏上游细节", async () => {
    const cases: Array<[CloudDriveError, string]> = [
      [
        new CloudDriveError("not-found", "NOT_FOUND", "upstream says file-1 missing at http://drive.localhost"),
        "NOT_FOUND",
      ],
      [new CloudDriveError("conflict", "VERSION_CONFLICT", "conflict detail"), "CONFLICT"],
      [new CloudDriveError("rate-limited", "RATE_LIMITED", "slow down"), "RATE_LIMITED"],
      [new CloudDriveError("unavailable", "CLOUD_DRIVE_TIMEOUT", "timeout"), "UNAVAILABLE"],
      [new CloudDriveError("invalid", "INVALID_ARGUMENT", "bad"), "INVALID_ARGUMENT"],
      [new CloudDriveError("upstream", "CLOUD_DRIVE_UPSTREAM_ERROR", "boom"), "UPSTREAM_ERROR"],
      [notConfiguredError(), "NOT_CONFIGURED"],
    ];

    for (const [error, expectedCode] of cases) {
      const gateway = fakeGateway({
        getMe: async () => {
          throw error;
        },
      });
      const outcome = await findTool("read", "cloud_drive_me").run(context(gateway), {});
      const body = text(outcome);

      expect(outcome.errorCode).toBe(expectedCode as never);
      expect(outcome.result.isError).toBe(true);
      expect(body).toContain(`"code":"${expectedCode}"`);
      expect(body).not.toContain("http://drive.localhost");
      expect(body).not.toContain("conflict detail");
    }
  });

  // 新建文本走「预留 → 分片 → 提交」三步；参数里没有 uid 时结果只回文件与版本。
  test("write_text 走上传三步并返回文件与版本", async () => {
    const chunks: number[] = [];
    const gateway = fakeGateway({
      beginUpload: async (_subject, input) => {
        expect(input.name).toBe("notes.md");
        expect(input.sizeBytes).toBe(new TextEncoder().encode("# 标题").byteLength);
        return makeUpload();
      },
      patchUpload: async (_subject, _uploadId, input) => {
        chunks.push(input.chunk.byteLength);
        return { uploadId: "upload-1", offset: input.chunk.byteLength, length: input.chunk.byteLength };
      },
      finalizeUpload: async () => ({
        fileId: "file-new",
        versionId: "version-new",
        state: "committed",
      }),
    });

    const outcome = await findTool("write", "cloud_drive_write_text").run(context(gateway), {
      name: "notes.md",
      content: "# 标题",
    });

    expect(chunks).toHaveLength(1);
    expect(outcome.result.isError).toBeUndefined();
    expect(outcome.result.structuredContent).toMatchObject({ file_id: "file-new", version_id: "version-new" });
  });

  // 覆盖写必须显式给 file_id；同时给 name 会被判定为「按名覆盖」而拒绝。
  test("write_text 拒绝 file_id 与 name 混用", async () => {
    let called = false;
    const gateway = fakeGateway({
      beginUpload: async () => {
        called = true;
        return makeUpload();
      },
    });

    const outcome = await findTool("write", "cloud_drive_write_text").run(context(gateway), {
      file_id: "file-1",
      name: "notes.md",
      content: "x",
    });

    expect(called).toBe(false);
    expect(outcome.errorCode).toBe("INVALID_ARGUMENT");
  });

  // 超过 1 MiB 的文本必须拒绝：二进制/大文件走控制台的分片上传。
  test("write_text 拒绝超过 1 MiB 的内容", async () => {
    const gateway = fakeGateway({});
    const outcome = await findTool("write", "cloud_drive_write_text").run(context(gateway), {
      name: "big.txt",
      content: "a".repeat(CLOUD_DRIVE_MCP_WRITE_TEXT_MAX_BYTES + 1),
    });

    expect(outcome.errorCode).toBe("INVALID_ARGUMENT");
  });

  // 上传中途失败要放弃会话，避免 CloudDrive 一直占着预留配额。
  test("write_text 分片失败时放弃上传会话", async () => {
    let abandoned = false;
    const gateway = fakeGateway({
      beginUpload: async () => makeUpload(),
      patchUpload: async () => {
        throw new CloudDriveError("unavailable", "CLOUD_DRIVE_UNAVAILABLE", "network down");
      },
      abandonUpload: async () => {
        abandoned = true;
        return { uploadId: "upload-1", status: "abandoned" } as never;
      },
    });

    const outcome = await findTool("write", "cloud_drive_write_text").run(context(gateway), {
      name: "notes.md",
      content: "x",
    });

    expect(abandoned).toBe(true);
    expect(outcome.errorCode).toBe("UNAVAILABLE");
  });

  // 移动与重命名共用 Facade 的 moveFile；parent_id=null 表示根目录。
  test("move 支持移动到根目录，rename 只改名称", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const gateway = fakeGateway({
      getFile: async () => makeFile({ parentId: "dir-1", name: "old.txt" }),
      moveFile: async (_subject, _fileId, input) => {
        calls.push({ name: input.name, parentId: input.parentId });
        return makeMutation({ fileId: "file-1" });
      },
    });

    await findTool("write", "cloud_drive_move").run(context(gateway), { file_id: "file-1", parent_id: null });
    await findTool("write", "cloud_drive_rename").run(context(gateway), { file_id: "file-1", name: "new.txt" });

    expect(calls[0]).toMatchObject({ name: "old.txt", parentId: null });
    expect(calls[1]).toMatchObject({ name: "new.txt", parentId: "dir-1" });
  });

  // 工具描述必须把「文件内容不可信」写进去，且写工具声明非只读。
  test("工具注解与描述符合安全约定", () => {
    for (const tool of toolsFor("write")) {
      const readOnly = tool.scope === "read";
      expect(tool.annotations.readOnlyHint).toBe(readOnly);
      expect(tool.annotations.destructiveHint).toBe(false);
    }
    const reader = findTool("read", "cloud_drive_read_markdown");
    expect(reader.description).toContain("不可信数据");
  });
});
