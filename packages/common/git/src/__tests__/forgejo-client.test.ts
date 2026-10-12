import { describe, expect, test } from "bun:test";
import { type GitError, type GitErrorCode, isGitError } from "../contracts/errors";
import type { RepositoryRef } from "../contracts/types";
import { ForgejoClient, type ForgejoClientOptions } from "../forgejo/client";
import type { FetchLike } from "../forgejo/http";

/**
 * Forgejo 适配器门面与传输层的契约测试（方案 §3、§5）。
 *
 * 传输层是唯一出网的地方，因此这里锁定的是**边界行为**而不是 happy path：请求 URL 只能由固定 origin 与
 * 内部路径拼成、凭据只进请求头、分页 cursor 只能映射成页码、错误码按状态确定映射、写请求在「结果未知」时
 * 必须提升为 `WRITE_UNCERTAIN`、重定向不得把凭据带到别的源。
 *
 * 全部用例通过 `fetchImpl` 注入 stub，**永不触网**；也不替换 `globalThis.fetch`，避免与同进程的其他测试
 * 互相污染（同批 `bun test` 下全局替身会跨文件生效）。
 */

const BASE_URL = "http://forgejo.test:3210";
/** 合成凭据：只用于断言请求头形态，不指向任何真实实例。 */
const TOKEN = "test-token-value";
/** 上游错误正文：用于断言它不会出现在本模块的错误消息里。 */
const UPSTREAM_MESSAGE = "上游错误正文不应被回显";

const REF: RepositoryRef = { connectionId: "primary", providerRepositoryId: "7", owner: "acme", name: "demo" };

interface StubCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** 注入式传输替身：记录调用序列并返回预置响应。 */
function createStub(handler: (call: StubCall, index: number) => Response): { calls: StubCall[]; fetchImpl: FetchLike } {
  const calls: StubCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const call: StubCall = { url: input, init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { calls, fetchImpl };
}

function client(fetchImpl: FetchLike, overrides: Partial<ForgejoClientOptions> = {}): ForgejoClient {
  // 退避默认注入 0：读请求会按方案 §5 自动重试，真实退避（200ms/400ms）只会让用例白等，不影响断言。
  return new ForgejoClient({ baseUrl: BASE_URL, token: TOKEN, fetchImpl, readRetryDelayMs: 0, ...overrides });
}

/** 取第 n 次调用；调用次数不足时直接失败，而不是把 undefined 当合法值继续断言。 */
function callAt(calls: readonly StubCall[], index: number): StubCall {
  const call = calls[index];
  if (call === undefined) throw new Error(`期望至少 ${index + 1} 次请求，实际只有 ${calls.length} 次`);
  return call;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [key, value] of new Headers(init.headers)) headers.set(key, value);
  return new Response(JSON.stringify(body), { ...init, status: init.status ?? 200, headers });
}

function errorResponse(status: number): Response {
  return jsonResponse({ message: UPSTREAM_MESSAGE }, { status });
}

