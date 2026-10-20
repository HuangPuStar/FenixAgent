// 会话分组 API client 的行为测试：请求形状（路径 / 方法 / 查询参数）、键名归一，
// 以及失败信封的分层归属（client 原样返回，unwrap 才抛 ApiError）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { ApiError, unwrap } from "@fenix/web-runtime/api/request";
import { chatSpaceApi } from "../api/chat-spaces";

const fetchCalls: Array<[string, RequestInit]> = [];

// `globalThis.fetch` 是进程级全局且 Bun 的测试文件共享同一进程：装桩后必须还原，否则其后运行的用例
// （如服务端对假上游发真实请求）会收到这里的桩响应，表现为「单跑通过、全量失败」。
let originalFetch: typeof globalThis.fetch;

/** 当前用例的响应工厂，默认给空分组列表；需要失败或特异载荷的用例自行替换 */
let respond: () => Response = () => jsonResponse({ success: true, data: { spaces: [] } });

/** 构造 JSON 响应（request 层按 Content-Type 判定解析路径） */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  fetchCalls.length = 0;
  respond = () => jsonResponse({ success: true, data: { spaces: [] } });
  originalFetch = globalThis.fetch;
  globalThis.fetch = mock((url: string, init: RequestInit) => {
    fetchCalls.push([url, init]);
    return Promise.resolve(respond());
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("chatSpaceApi", () => {
  // 列表请求带 instanceUid 查询参数，并把后端键名归一为 camelCase（会话 id 列表是分组渲染的依据）
  test("list 携带 instanceUid 并归一 snake_case 键名", async () => {
    respond = () =>
      jsonResponse({
        success: true,
        data: {
          spaces: [
            {
              id: "space_1",
              instance_uid: "ins_1",
              name: "调研",
              session_ids: ["ses_a", "ses_b"],
              created_at: "2026-10-01T00:00:00.000Z",
              updated_at: "2026-10-02T00:00:00.000Z",
            },
          ],
        },
      });

    const result = await chatSpaceApi.list({ instanceUid: "ins/1" });

    expect(fetchCalls[0]?.[0]).toBe("/web/chat-spaces?instanceUid=ins%2F1");
    expect(fetchCalls[0]?.[1].method).toBe("GET");
    expect(result.data?.spaces).toEqual([
      {
        id: "space_1",
        instanceUid: "ins_1",
        name: "调研",
        sessionIds: ["ses_a", "ses_b"],
        createdAt: "2026-10-01T00:00:00.000Z",
        updatedAt: "2026-10-02T00:00:00.000Z",
      },
    ]);
  });

  // 创建走集合路径 POST，请求体只带 instanceUid 与 name（后端据此判定同实例重名）；
  // 单分组响应的 `data.space` 用后端视图原样（camelCase），请求层的键名归一只覆盖顶层键与数组元素
  test("create 提交 instanceUid 与 name", async () => {
    respond = () =>
      jsonResponse({
        success: true,
        data: {
          space: {
            id: "space_1",
            instanceUid: "ins_1",
            name: "调研",
            sessionIds: [],
            createdAt: "2026-10-01T00:00:00.000Z",
            updatedAt: "2026-10-01T00:00:00.000Z",
          },
        },
      });

    const result = await chatSpaceApi.create({ instanceUid: "ins_1", name: "调研" });

    expect(fetchCalls[0]?.[0]).toBe("/web/chat-spaces");
    expect(fetchCalls[0]?.[1].method).toBe("POST");
    expect(JSON.parse(fetchCalls[0]?.[1].body as string)).toEqual({ instanceUid: "ins_1", name: "调研" });
    expect(result.data?.space).toEqual({
      id: "space_1",
      instanceUid: "ins_1",
      name: "调研",
      sessionIds: [],
      createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T00:00:00.000Z",
    });
  });

  // 三个动作方法/路径必须与后端路由逐字一致，路径参数做 URL 编码；三者都在 query 上带 instanceUid
  // （服务端用它做权威作用域，分组 id 只在该实例内解析）。移出是唯一不带分组 id 的动作——摘除范围由
  // 服务端按 scope 决定，路径只定位「哪个会话」。
  test("rename/assign/unassign 使用 PATCH、PUT、DELETE 对应路径并携带 instanceUid", async () => {
    respond = () =>
      jsonResponse({
        success: true,
        data: { space: { id: "space_1", instanceUid: "ins_1", name: "调研", sessionIds: [] } },
      });

    await chatSpaceApi.rename({ id: "space/1", instanceUid: "ins/1" }, { name: "新名" });
    await chatSpaceApi.assign({ id: "space/1", sessionId: "ses/a", instanceUid: "ins/1" });
    await chatSpaceApi.unassign({ sessionId: "ses/a", instanceUid: "ins/1" });

    expect(fetchCalls.map(([url, init]) => [url, init.method])).toEqual([
      ["/web/chat-spaces/space%2F1?instanceUid=ins%2F1", "PATCH"],
      ["/web/chat-spaces/space%2F1/sessions/ses%2Fa?instanceUid=ins%2F1", "PUT"],
      ["/web/chat-spaces/sessions/ses%2Fa?instanceUid=ins%2F1", "DELETE"],
    ]);
    expect(JSON.parse(fetchCalls[0]?.[1].body as string)).toEqual({ name: "新名" });
    // 非路径字段不得混进路径参数：instanceUid 只出现在 query 上（混入会参与 `:key` 插值循环）
    for (const [url] of fetchCalls) expect(url).not.toContain("instanceUid=ins/1");
  });

  // 失败信封不在 client 层抛出（这是统一请求层的语义）：unwrap 才把它归一成带后端错误码的 ApiError
  test("失败信封由 unwrap 归一成携带后端错误码的 ApiError", async () => {
    respond = () => jsonResponse({ success: false, error: { code: "conflict", message: "分组名已存在" } });

    const response = await chatSpaceApi.list({ instanceUid: "ins_1" });
    expect(response.success).toBe(false);
    expect(response.error?.message).toBe("分组名已存在");

    let failure: unknown = null;
    try {
      await unwrap(chatSpaceApi.list({ instanceUid: "ins_1" }));
    } catch (error) {
      failure = error;
    }
    if (!(failure instanceof ApiError)) throw new Error(`期望抛出 ApiError，实际为 ${String(failure)}`);
    expect(failure.code).toBe("conflict");
    expect(failure.message).toBe("分组名已存在");
  });
});
