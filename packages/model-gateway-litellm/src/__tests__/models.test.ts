import { describe, expect, test } from "bun:test";
import { createLiteLlmAdapter } from "@fenix/model-gateway-litellm";
import { ModelGatewayError } from "@fenix/model-gateway-sdk";

describe("LiteLLM model adapter", () => {
  // 验证管理请求使用 Master Key，并且模型目录只暴露网关无关的安全字段。
  test("checks health and maps a deduplicated model catalog", async () => {
    const requests: Request[] = [];
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test/",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        if (request.url.endsWith("/health")) {
          return Response.json({ status: "healthy", version: "v1.86.2" });
        }
        return Response.json({
          data: [
            {
              model_name: "gpt-4o",
              litellm_params: {
                model: "openai/gpt-4o",
                api_key: "must-not-cross-boundary",
              },
            },
            { model_name: "gpt-4o", litellm_params: { model: "openai/gpt-4o" } },
            { model_name: "claude-3-5-sonnet", litellm_params: { model: "anthropic/claude-3-5-sonnet" } },
          ],
        });
      },
    });

    await expect(adapter.checkHealth()).resolves.toMatchObject({
      status: "healthy",
      version: "v1.86.2",
    });
    await expect(adapter.listModels()).resolves.toEqual([
      { id: "gpt-4o", displayName: "gpt-4o", provider: undefined },
      { id: "claude-3-5-sonnet", displayName: "claude-3-5-sonnet", provider: undefined },
    ]);
    expect(requests.every((request) => request.headers.get("authorization") === "Bearer master-key")).toBe(true);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(["/health", "/model/info"]);
  });

  // 验证上游鉴权错误映射为稳定错误码，且不会把上游响应正文带入错误。
  test("maps unauthorized responses without leaking the response body", async () => {
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async () => new Response("secret upstream details", { status: 401 }),
    });

    let error: unknown;
    try {
      await adapter.listModels();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(ModelGatewayError);
    expect((error as ModelGatewayError).code).toBe("UNAUTHORIZED");
    expect((error as ModelGatewayError).message).not.toContain("secret upstream details");
  });

  // 验证常见上游故障被转换为稳定错误码，调用方无需依赖 LiteLLM 的响应格式。
  test("maps rate limits and service failures", async () => {
    for (const [status, code] of [
      [429, "RATE_LIMITED"],
      [503, "UNAVAILABLE"],
    ] as const) {
      const adapter = createLiteLlmAdapter({
        baseUrl: "http://litellm.test",
        adminKey: "master-key",
        managementUiUrl: "http://litellm.test/ui",
        timeoutMs: 1000,
        fetchImpl: async () => new Response("upstream details", { status }),
      });

      let error: unknown;
      try {
        await adapter.listModels();
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(ModelGatewayError);
      expect((error as ModelGatewayError).code).toBe(code);
    }
  });

  // 验证请求超时不会无限等待，并统一归类为网关不可用。
  test("maps an aborted request to unavailable", async () => {
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 5,
      fetchImpl: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });

    let error: unknown;
    try {
      await adapter.listModels();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ModelGatewayError);
    expect((error as ModelGatewayError).code).toBe("UNAVAILABLE");
  });
});