function headersOf(call: StubCall): Readonly<Record<string, string>> {
  const headers = call.init?.headers;
  if (headers === undefined) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

function bodyOf(call: StubCall): unknown {
  return JSON.parse(String(call.init?.body ?? ""));
}

/** 断言调用以 GitError 失败并返回它，便于继续断言错误码、状态码与消息。 */
async function gitErrorOf(work: Promise<unknown>): Promise<GitError> {
  try {
    await work;
  } catch (error) {
    if (isGitError(error)) return error;
    throw error;
  }
  throw new Error("期望调用失败，但它成功了");
}

function repositoryDto(): Record<string, unknown> {
  return {
    id: 7,
    name: "demo",
    owner: { id: 1, login: "acme" },
    private: true,
    has_issues: true,
    default_branch: "main",
    description: null,
  };
}

function issueDto(): Record<string, unknown> {
  return {
    number: 12,
    title: "登录失败",
    body: "复现步骤",
    state: "open",
    labels: [{ id: 3, name: "bug", color: "ff0000" }],
    user: { id: 1, login: "alice" },
    assignee: null,
    updated_at: "2024-01-02T03:04:05Z",
  };
}

describe("请求构造", () => {
  // 基址尾斜杠被归一后只拼一次 /api/v1，路径由已绑定的 owner/name 派生（调用方无法提供 URL）。
  test("builds the request URL from the fixed origin and the repository coordinates", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse(repositoryDto()));
    const forgejo = new ForgejoClient({ baseUrl: `${BASE_URL}/`, token: TOKEN, fetchImpl });

    await forgejo.getRepository(REF);

    expect(calls).toHaveLength(1);
    expect(callAt(calls, 0).url).toBe("http://forgejo.test:3210/api/v1/repos/acme/demo");
    expect(callAt(calls, 0).init?.method).toBe("GET");
  });

  // 凭据只出现在 Authorization 头：不进 URL、不进正文，读请求声明 Accept: application/json。
  test("sends the token only in the Authorization header", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse(repositoryDto()));

    await client(fetchImpl).getRepository(REF);

    const call = callAt(calls, 0);
    expect(headersOf(call).authorization).toBe(`token ${TOKEN}`);
    expect(headersOf(call).accept).toBe("application/json");
    expect(call.url).not.toContain(TOKEN);
    expect(call.init?.body).toBeUndefined();
  });

  // 写请求把领域输入映射到 Forgejo 端点字段：负责人传 assignees 数组，正文整体 JSON 序列化。
  test("maps createIssue input onto the Forgejo payload", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse(issueDto()));

    await client(fetchImpl).createIssue(REF, {
      title: "登录失败",
      body: "复现步骤",
      labels: ["bug"],
      assignee: "alice",
    });

    const call = callAt(calls, 0);
    expect(call.url).toBe(`${BASE_URL}/api/v1/repos/acme/demo/issues`);
    expect(call.init?.method).toBe("POST");
    expect(headersOf(call)["content-type"]).toBe("application/json");
    expect(bodyOf(call)).toEqual({ title: "登录失败", body: "复现步骤", labels: ["bug"], assignees: ["alice"] });
  });

  // 路径段整体编码、纯点段拒绝：坐标里的斜杠或 `..` 不能把请求折到别的端点上去。
  test("encodes path segments and refuses dot-only coordinates", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse(issueDto()));

    await client(fetchImpl).getIssue({ ...REF, name: "a/b" }, "12");

    expect(callAt(calls, 0).url).toBe(`${BASE_URL}/api/v1/repos/acme/a%2Fb/issues/12`);

    const dotOnly = createStub(() => jsonResponse(issueDto()));
    const error = await gitErrorOf(client(dotOnly.fetchImpl).getIssue({ ...REF, name: ".." }, "12"));

    expect(error.code).toBe("NOT_FOUND");
    expect(dotOnly.calls).toHaveLength(0);
  });
});

