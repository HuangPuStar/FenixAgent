import { describe, expect, test } from "bun:test";
import { type GitError, isGitError } from "../contracts/errors";
import type { RepositoryRef } from "../contracts/types";
import { ForgejoClient, type ForgejoClientOptions } from "../forgejo/client";
import type { FetchLike } from "../forgejo/http";

/**
 * 附件适配器的边界测试（方案 §5、§12 附件上限）。
 *
 * 附件与工单/评论/标签的差别集中在三处，用例也只锁这三处：
 * 1. **内容地址在 API 前缀之外**（`/attachments/{uuid}`）：路径必须由本包用 uuid 重建，上游返回的
 *    `browser_download_url` 一律不采信——否则上游可以决定本进程带着凭据去哪里取文件；
 * 2. **字节流不受 1 MiB 上限约束**：JSON 读路径的上限对 MB 级附件不成立，超限响应必须能整段读完；
 * 3. **上传的输入类拒绝是确定失败**：413/422 归 `INVALID_REQUEST`，绝不能提升成 `WRITE_UNCERTAIN`
 *    让恢复流程去核对一份从未创建的附件。
 *
 * 全部用例通过 `fetchImpl` 注入替身，不触网、不替换 `globalThis.fetch`（与 `forgejo-client.test.ts` 同口径）。
 */

const BASE_URL = "http://forgejo.test:3210";
const TOKEN = "test-token-value";
const REF: RepositoryRef = { connectionId: "primary", providerRepositoryId: "7", owner: "acme", name: "demo" };

/** 上游给的下载地址刻意指向另一个源：用例断言它不会被采信。 */
const FOREIGN_DOWNLOAD_URL = "http://evil.test/attachments/should-not-be-used";

const ATTACHMENT_UUID = "0b40be6a-f96b-4e19-8326-9acabdbc28f4";

interface StubCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

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
  return new ForgejoClient({ baseUrl: BASE_URL, token: TOKEN, fetchImpl, readRetryDelayMs: 0, ...overrides });
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** 附件内容响应：字节流而不是 JSON（真实上游返回的是文件本体）。 */
function streamResponse(
  chunks: readonly Uint8Array[],
  init: { status?: number; contentType?: string; contentLength?: number } = {},
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const headers = new Headers();
  if (init.contentType !== undefined) headers.set("content-type", init.contentType);
  if (init.contentLength !== undefined) headers.set("content-length", String(init.contentLength));
  return new Response(stream, { status: init.status ?? 200, headers });
}

function attachmentDto(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4,
    name: "report.txt",
    size: 5,
    created_at: "2026-10-13T02:35:57Z",
    uuid: ATTACHMENT_UUID,
    browser_download_url: FOREIGN_DOWNLOAD_URL,
    type: "attachment",
    ...overrides,
  };
}

function headersOf(call: StubCall): Readonly<Record<string, string>> {
  return { ...(call.init?.headers as Record<string, string> | undefined) };
}

async function gitErrorOf(work: Promise<unknown>): Promise<GitError> {
  try {
    await work;
  } catch (error) {
    if (isGitError(error)) return error;
    throw error;
  }
  throw new Error("期望调用失败，但它成功了");
}

/** 读完整个流并返回字节数；顺带证明调用方可以按块消费而不是一次性读入。 */
async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<number> {
  if (stream === null) throw new Error("期望拿到字节流");
  const reader = stream.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value?.byteLength ?? 0;
  }
  return total;
}

