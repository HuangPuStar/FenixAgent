// 日志下载的数据流用例（AdminLogsPage → api/system-logs.downloadSystemLog）。
//
// 覆盖的是「失败如何分类、错误往哪走」这条关键数据流：下载端点的失败必须归一为统一的 ApiError，
// 401/403 归 UNAUTHORIZED（页面据此清 master key 回门），其余归非鉴权错误（页面给可见提示）。
// 旧实现抛的是裸 `Error("日志下载失败")`——页面既不 await 也不 catch，失败既没有提示、也无法识别
// 凭据失效，界面完全没有反馈。这里把这条契约钉住，回归时直接失败。
//
// 不做 UI 结构断言：bun test 没有 DOM，组件渲染不在本包测试口径内（见 CLAUDE.md 前端测试规范）。

import { afterEach, describe, expect, test } from "bun:test";
import { ApiError } from "@fenix/web-runtime/api/request";
import { downloadSystemLog } from "../api/system-logs";

interface FetchCall {
  url: string;
  init?: RequestInit;
}

/** 替换全局 fetch 并记录调用；返回的 restore 必须在 afterEach 调用（全局替换会泄漏到其它文件）。 */
function stubFetch(respond: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof globalThis.fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
}

/** JSON 错误信封响应（`/api/system/*` 的线上形状）。 */
function errorEnvelope(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ error: { code, message } }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
/** 测试进程没有浏览器全局：master key 与下载锚点都按最小替身注入，用完恢复。 */
const globalScope = globalThis as Record<string, unknown>;

afterEach(() => {
  for (const [key, descriptor] of [
    ["sessionStorage", originalSessionStorage],
    ["document", originalDocument],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("downloadSystemLog", () => {
  // 401 必须归一为 UNAUTHORIZED：页面靠这个码清 admin key 并退回 MasterKeyGate。
  test("401 归一为 UNAUTHORIZED", async () => {
    const fetcher = stubFetch(() => errorEnvelope(401, "UNAUTHORIZED", "Invalid system API key"));

    const error = await downloadSystemLog("app.log").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("UNAUTHORIZED");
    expect((error as ApiError).message).toBe("Invalid system API key");
    expect(fetcher.calls[0].url).toBe("/api/system/logs/download?file=app.log");
    fetcher.restore();
  });

  // 网关/代理拦截返回 HTML（非错误信封）时不能把解析异常抛给调用方：退化为按状态码分类的服务端错误，
  // 同时保留诊断上下文（解析异常进 console），否则失败会变成无法分类的 SyntaxError。
  test("错误体不是错误信封时按状态码兜底分类", async () => {
    const fetcher = stubFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));

    const error = await downloadSystemLog("app.log").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("SERVER_ERROR");
    fetcher.restore();
  });

  // 业务错误（如文件不存在）保留服务端错误码与消息：文件被轮转掉时页面提示的应是「找不到」而非「失败」。
  test("业务错误保留服务端错误码", async () => {
    const fetcher = stubFetch(() => errorEnvelope(404, "NOT_FOUND", "Log file not found"));

    const error = await downloadSystemLog("rotated.log").catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("NOT_FOUND");
    fetcher.restore();
  });

  // 成功路径：带同一份 admin key 请求（与列表/搜索同一鉴权口径），并把响应体落成一次浏览器下载。
  test("成功时带 master key 触发浏览器下载", async () => {
    globalScope.sessionStorage = {
      getItem: () => "master-key",
      setItem: () => {},
      removeItem: () => {},
    };
    const clicks: { href: string; download: string }[] = [];
    const anchor = {
      href: "",
      download: "",
      click: () => clicks.push({ href: anchor.href, download: anchor.download }),
    };
    globalScope.document = { createElement: () => anchor };
    const fetcher = stubFetch(
      () => new Response(new Blob(["2026-09-20 booted\n"]), { status: 200, headers: { "content-type": "text/plain" } }),
    );

    await downloadSystemLog("app.log");

    expect(new Headers(fetcher.calls[0].init?.headers).get("authorization")).toBe("Bearer master-key");
    expect(fetcher.calls[0].init?.credentials).toBe("include");
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe("app.log");
    expect(clicks[0].href.startsWith("blob:")).toBe(true);
    fetcher.restore();
  });
});
