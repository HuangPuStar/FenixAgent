import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiSystemLogsRoutes, setSystemLogServiceForTests } from "../server/routes/api/system-logs";
import { createSystemLogService } from "../server/services/system-log-service";
import { createStubSystemApiGuardPlugin } from "./guard-stubs";

// 守卫替身按插件名去重，同一文件内共用一个实例，避免 Elysia 静默丢弃后构造的那一份。
// 替身是放行的：本文件覆盖协议映射与**日志投影边界**，鉴权合同归宿主装配用例（见 guard-stubs.ts 文件头）。
const apiSystemLogRoutes = createApiSystemLogsRoutes({
  systemApiGuardPlugin: createStubSystemApiGuardPlugin(),
});

function request(path: string, init?: RequestInit) {
  return apiSystemLogRoutes.handle(new Request(`http://localhost${path}`, init));
}

/** 应用日志样本：结构化行、含凭据的行、裸文本行各一条，覆盖投影面的三种输入形态。 */
const APP_LOG_LINES = [
  '{"level":"info","time":"2026-08-20T01:00:00.000Z","module":"server","msg":"booted"}',
  '{"level":"error","time":"2026-08-20T01:01:00.000Z","module":"console","requestId":"req_1","err":{"type":"SyntaxError","message":"invalid JSON","stack":"SyntaxError: invalid JSON"},"msg":"Failed to parse JSON message"}',
  "warn retry",
  "error final failure",
  "",
].join("\n");

/** 含 §7 红线内容的日志行：凭据出现在 msg 里（不在被丢弃的额外字段里），是最坏的一种输入。 */
const SENSITIVE_LOG_LINES = [
  '{"level":"info","time":"2026-08-20T02:00:00.000Z","module":"http","msg":"Authorization: Bearer sk-live-0123456789abcdef"}',
  '{"level":"info","time":"2026-08-20T02:01:00.000Z","module":"http","msg":"Cookie: sid=s3ss1onvalue; theme=dark"}',
  '{"level":"error","time":"2026-08-20T02:02:00.000Z","module":"db","msg":"connect failed password=hunter2 url=postgres://rcs:s3cr3t@db:5432/rcs"}',
  '{"level":"info","time":"2026-08-20T02:03:00.000Z","module":"auth","msg":"callback ?token=abcdef123456&state=x"}',
  '{"level":"info","time":"2026-08-20T02:05:00.000Z","module":"http","msg":"Authorization: Basic cmNztoken=="}',
  '{"level":"info","time":"2026-08-20T02:04:00.000Z","module":"agent","msg":"run prompt","promptText":"用户的完整提问正文"}',
].join("\n");

/** 红线值：任何一个出现在响应里都算投影层失守。 */
const FORBIDDEN_VALUES = [
  "sk-live-0123456789abcdef",
  "s3ss1onvalue",
  "hunter2",
  "s3cr3t",
  "abcdef123456",
  "cmNztoken",
  "用户的完整提问正文",
];

