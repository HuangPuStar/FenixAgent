import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiSystemLogsRoutes, setSystemLogServiceForTests } from "../server/routes/api/system-logs";
import { createSystemLogService } from "../server/services/system-log-service";
import { createStubSystemApiGuardPlugin } from "./guard-stubs";

// 守卫替身按插件名去重，同一文件内共用一个实例，避免 Elysia 静默丢弃后构造的那一份。
// 替身是放行的：本文件覆盖协议映射与日志边界，鉴权合同归宿主装配用例（见 guard-stubs.ts 文件头）。
const apiSystemLogRoutes = createApiSystemLogsRoutes({
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return apiSystemLogRoutes.handle(new Request(`http://localhost${path}`, init));
}

describe("API System Logs", () => {
  let logRoot = "";

  beforeEach(async () => {
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
    await rm(logRoot, { recursive: true, force: true });
  });

  // 列表只能暴露日志根目录直属 .log 文件，其他文件和嵌套日志均不可见。
  test("只列出日志根目录直属 log 文件", async () => {
    const response = await request("/api/system/logs/");
    const body = (await response.json()) as { data: { files: { name: string }[] } };

    expect(response.status).toBe(200);
    expect(body.data.files.map((file) => file.name)).toEqual(["app.log"]);
  });

  // JSON Lines 会解析为结构化记录，关键字与 error 过滤同时作用于结构化字段和传统文本行。
  test("按关键字和 error 条件过滤结构化日志", async () => {
    const response = await request("/api/system/logs/search?file=app.log&q=failed&errorOnly=true&limit=1");
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
    const response = await request("/api/system/logs/search?file=..%2Fsecret.log");
    expect(response.status).toBe(400);
  });

  // 下载端点应以附件流返回原始日志内容，并保留安全响应头。
  test("下载日志文件", async () => {
    const response = await request("/api/system/logs/download?file=app.log");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toContain("Failed to parse JSON message");
  });
});
