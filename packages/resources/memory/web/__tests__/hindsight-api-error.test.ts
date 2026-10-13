import { afterEach, describe, expect, test } from "bun:test";
import { hindsightApi } from "../api/hindsight";
import { toHindsightFailure } from "../pages/hindsight/failure";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("hindsightApi error normalization", () => {
  // Web API 的结构化错误应保留 message，不能被 Error 构造器转换成无诊断价值的对象字符串。
  test("从标准错误响应中提取消息", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          success: false,
          error: { code: "service_unavailable", message: "Hindsight service unavailable" },
        }),
        { status: 503, headers: { "Content-Type": "application/json" } },
      );

    await expect(hindsightApi.getGraph({ type: "world" })).rejects.toThrow("Hindsight service unavailable");
  });

  // 端到端钉住 403 的码值透传：后端写 `forbidden`，request 层只对无 code 的响应做状态码归一，
  // 因此带 code 的 403 原样透传。分类器依赖这一事实，链路任一环变码值都会让「无权限」分支失效。
  test("403 bank 映射缺失经请求层归类为无权限", async () => {
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ success: false, error: { code: "forbidden", message: "Cannot resolve bank ID" } }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      );

    const error = await hindsightApi.getGraph({ type: "world" }).catch((reason: unknown) => reason);

    expect(toHindsightFailure(error)).toEqual({ kind: "forbidden" });
  });
});