describe("分页", () => {
  // cursor 被定义为「下一页页码的十进制字符串」，直接映射到 page；未给 cursor 时从第 1 页开始。
  test("maps the cursor to the page parameter and defaults to the first page", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse([issueDto()]));
    const forgejo = client(fetchImpl);

    await forgejo.listIssues(REF, { cursor: "3", limit: 50 });
    await forgejo.listIssues(REF, {});

    expect(new URL(callAt(calls, 0).url).searchParams.get("page")).toBe("3");
    expect(new URL(callAt(calls, 0).url).searchParams.get("limit")).toBe("50");
    expect(new URL(callAt(calls, 1).url).searchParams.get("page")).toBe("1");
  });

  // limit 按合同夹取到 1..100、默认 30：上游只接受 100，越界值改写成合同上限而不是被原样发出去。
  test("clamps the page size into 1..100 with a default of 30", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse([]));
    const forgejo = client(fetchImpl);

    await forgejo.listIssues(REF, { limit: 500 });
    await forgejo.listIssues(REF, { limit: 0 });
    await forgejo.listIssues(REF, {});

    expect(calls.map((call) => new URL(call.url).searchParams.get("limit"))).toEqual(["100", "1", "30"]);
  });

  // 非法 cursor（非十进制页码）→ INVALID_RESPONSE 且不发请求：不替调用方猜一个页码出来。
  test("rejects an illegal cursor without issuing a request", async () => {
    for (const cursor of ["0", "abc", "-1", "1.5"]) {
      const stub = createStub(() => jsonResponse([]));
      const error = await gitErrorOf(client(stub.fetchImpl).listIssues(REF, { cursor }));

      expect(error.code).toBe("INVALID_RESPONSE");
      expect(stub.calls).toHaveLength(0);
    }
  });

  // 筛选维度映射：state 原样、labels 逗号连接、query 映射到 q。
  test("maps issue filters onto state/labels/q", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse([issueDto()]));

    await client(fetchImpl).listIssues(REF, { state: "all", labels: ["bug", "ui"], query: "登录" });

    const params = new URL(callAt(calls, 0).url).searchParams;
    expect(params.get("state")).toBe("all");
    expect(params.get("labels")).toBe("bug,ui");
    expect(params.get("q")).toBe("登录");
  });

  // nextCursor 只认 Link 头的 rel="next"：头里没有 next（哪怕有 prev/last）就是末页。
  test("reads the next cursor from the Link header", async () => {
    const next = `<${BASE_URL}/api/v1/repos/acme/demo/issues?page=2&limit=30>; rel="next"`;
    const withNext = createStub(() => jsonResponse([issueDto()], { headers: { link: next } }));
    expect((await client(withNext.fetchImpl).listIssues(REF, {})).nextCursor).toBe("2");

    const prevOnly = `<${BASE_URL}/api/v1/repos/acme/demo/issues?page=1&limit=30>; rel="prev"`;
    const lastPage = createStub(() => jsonResponse([issueDto()], { headers: { link: prevOnly } }));
    expect((await client(lastPage.fetchImpl).listIssues(REF, {})).nextCursor).toBeNull();
  });

  // Link 头整体缺失（被中间代理剥掉）时退化为「本页非空就有下一页」：宁可多读一个空页，也不静默截断列表。
  test("falls back to a non-empty page when the Link header is missing", async () => {
    const withItems = createStub(() => jsonResponse([issueDto()]));
    expect((await client(withItems.fetchImpl).listIssues(REF, {})).nextCursor).toBe("2");

    const empty = createStub(() => jsonResponse([]));
    expect((await client(empty.fetchImpl).listIssues(REF, {})).nextCursor).toBeNull();
  });
});

describe("错误映射", () => {
  // 读请求按 HTTP 状态映射错误码：401/403 → FORBIDDEN、404 → NOT_FOUND、409 → CONFLICT、429 → RATE_LIMITED，
  // 其余（含 5xx）→ UNAVAILABLE；状态码保留供诊断，上游正文与错误码都不出现在消息里。
  test("maps HTTP statuses to error codes without echoing the upstream body", async () => {
    const cases: ReadonlyArray<readonly [number, GitErrorCode]> = [
      [401, "FORBIDDEN"],
      [403, "FORBIDDEN"],
      [404, "NOT_FOUND"],
      [409, "CONFLICT"],
      [429, "RATE_LIMITED"],
      [500, "UNAVAILABLE"],
      [503, "UNAVAILABLE"],
    ];

    for (const [status, code] of cases) {
      const stub = createStub(() => errorResponse(status));
      const error = await gitErrorOf(client(stub.fetchImpl).getIssue(REF, "12"));

      expect(error.code).toBe(code);
      expect(error.status).toBe(status);
      expect(error.message).not.toContain(UPSTREAM_MESSAGE);
    }
  });

  // 网络层异常 → UNAVAILABLE，消息只带错误类名：底层文本可能含内网地址等请求细节，不得进错误消息。
  test("maps a transport failure to UNAVAILABLE without echoing the underlying message", async () => {
    const leaked = "connect ECONNREFUSED 10.0.0.1:5432";
    const fetchImpl: FetchLike = async () => {
      throw new TypeError(leaked);
    };

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("TypeError");
    expect(error.message).not.toContain(leaked);
  });

  // 超时（AbortSignal 触发）也归 UNAVAILABLE，但消息要标出「超时」以便与其它网络故障区分。
  test("labels an aborted request as a timeout", async () => {
    const fetchImpl: FetchLike = async () => {
      const aborted = new Error("This operation was aborted");
      aborted.name = "TimeoutError";
      throw aborted;
    };

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("超时");
  });

  // 响应体超过 1 MiB 上限 → INVALID_RESPONSE：敌意或失控的上游不能用超大响应把进程内存吃满。
  test("rejects a response body above the 1 MiB limit", async () => {
    const oversized = "x".repeat(1024 * 1024 + 1);
    const { fetchImpl } = createStub(() => new Response(oversized));

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("INVALID_RESPONSE");
  });
});

