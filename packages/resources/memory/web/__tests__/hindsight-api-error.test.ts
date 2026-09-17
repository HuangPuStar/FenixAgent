import { afterEach, describe, expect, test } from "bun:test";
import { hindsightApi } from "../api/hindsight";

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
});
