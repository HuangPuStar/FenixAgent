import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import apiSystemLogRoutes, { setSystemLogServiceForTests } from "../routes/api/system-logs";
import { createSystemLogService } from "../services/system-log-service";

function request(path: string, init?: RequestInit) {
  return apiSystemLogRoutes.handle(new Request(`http://localhost${path}`, init));
}

describe("API System Logs", () => {
  const originalKeys = process.env.RCS_SYSTEM_API_KEYS;
  let logRoot = "";

  beforeEach(async () => {
    process.env.RCS_SYSTEM_API_KEYS = "system-log-test-key";
    logRoot = await mkdtemp(join(tmpdir(), "fenix-system-logs-"));
    await writeFile(
      join(logRoot, "app.log"),
      [
        '{"level":"info","time":"2026-08-20T01:00:00.000Z","module":"server","msg":"booted"}',
        '{"level":"error","time":"2026-08-20T01:01:00.000Z","module":"console","requestId":"req_1","err":{"type":"SyntaxError","message":"invalid JSON","stack":"SyntaxError: invalid JSON"},"msg":"Failed to parse JSON message"}',
        "warn retry",
        "error final failure",
        "",
      ].join("\n"),
    );
    await writeFile(join(logRoot, "ignored.txt"), "must not be visible");
    await mkdir(join(logRoot, "nested"));
    await writeFile(join(logRoot, "nested", "secret.log"), "must not be visible");
    setSystemLogServiceForTests(createSystemLogService(logRoot));
  });

  afterEach(async () => {
    setSystemLogServiceForTests(null);
    process.env.RCS_SYSTEM_API_KEYS = originalKeys;
    await rm(logRoot, { recursive: true, force: true });
  });

  // 日志管理接口属于系统级能力，未携带 master key 时必须拒绝访问。
  test("无系统 key 时返回 401", async () => {
    const response = await request("/api/system/logs/");
    expect(response.status).toBe(401);
  });

  // 列表只能暴露日志根目录直属 .log 文件，其他文件和嵌套日志均不可见。
  test("只列出日志根目录直属 log 文件", async () => {
    const response = await request("/api/system/logs/", {
      headers: { Authorization: "Bearer system-log-test-key" },
    });
    const body = (await response.json()) as { data: { files: { name: string }[] } };

    expect(response.status).toBe(200);
    expect(body.data.files.map((file) => file.name)).toEqual(["app.log"]);
  });

  // JSON Lines 会解析为结构化记录，关键字与 error 过滤同时作用于结构化字段和传统文本行。
  test("按关键字和 error 条件过滤结构化日志", async () => {
    const response = await request("/api/system/logs/search?file=app.log&q=failed&errorOnly=true&limit=1", {
      headers: { Authorization: "Bearer system-log-test-key" },
    });
    const body = (await response.json()) as {
      data: {
        entries: {
          timestamp: string | null;
          level: string | null;
          module: string | null;
          requestId: string | null;
          message: string;
          error: { type: string | null; message: string | null; stack: string | null } | null;
        }[];
        totalMatches: number;
        truncated: boolean;
      };
    };

    expect(response.status).toBe(200);
    expect(body.data.entries).toEqual([
      {
        timestamp: "2026-08-20T01:01:00.000Z",
        level: "error",
        module: "console",
        message: "Failed to parse JSON message",
        error: { type: "SyntaxError", message: "invalid JSON", stack: "SyntaxError: invalid JSON" },
        requestId: "req_1",
      },
    ]);
    expect(body.data.totalMatches).toBe(1);
    expect(body.data.truncated).toBe(false);
  });

  // 文件名不得包含路径分隔符，避免通过下载或搜索端点越过 logs 边界。
  test("拒绝目录穿越文件名", async () => {
    const response = await request("/api/system/logs/search?file=..%2Fsecret.log", {
      headers: { Authorization: "Bearer system-log-test-key" },
    });
    expect(response.status).toBe(400);
  });

  // 下载端点应以附件流返回原始日志内容，并保留安全响应头。
  test("下载日志文件", async () => {
    const response = await request("/api/system/logs/download?file=app.log", {
      headers: { Authorization: "Bearer system-log-test-key" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("Failed to parse JSON message");
  });
});