describe("写方法的错误提升", () => {
  // 写请求的网络失败提升为 WRITE_UNCERTAIN：远端是否已落库未知，调用方必须走恢复核对而不是直接重发。
  test("promotes a transport failure on a write to WRITE_UNCERTAIN", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new TypeError("socket hang up");
    };

    const error = await gitErrorOf(client(fetchImpl).createIssue(REF, { title: "标题", body: "正文" }));

    expect(error.code).toBe("WRITE_UNCERTAIN");
  });

  // 写请求拿到 2xx 但响应体不符合合同（映射阶段失败）同样提升：写已落库，只是回执不可用。
  test("promotes a mapping failure after a successful write", async () => {
    const { fetchImpl } = createStub(() => jsonResponse({ number: 12 }));

    const error = await gitErrorOf(client(fetchImpl).createIssue(REF, { title: "标题", body: "正文" }));

    expect(error.code).toBe("WRITE_UNCERTAIN");
  });

  // 上游明确拒绝（404/409/429）保持原码：确定失败被标成「结果未知」会让恢复流程去核对从未发生的写入。
  test("keeps determinate rejections on their own codes", async () => {
    const notFound = createStub(() => errorResponse(404));
    expect((await gitErrorOf(client(notFound.fetchImpl).createIssue(REF, { title: "t", body: "b" }))).code).toBe(
      "NOT_FOUND",
    );

    const conflict = createStub(() => errorResponse(409));
    expect((await gitErrorOf(client(conflict.fetchImpl).editIssue(REF, "12", { title: "t" }))).code).toBe("CONFLICT");

    const limited = createStub(() => errorResponse(429));
    expect((await gitErrorOf(client(limited.fetchImpl).createComment(REF, "12", "hi"))).code).toBe("RATE_LIMITED");
  });

  // 写请求的 5xx 先按状态映射为 UNAVAILABLE，再按合同 §3.2 提升为 WRITE_UNCERTAIN：服务端 5xx 无法证明写入未生效。
  test("promotes a 5xx on a write to WRITE_UNCERTAIN", async () => {
    const { fetchImpl } = createStub(() => errorResponse(500));

    const error = await gitErrorOf(client(fetchImpl).createIssue(REF, { title: "标题", body: "正文" }));

    expect(error.code).toBe("WRITE_UNCERTAIN");
    expect(error.status).toBe(500);
  });

  // PUT 标签返回 204 空体时必须回读工单：只凭「响应为空」报空标签集合，会让调用方以为标签被清空了。
  test("re-reads the issue when the label replacement returns no body", async () => {
    const { calls, fetchImpl } = createStub((_call, index) =>
      index === 0 ? new Response(null, { status: 204 }) : jsonResponse(issueDto()),
    );

    const labels = await client(fetchImpl).setIssueLabels(REF, "12", ["bug"]);

    expect(calls.map((call) => call.init?.method)).toEqual(["PUT", "GET"]);
    expect(callAt(calls, 0).url).toBe(`${BASE_URL}/api/v1/repos/acme/demo/issues/12/labels`);
    expect(labels.map((label) => label.name)).toEqual(["bug"]);
  });
});