describe("列出附件", () => {
  // 列表路径挂在工单下且走 /api/v1；映射必须把 id 收成字符串、size 保留为数字。
  // 上游不发 Link 头（实测 15.0.9），因此必须**只发一次**请求——多翻一页就会把整份集合重复计入。
  test("按工单列出并把 id 映射为字符串", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse([attachmentDto()]));
    const result = await client(fetchImpl).listIssueAttachments(REF, "12");

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE_URL}/api/v1/repos/acme/demo/issues/12/assets?page=1&limit=100`);
    expect(result).toEqual([{ id: "4", name: "report.txt", size: 5, createdAt: "2026-10-13T02:35:57.000Z" }]);
  });

  // 列表非数组（上游换成了对象信封）会让页面渲染出一个空集合，必须报 INVALID_RESPONSE 而不是静默丢数据。
  test("列表响应不是数组时报合同错误", async () => {
    const { fetchImpl } = createStub(() => jsonResponse({ items: [] }));
    const error = await gitErrorOf(client(fetchImpl).listIssueAttachments(REF, "12"));

    expect(error.code).toBe("INVALID_RESPONSE");
  });

  // size 缺失或被截断时不得臆造 0：界面据此显示文件大小，错了用户看不出。
  test("附件大小非法时报合同错误", async () => {
    const { fetchImpl } = createStub(() => jsonResponse([attachmentDto({ size: -1 })]));
    const error = await gitErrorOf(client(fetchImpl).listIssueAttachments(REF, "12"));

    expect(error.code).toBe("INVALID_RESPONSE");
  });

  // 上游透出 Link 头时按页翻完：只给第一页等于静默丢附件。
  test("按 Link 头翻页取完整集合", async () => {
    const { calls, fetchImpl } = createStub((_call, index) =>
      jsonResponse([attachmentDto({ id: index + 4 })], {
        headers:
          index === 0 ? { link: `<${BASE_URL}/api/v1/repos/acme/demo/issues/12/assets?page=2>; rel="next"` } : {},
      }),
    );
    const result = await client(fetchImpl).listIssueAttachments(REF, "12");

    expect(result.map((item) => item.id)).toEqual(["4", "5"]);
    expect(calls[1]?.url).toContain("page=2");
  });
});

describe("上传附件", () => {
  // 上传必须是 multipart/form-data：字段名 attachment、文件名同时进 query，凭据只进请求头。
  test("以 multipart 上传并映射回执", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse(attachmentDto(), { status: 201 }));
    const content = new TextEncoder().encode("hello");
    const result = await client(fetchImpl).uploadIssueAttachment(REF, "12", { name: "报告.txt", content });

    const call = calls[0];
    expect(call?.url).toBe(
      `${BASE_URL}/api/v1/repos/acme/demo/issues/12/assets?name=${encodeURIComponent("报告.txt")}`,
    );
    expect(call?.init?.method).toBe("POST");
    expect(headersOf(call).authorization).toBe(`token ${TOKEN}`);
    // content-type 必须缺席：multipart 的 boundary 由 fetch 生成，手写会与正文不一致。
    expect(headersOf(call)["content-type"]).toBeUndefined();
    const form = call?.init?.body;
    expect(form instanceof FormData).toBe(true);
    const part = (form as FormData).get("attachment");
    expect(part instanceof Blob).toBe(true);
    expect((part as File).name).toBe("报告.txt");
    expect(result.id).toBe("4");
  });

  // 422（扩展名不在上游白名单）是**确定**拒绝：报 INVALID_REQUEST，不得提升成 WRITE_UNCERTAIN。
  test("上游 422 是确定拒绝而不是结果未定", async () => {
    const { fetchImpl } = createStub(() => jsonResponse({ message: "not allowed" }, { status: 422 }));
    const error = await gitErrorOf(
      client(fetchImpl).uploadIssueAttachment(REF, "12", { name: "a.bin", content: new Uint8Array([1]) }),
    );

    expect(error.code).toBe("INVALID_REQUEST");
    expect(error.message).not.toContain("not allowed");
  });

  // 413（超过上游大小上限）同样确定：把它标成 uncertain 会让工单侧为一份不存在的附件保留待核对态。
  test("上游 413 同样是确定拒绝", async () => {
    const { fetchImpl } = createStub(() => jsonResponse({ message: "too large" }, { status: 413 }));
    const error = await gitErrorOf(
      client(fetchImpl).uploadIssueAttachment(REF, "12", { name: "big.txt", content: new Uint8Array([1]) }),
    );

    expect(error.code).toBe("INVALID_REQUEST");
  });

  // 网络层失败保持写语义：远端是否落库未知，必须走 WRITE_UNCERTAIN 由恢复核对接手。
  test("网络故障提升为 WRITE_UNCERTAIN", async () => {
    const { fetchImpl } = createStub(() => {
      throw new TypeError("fetch failed");
    });
    const error = await gitErrorOf(
      client(fetchImpl).uploadIssueAttachment(REF, "12", { name: "a.txt", content: new Uint8Array([1]) }),
    );

    expect(error.code).toBe("WRITE_UNCERTAIN");
  });
});

describe("下载附件", () => {
  /** 元数据 → 内容两步：第一次 404（附件不属于该工单）时不得再打第二次请求。 */
  test("先按附件编号回读元数据，再取内容", async () => {
    const { calls, fetchImpl } = createStub((_call, index) =>
      index === 0
        ? jsonResponse(attachmentDto())
        : streamResponse([new TextEncoder().encode("hello")], { contentType: "text/plain; charset=utf-8" }),
    );
    const download = await client(fetchImpl).downloadIssueAttachment(REF, "12", "4");

    expect(calls[0]?.url).toBe(`${BASE_URL}/api/v1/repos/acme/demo/issues/12/assets/4`);
    // 内容地址由 uuid 重建：上游给的 browser_download_url 指向 evil.test，绝不能被采用。
    expect(calls[1]?.url).toBe(`${BASE_URL}/attachments/${ATTACHMENT_UUID}`);
    expect(download.attachment).toEqual({
      id: "4",
      name: "report.txt",
      size: 5,
      createdAt: "2026-10-13T02:35:57.000Z",
    });
    expect(download.contentType).toBe("text/plain; charset=utf-8");
    expect(await readAll(download.stream)).toBe(5);
  });

  // 附件不属于该工单时上游给 404：不得把「不属于」与「读失败」混起来，也不该继续去取内容。
  test("附件不属于该工单时 404 且不再取内容", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse({ message: "nope" }, { status: 404 }));
    const error = await gitErrorOf(client(fetchImpl).downloadIssueAttachment(REF, "12", "99"));

    expect(error.code).toBe("NOT_FOUND");
    expect(calls).toHaveLength(1);
  });

  // uuid 形状非法（试图用 `..` 逃出 /attachments/ 前缀）时当场拒绝，且不发生第二次请求。
  test("uuid 非法时不发出内容请求", async () => {
    const { calls, fetchImpl } = createStub(() => jsonResponse(attachmentDto({ uuid: "../../api/v1/user" })));
    const error = await gitErrorOf(client(fetchImpl).downloadIssueAttachment(REF, "12", "4"));

    expect(error.code).toBe("INVALID_RESPONSE");
    expect(calls).toHaveLength(1);
  });

  // 附件内容不受 JSON 读路径的 1 MiB 上限约束：1.5 MiB 的流必须能整段读完。
  test("超过 1 MiB 的附件内容可以整段读完", async () => {
    const chunk = new Uint8Array(64 * 1024).fill(7);
    const chunks = Array.from({ length: 24 }, () => chunk);
    const { fetchImpl } = createStub((_call, index) =>
      index === 0 ? jsonResponse(attachmentDto()) : streamResponse(chunks),
    );
    const download = await client(fetchImpl).downloadIssueAttachment(REF, "12", "4");

    expect(await readAll(download.stream)).toBe(chunk.byteLength * chunks.length);
  });

  // 内容端点返回错误状态时不给流：调用方拿到 null 流会静默当成空文件下载。
  test("内容端点失败时抛错且不返回流", async () => {
    const { fetchImpl } = createStub((_call, index) =>
      index === 0 ? jsonResponse(attachmentDto()) : jsonResponse({ message: "gone" }, { status: 500 }),
    );
    const error = await gitErrorOf(client(fetchImpl).downloadIssueAttachment(REF, "12", "4"));

    expect(error.code).toBe("UNAVAILABLE");
  });

  // 并发名额必须随流的生命周期归还：读完一条流之后，闸门上限为 1 的客户端仍能完成下一次下载。
  test("流读完后归还并发名额", async () => {
    const { fetchImpl } = createStub((_call, index) =>
      index % 2 === 0 ? jsonResponse(attachmentDto()) : streamResponse([new TextEncoder().encode("ok")]),
    );
    const subject = client(fetchImpl, { maxConcurrentRequests: 1 });

    const first = await subject.downloadIssueAttachment(REF, "12", "4");
    await readAll(first.stream);
    const second = await subject.downloadIssueAttachment(REF, "12", "4");

    expect(await withTimeout(readAll(second.stream), "等待超时：并发名额没有归还")).toBe(2);
  });
});

/** 竞态护栏：闸门泄漏时本用例会失败而不是挂起（挂起看不出是「泄漏」还是「跑得慢」）。 */
async function withTimeout<T>(work: Promise<T>, message: string, ms = 1000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    });
    return await Promise.race([work, guard]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
