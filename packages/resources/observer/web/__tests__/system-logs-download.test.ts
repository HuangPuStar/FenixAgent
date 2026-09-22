// 日志下载的数据流用例（AdminLogsPage → api/system-logs.downloadSystemLog）。
//
// 覆盖的是「失败如何分类、错误往哪走」这条关键数据流：下载端点的失败必须归一为统一的 ApiError，
// 401/403 归 UNAUTHORIZED（页面据此清 master key 回门），其余归非鉴权错误（页面给可见提示）。
// 旧实现抛的是裸 `Error("日志下载失败")`——页面既不 await 也不 catch，失败既没有提示、也无法识别
// 凭据失效，界面完全没有反馈。这里把这条契约钉住，回归时直接失败。
//
// 分层边界（§5.1）：域模块只取数——成功回 `Blob`、失败抛 `ApiError`；触发浏览器落盘的锚点与
// `revokeObjectURL` 归页面（`AdminLogsPage` 的 `saveBlobAsFile`）。成功用例因此断言到 Blob 为止，
// 并且**不注入任何 DOM 替身**：域模块一旦再碰 `document` / 锚点，用例会直接抛错——这比断言
// 「点击了几次锚点」更贴近本层职责（后者原本把 UI 细节钉在了域模块的用例里）。
//
// 页面的落盘动作不做单测：bun test 没有 DOM，组件渲染不在本包测试口径内（见 CLAUDE.md 前端测试规范），
// 该函数只依赖 `URL` / `document` 两个平台 API，无分支可测。

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
/** 测试进程没有浏览器全局：master key 按最小替身注入，用完恢复。 */
const globalScope = globalThis as Record<string, unknown>;

afterEach(() => {
  if (originalSessionStorage) Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
  else Reflect.deleteProperty(globalThis, "sessionStorage");
});

describe("downloadSystemLog", () => {
  // 401 必须归一为 UNAUTHORIZED：页面靠这个码清 admin key 并退回 AdminKeyGate。
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

  // 成功路径：带同一份 admin key 请求（与列表/搜索同一鉴权口径），把响应体原样作为 Blob 交回调用方
  // 供其落盘。用例不注入 DOM 替身，域模块一旦回退到「调用即落盘」就会在此失败。
  test("成功时带 master key 返回日志 Blob", async () => {
    globalScope.sessionStorage = {
      getItem: () => "master-key",
      setItem: () => {},
      removeItem: () => {},
    };
    const fetcher = stubFetch(
      () => new Response(new Blob(["2026-09-20 booted\n"]), { status: 200, headers: { "content-type": "text/plain" } }),
    );

    const blob = await downloadSystemLog("app.log");

    expect(new Headers(fetcher.calls[0].init?.headers).get("authorization")).toBe("Bearer master-key");
    expect(fetcher.calls[0].init?.credentials).toBe("include");
    expect(blob).toBeInstanceOf(Blob);
    expect(await blob.text()).toBe("2026-09-20 booted\n");
    fetcher.restore();
  });
});