describe("重定向", () => {
  // 同源重定向跟随（反向代理路径改写场景），全程留在同一 origin 上。
  test("follows a same-origin redirect to the new path", async () => {
    const { calls, fetchImpl } = createStub((_call, index) =>
      index === 0
        ? new Response(null, { status: 302, headers: { location: "/api/v1/repos/acme/demo" } })
        : jsonResponse(repositoryDto()),
    );

    const repository = await client(fetchImpl).getRepository(REF);

    expect(repository.ref.providerRepositoryId).toBe("7");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.url.startsWith(BASE_URL))).toBe(true);
  });

  // 跨源重定向直接拒绝且不发出第二次请求：Authorization 头不得随 Location 被带到别的域。
  test("refuses a cross-origin redirect and never calls the foreign origin", async () => {
    const { calls, fetchImpl } = createStub(
      () => new Response(null, { status: 302, headers: { location: "https://evil.example/api/v1/repos/acme/demo" } }),
    );

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("跨源重定向");
    // 读请求自动重试 2 次（方案 §5）：三次尝试都只打本服务 origin，绝不跟随到 evil.example。
    expect(calls).toHaveLength(3);
    expect(calls.every((call) => call.url.startsWith(BASE_URL))).toBe(true);
  });

  // 同源重定向最多跟 2 跳：第 3 跳仍在重定向即拒绝，避免被上游拖进无限跳转；读重试会整体重放该序列。
  test("stops after two same-origin redirects", async () => {
    const { calls, fetchImpl } = createStub(
      () => new Response(null, { status: 307, headers: { location: "/api/v1/repos/acme/demo" } }),
    );

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("UNAVAILABLE");
    expect(error.message).toContain("重定向超过");
    // 每次尝试 3 跳（首跳 + 2 个同源重定向），共 3 次尝试（首次 + 2 次读重试）。
    expect(calls).toHaveLength(9);
  });
});

describe("读重试与写不重放", () => {
  // 读请求的自动重试只针对可重放的失败（UNAVAILABLE / RATE_LIMITED），且上限 2 次；4xx 直接失败。
  test("retries retryable read failures twice and then gives up", async () => {
    const { calls, fetchImpl } = createStub(() => new Response("{}", { status: 503 }));

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("UNAVAILABLE");
    expect(calls).toHaveLength(3);
  });

  // 404 是确定性结果，重试只会把同一个答案再问一遍；读入口必须立刻抛出。
  test("does not retry deterministic read failures", async () => {
    const { calls, fetchImpl } = createStub(() => new Response("{}", { status: 404 }));

    const error = await gitErrorOf(client(fetchImpl).getRepository(REF));

    expect(error.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });

  // 写请求绝不自动重放：远端是否落库未知时重发会造出第二份对象，这类失败统一走 WRITE_UNCERTAIN。
  test("never replays write requests", async () => {
    const { calls, fetchImpl } = createStub(() => new Response("{}", { status: 503 }));

    const error = await gitErrorOf(client(fetchImpl).createIssue(REF, { title: "t", body: "b" }));

    expect(error.code).toBe("WRITE_UNCERTAIN");
    expect(calls).toHaveLength(1);
  });
});

describe("并发闸", () => {
  // 单实例在途请求数受 maxConcurrentRequests 限制：超出的请求排队，不会同时打满上游。
  test("limits in-flight requests to the configured concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchImpl: FetchLike = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return jsonResponse(repositoryDto());
    };

    const forgejo = client(fetchImpl, { maxConcurrentRequests: 2 });
    await Promise.all(Array.from({ length: 5 }, () => forgejo.getRepository(REF)));

    expect(peak).toBe(2);
  });
});
