// src/__tests__/langfuse-client.test.ts
// Langfuse 兼容后端只读薄客户端的契约（`../server/services/langfuse-client.ts`）。
//
// 这一层是**唯一**持有部署凭据并出网的代码，因此用例钉的是三件互相独立的事：
//   1. 请求形状正确（路径、查询参数、Basic 头）——错了只会得到空数据，不报错；
//   2. 失败被归一到 5 类 kind——路由据此选对外错误码，归错会把「凭据无效」显示成「没有数据」；
//   3. **密钥不外泄**：任何失败消息里都不出现 public/secret key 片段（日志与 502 文案都从这些消息来）。
//
// 用真实 HTTP 服务（`Bun.serve`，端口 0 由内核分配）而不是 mock `fetch`：路径拼接、查询参数编码、
// 头注入与响应解析都在真实请求里才成立；mock fetch 只会把「我以为的 URL」再断言一遍。

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createLangfuseClient, LangfuseReadError } from "../server/services/langfuse-client";

/** 测试用凭据：故意取可识别片段，供「消息里不得出现密钥」的断言使用。 */
const CONNECTION = {
  baseUrl: "http://placeholder",
  publicKey: "pk-lf-public-key-material",
  secretKey: "sk-lf-secret-key-material",
};

interface CapturedRequest {
  path: string;
  search: string;
  authorization: string | null;
}

let captured: CapturedRequest[] = [];
/** 下一次请求的响应（按用例改）；默认 200 空页。 */
let nextResponse: { status: number; body: string; contentType?: string } = { status: 200, body: "{}" };

let server: ReturnType<typeof Bun.serve>;
let baseUrl = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      captured.push({
        path: url.pathname,
        search: url.search,
        authorization: request.headers.get("authorization"),
      });
      return new Response(nextResponse.body, {
        status: nextResponse.status,
        headers: { "content-type": nextResponse.contentType ?? "application/json" },
      });
    },
  });
  baseUrl = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

function client() {
  captured = [];
  nextResponse = { status: 200, body: "{}" };
  return createLangfuseClient({ ...CONNECTION, baseUrl }, { timeoutMs: 2_000 });
}

describe("createLangfuseClient 请求形状", () => {
  // 业务意图：`/api/public/traces` 必须带上会话过滤与分页，且明显带 `fields=core,metrics`——少一个查询参数
  // 都会让「按会话列 run」变成「列全项目最近的 run」，这是最容易被误判成「数据对不上」的缺陷。
  test("listTraces 带上 sessionId / 分页 / 字段组", async () => {
    const c = client();
    await c.listTraces({ sessionId: "ses-1", page: 2, limit: 50 });

    const [request] = captured;
    expect(request.path).toBe("/api/public/traces");
    const search = new URLSearchParams(request.search);
    expect(search.get("sessionId")).toBe("ses-1");
    expect(search.get("page")).toBe("2");
    expect(search.get("limit")).toBe("50");
    expect(search.get("fields")).toBe("core,metrics");
  });

  // 业务意图：凭据只经 Basic 头传输，且格式必须是 base64(public:secret)——上游按这一种方式鉴权。
  test("Basic 头按 public:secret 组装", async () => {
    const c = client();
    await c.listTraces({ sessionId: "ses-1", page: 1, limit: 1 });

    expect(captured[0].authorization).toBe(
      `Basic ${Buffer.from(`${CONNECTION.publicKey}:${CONNECTION.secretKey}`).toString("base64")}`,
    );
  });

  // 业务意图：traceId 来自外部输入，必须整体转义后再拼进路径。未转义时带 `/` 或 `?` 的 id 会改变请求目标
  // （等于把「读一条 trace」变成「读任意路径」）。
  test("traceId 拼进路径前被转义", async () => {
    const c = client();
    await c.getTrace("a/../b?x=1", "core");

    expect(captured[0].path).toBe("/api/public/traces/a%2F..%2Fb%3Fx%3D1");
  });

  // 业务意图：结构化过滤条件按上游约定序列化成 JSON 字符串；`cursor` 缺席时不得出现空的 `cursor=` 参数
  // （上游对空串的处理与「未提供」不同）。
  test("listObservations 序列化 filter 并省略缺失的 cursor", async () => {
    const c = client();
    await c.listObservations({
      traceId: "trace-1",
      limit: 100,
      fields: "core,io",
      filter: [{ type: "string", column: "id", operator: "=", value: "obs-1" }],
    });

    const search = new URLSearchParams(captured[0].search);
    expect(search.has("cursor")).toBe(false);
    expect(JSON.parse(search.get("filter") ?? "[]")).toEqual([
      { type: "string", column: "id", operator: "=", value: "obs-1" },
    ]);
    expect(search.get("fields")).toBe("core,io");
  });

  // 业务意图：基址容忍写法差异（部署里常见带尾斜杠），拼接后不得出现 `//api/...`——重复斜杠在部分反代上会
  // 被规范化成不同路径，表现成 404。
  test("基址尾斜杠被归一", async () => {
    captured = [];
    const c = createLangfuseClient({ ...CONNECTION, baseUrl: `${baseUrl}/` }, { timeoutMs: 2_000 });
    await c.listTraces({ sessionId: "ses-1", page: 1, limit: 1 });

    expect(captured[0].path).toBe("/api/public/traces");
  });
});