describe("API System Logs", () => {
  let root = "";
  let logRoot = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "fenix-system-logs-"));
    logRoot = join(root, "logs");
    await mkdir(logRoot);
    await writeFile(join(logRoot, "rcs.2026-09-20.log"), APP_LOG_LINES);
    await writeFile(join(logRoot, "rcs.err.2026-09-20.log"), SENSITIVE_LOG_LINES);
    // 以下都不属于本进程白名单化的日志源：非本包命名的 .log、缺日期段的名字、嵌套目录。
    await writeFile(join(logRoot, "legacy.log"), "legacy must not be visible");
    await writeFile(join(logRoot, "rcs.log"), "unnamed rolling file must not be visible");
    await mkdir(join(logRoot, "nested"));
    await writeFile(join(logRoot, "nested", "rcs.2026-09-19.log"), "nested must not be visible");
    // 日志目录之外的同名文件：用于证明 ID 解析不会跟着客户端输入走出目录。
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside", "rcs.2026-09-20.log"), "outside secret must not be visible");
    setSystemLogServiceForTests(createSystemLogService(logRoot));
  });

  afterEach(async () => {
    setSystemLogServiceForTests(null);
    await rm(root, { recursive: true, force: true });
  });

  // 列表只暴露白名单化的日志源（按天滚动的应用日志与 error 文件），目录里其它 .log、缺日期段的名字
  // 与嵌套日志都不进入投影面——这是「不得直读底层日志文件」的第一道边界。
  test("只列出白名单化的日志源", async () => {
    const response = await request("/api/system/logs/");
    const text = await response.text();
    const body = JSON.parse(text) as { data: { sources: { id: string; kind: string; date: string }[] } };

    expect(response.status).toBe(200);
    expect(body.data.sources.map((source) => source.id)).toEqual(["app-2026-09-20", "error-2026-09-20"]);
    expect(body.data.sources.map((source) => source.kind)).toEqual(["app", "error"]);
    // 响应里没有路径：列表给的是投影标识，不是文件位置。
    expect(text).not.toContain(logRoot);
  });

  // 客户端只能传服务端枚举出的 ID：文件名、相对路径、绝对路径一律按协议误用拒绝（400），
  // 且响应不回显输入——回显会变成用状态码探测目录结构的信道。
  test("拒绝文件名与路径注入的参数", async () => {
    for (const injected of [
      "rcs.2026-09-20.log",
      "..%2Frcs.2026-09-20.log",
      "%2Fetc%2Fpasswd",
      "..%2F..%2Foutside%2Frcs.2026-09-20.log",
      "app-2026-09-20%00.log",
    ]) {
      const search = await request(`/api/system/logs/search?sourceId=${injected}`);
      const download = await request(`/api/system/logs/download?sourceId=${injected}`);
      expect({ injected, status: search.status }).toEqual({ injected, status: 400 });
      expect({ injected, status: download.status }).toEqual({ injected, status: 400 });
      expect(await search.text()).not.toContain("passwd");
    }
  });

  // 形状合法但当前不存在的源一律 404，与「目录里有没有这个文件」无关：不可见资源不产生可区分的信号。
  test("未知日志源返回 404 且不泄漏目录", async () => {
    const response = await request("/api/system/logs/search?sourceId=app-2026-01-01");
    const body = await response.text();

    expect(response.status).toBe(404);
    expect(body).not.toContain(logRoot);
    expect(body).not.toContain("app-2026-01-01");
  });

  // 关键字与 error 过滤同时作用于结构化字段和传统文本行；limit 只保留最近的匹配。
  test("按关键字和 error 条件过滤结构化日志", async () => {
    const response = await request("/api/system/logs/search?sourceId=app-2026-09-20&q=failed&errorOnly=true&limit=1");
    const body = (await response.json()) as {
      data: {
        source: { id: string; kind: string };
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
    expect(body.data.source.id).toBe("app-2026-09-20");
    expect(body.data.entries).toEqual([
      {
        timestamp: "2026-08-20T01:01:00.000Z",
        level: "error",
        module: "console",
        requestId: "req_1",
        message: "Failed to parse JSON message",
        error: { type: "SyntaxError", message: "invalid JSON", stack: "SyntaxError: invalid JSON" },
      },
    ]);
    expect(body.data.totalMatches).toBe(1);
    expect(body.data.truncated).toBe(false);
  });

  // 投影只输出固定六个字段：原始 JSON 行里的其它字段（业务负载、请求头、prompt 正文副本）一律不进入响应。
  test("字段投影丢弃白名单之外的字段", async () => {
    const response = await request("/api/system/logs/search?sourceId=error-2026-09-20&q=run%20prompt");
    const body = (await response.json()) as { data: { entries: Record<string, unknown>[] } };

    expect(response.status).toBe(200);
    expect(body.data.entries).toHaveLength(1);
    expect(Object.keys(body.data.entries[0]).sort()).toEqual([
      "error",
      "level",
      "message",
      "module",
      "requestId",
      "timestamp",
    ]);
    expect(JSON.stringify(body)).not.toContain("用户的完整提问正文");
  });

  // §7 红线：token / Cookie / 密码 / 连接串不得出现在响应里——写入侧可能已经违规记了这些内容，
  // 投影层不假定上游干净，出站前按形状脱敏（保留键名与位置，只抹值）。
  test("检索结果对红线内容脱敏", async () => {
    const response = await request("/api/system/logs/search?sourceId=error-2026-09-20&limit=100");
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(FORBIDDEN_VALUES.filter((value) => text.includes(value))).toEqual([]);
    expect(text).toContain("[REDACTED]");
    expect(text).toContain("password=[REDACTED]");
    expect(text).toContain("postgres://[REDACTED]@db:5432/rcs");
  });

  // 筛选在**投影结果**上进行：值已被抹掉，因此检索也不能被当成「原文里有没有这串」的探针
  // （否则抹掉出站值、留下匹配信号，红线仍可被逐字符试出来）。
  test("检索不能在脱敏字段上做存在性探测", async () => {
    const response = await request("/api/system/logs/search?sourceId=error-2026-09-20&q=hunter2");
    const body = (await response.json()) as { data: { entries: unknown[]; totalMatches: number } };

    expect(response.status).toBe(200);
    expect(body.data.totalMatches).toBe(0);
    expect(body.data.entries).toEqual([]);
  });

  // 导出（`/download`）与检索共用同一条投影管线：内容等于同一批投影记录，同样脱敏，
  // 且不包含任何白名单外文件（legacy.log / 嵌套日志 / 目录外同名文件）的内容。
  test("导出与检索共用同一过滤口径", async () => {
    const search = await request("/api/system/logs/search?sourceId=error-2026-09-20&limit=100");
    const searchBody = (await search.json()) as { data: { entries: unknown[] } };

    const download = await request("/api/system/logs/download?sourceId=error-2026-09-20");
    const exportedText = await download.text();
    const exported = exportedText.trimEnd().split("\n");

    expect(download.status).toBe(200);
    expect(exported.map((line) => JSON.parse(line))).toEqual(searchBody.data.entries);
    expect(FORBIDDEN_VALUES.filter((value) => exportedText.includes(value))).toEqual([]);
    expect(exportedText).not.toContain("must not be visible");
  });

  // 导出响应是投影后的 JSON Lines 附件（不是底层文件字节），并带齐安全响应头；
  // 文件名以 `.projected.jsonl` 收尾，避免被当成原始日志留存。
  test("导出响应带投影语义的响应头", async () => {
    const response = await request("/api/system/logs/download?sourceId=app-2026-09-20");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-ndjson; charset=utf-8");
    expect(response.headers.get("content-disposition")).toContain("app-2026-09-20.projected.jsonl");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain(logRoot);
  });

  // 解析不出 JSON 的裸文本行**不能**成为绕过投影的旁路：它照样过脱敏，超长值照样裁剪，
  // 否则「写一行能解析成 JSON、再写一行裸文本」就能把原文带出去。
  test("裸文本行与超长字段同样被投影处理", async () => {
    await writeFile(
      join(logRoot, "rcs.2026-09-17.log"),
      ["token=bare-text-secret from plain line", JSON.stringify({ level: "info", msg: "x".repeat(3_000) })].join("\n"),
    );

    const response = await request("/api/system/logs/search?sourceId=app-2026-09-17&limit=100");
    const body = (await response.json()) as { data: { entries: { message: string }[] } };

    expect(response.status).toBe(200);
    expect(body.data.entries[0].message).toBe("token=[REDACTED] from plain line");
    expect(body.data.entries[1].message).toBe(`${"x".repeat(2_000)}…[truncated]`);
  });

  // 超过单次读取上限的源在打开前就被拒绝：既不读文件也不产出部分内容（413 早于流式读取）。
  test("超过上限的日志源返回 413", async () => {
    const bigPath = join(logRoot, "rcs.2026-09-18.log");
    await writeFile(bigPath, "");
    await truncate(bigPath, 50 * 1024 * 1024 + 1);

    const search = await request("/api/system/logs/search?sourceId=app-2026-09-18");
    const download = await request("/api/system/logs/download?sourceId=app-2026-09-18");

    expect(search.status).toBe(413);
    expect(download.status).toBe(413);
  });

  // 日志滚动会删除旧文件：枚举必须按请求实时读目录，被清理的源立刻从列表消失且不把整张列表打成 500。
  test("被清理的日志源从列表消失", async () => {
    await rm(join(logRoot, "rcs.2026-09-20.log"));

    const response = await request("/api/system/logs/");
    const body = (await response.json()) as { data: { sources: { id: string }[] } };

    expect(response.status).toBe(200);
    expect(body.data.sources.map((source) => source.id)).toEqual(["error-2026-09-20"]);
  });
});
