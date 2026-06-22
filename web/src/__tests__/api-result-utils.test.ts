import { describe, expect, test } from "bun:test";
import { err, ok } from "@fenix/sdk";

describe("unwrapApiResult", () => {
  // 成功结果应直接返回 data，供页面代码继续使用
  test("returns data for ok results", async () => {
    const { unwrapApiResult } = await import("../lib/api-result");

    const result = unwrapApiResult(ok({ id: "kb_1", name: "Docs" }));

    expect(result).toEqual({ id: "kb_1", name: "Docs" });
  });

  // 失败结果应抛出服务端 message，避免前端静默吞掉错误
  test("throws server error message for error results", async () => {
    const { unwrapApiResult } = await import("../lib/api-result");

    expect(() => unwrapApiResult(err("KNOWLEDGE_PROVIDER_ERROR", "RAGFLOW_API_KEY is not configured", 502))).toThrow(
      "RAGFLOW_API_KEY is not configured",
    );
  });
});