describe("createLangfuseClient 失败归一", () => {
  // 业务意图：401/403 = 部署凭据无效，面板要给出与「没有数据」不同的处置（前端提示检查配置）。
  test("401 归类为 unauthorized，且消息里不含密钥材料", async () => {
    const c = client();
    nextResponse = { status: 401, body: JSON.stringify({ message: "unauthorized" }) };

    const failure = await c.listTraces({ sessionId: "ses-1", page: 1, limit: 1 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(LangfuseReadError);
    expect((failure as LangfuseReadError).kind).toBe("unauthorized");
    expect((failure as LangfuseReadError).status).toBe(401);
    expect((failure as Error).message).not.toContain(CONNECTION.secretKey);
    expect((failure as Error).message).not.toContain(CONNECTION.publicKey);
  });

  // 业务意图：404 是「这条 trace / observation 不存在」，与上游故障分开——前者面板显示空态，后者要重试。
  test("404 归类为 not_found", async () => {
    const c = client();
    nextResponse = { status: 404, body: "{}" };

    const failure = await c.getTrace("missing", "core").catch((error: unknown) => error);
    expect((failure as LangfuseReadError).kind).toBe("not_found");
  });

  // 业务意图：上游 5xx 既不是配置问题也不是空数据，必须原样透出为 upstream 并保留状态码供排障。
  test("500 归类为 upstream 并保留状态码", async () => {
    const c = client();
    nextResponse = { status: 500, body: "boom" };

    const failure = await c
      .listObservations({ traceId: "t", limit: 1, fields: "core" })
      .catch((error: unknown) => error);
    expect((failure as LangfuseReadError).kind).toBe("upstream");
    expect((failure as LangfuseReadError).status).toBe(500);
  });

  // 业务意图：2xx 但响应不是 JSON（反代返回 HTML 登录页是典型场景）必须归类为 invalid_response，不能把解析
  // 异常原样抛给上层——那会被路由当成未知错误变成 500，掩盖真正原因。
  test("非 JSON 响应归类为 invalid_response", async () => {
    const c = client();
    nextResponse = { status: 200, body: "<html>proxy</html>", contentType: "text/html" };

    const failure = await c.listTraces({ sessionId: "ses-1", page: 1, limit: 1 }).catch((error: unknown) => error);
    expect((failure as LangfuseReadError).kind).toBe("invalid_response");
  });

  // 业务意图：连不上（端口关闭 / DNS 失败 / 超时）必须归类为 unreachable——面板据此显示「后端不可达」并让用户
  // 重试，而不是显示成业务空态。
  test("连不上上游归类为 unreachable", async () => {
    const c = createLangfuseClient({ ...CONNECTION, baseUrl: "http://127.0.0.1:1" }, { timeoutMs: 1_000 });

    const failure = await c.listTraces({ sessionId: "ses-1", page: 1, limit: 1 }).catch((error: unknown) => error);
    expect((failure as LangfuseReadError).kind).toBe("unreachable");
  });
});
