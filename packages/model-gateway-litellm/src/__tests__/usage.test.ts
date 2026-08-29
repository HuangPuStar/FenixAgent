import { describe, expect, test } from "bun:test";
import { createLiteLlmAdapter } from "@fenix/model-gateway-litellm";

describe("LiteLLM usage adapter", () => {
  // LiteLLM daily activity 只接受包含边界的 YYYY-MM-DD 日期范围，Adapter 不得透传 ISO 时间戳。
  test("queries daily usage with an inclusive date-only range", async () => {
    let request: Request | undefined;
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({ results: [] });
      },
    });

    await adapter.queryUsage({
      startAt: "2026-08-23",
      endAt: "2026-08-29",
    });

    const url = new URL(request?.url ?? "http://invalid");
    expect(url.searchParams.get("start_date")).toBe("2026-08-23");
    expect(url.searchParams.get("end_date")).toBe("2026-08-29");
  });

  // 日期查询契约拒绝 ISO 时间戳，避免 LiteLLM 在单日范围返回空结果。
  test("rejects ISO timestamps before calling LiteLLM daily activity", async () => {
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async () => Response.json({ results: [] }),
    });

    await expect(
      adapter.queryUsage({
        startAt: "2026-08-23T00:00:00.000Z",
        endAt: "2026-08-29T00:00:00.000Z",
      }),
    ).rejects.toThrow("YYYY-MM-DD");
  });

  // 验证 LiteLLM 按日聚合的 metrics/breakdown 能转换为统一用量记录。
  test("queries daily usage with precise filters and maps model records", async () => {
    let request: Request | undefined;
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async (input, init) => {
        request = new Request(input, init);
        return Response.json({
          results: [
            {
              date: "2026-08-25",
              metrics: {
                spend: 3.5,
                prompt_tokens: 100,
                completion_tokens: 40,
                total_tokens: 140,
                api_requests: 2,
              },
              breakdown: {
                models: {
                  "gpt-4o": {
                    spend: 3.5,
                    prompt_tokens: 100,
                    completion_tokens: 40,
                    api_requests: 2,
                  },
                },
              },
            },
          ],
        });
      },
    });

    await expect(
      adapter.queryUsage({
        startAt: "2026-08-25",
        endAt: "2026-08-26",
        externalUserId: "gateway-user-1",
        externalCredentialId: "litellm-key-id-1",
        modelId: "gpt-4o",
      }),
    ).resolves.toEqual({
      totalSpendUsd: 3.5,
      records: [
        {
          date: "2026-08-25",
          modelId: "gpt-4o",
          externalUserId: undefined,
          externalCredentialId: undefined,
          spendUsd: 3.5,
          promptTokens: 100,
          completionTokens: 40,
          requests: 2,
        },
      ],
    });
    expect(new URL(request?.url ?? "http://invalid").search).toContain("start_date=2026-08-25");
    expect(new URL(request?.url ?? "http://invalid").search).toContain("user_id=gateway-user-1");
    expect(new URL(request?.url ?? "http://invalid").search).toContain("api_key=litellm-key-id-1");
    expect(new URL(request?.url ?? "http://invalid").search).toContain("model=gpt-4o");
  });

  // 验证新版 LiteLLM 将模型指标和 Key 标识嵌套在 metrics/api_key_breakdown 时，仍能返回真实金额和归属 Key。
  test("uses LiteLLM API key IDs from daily activity directly as credential IDs", async () => {
    const firstKeyId = "litellm-key-id-1";
    const secondKeyId = "litellm-key-id-2";
    const adapter = createLiteLlmAdapter({
      baseUrl: "http://litellm.test",
      adminKey: "master-key",
      managementUiUrl: "http://litellm.test/ui",
      timeoutMs: 1000,
      fetchImpl: async () =>
        Response.json({
          metadata: { total_spend: 5 },
          results: [
            {
              date: "2026-08-27",
              breakdown: {
                models: {
                  "gpt-5": {
                    metrics: {
                      spend: 5,
                      prompt_tokens: 100,
                      completion_tokens: 20,
                      api_requests: 3,
                    },
                    api_key_breakdown: {
                      [firstKeyId]: {
                        metrics: {
                          spend: 2,
                          prompt_tokens: 40,
                          completion_tokens: 8,
                          api_requests: 1,
                        },
                      },
                      [secondKeyId]: {
                        metrics: {
                          spend: 3,
                          prompt_tokens: 60,
                          completion_tokens: 12,
                          api_requests: 2,
                        },
                      },
                    },
                  },
                },
              },
            },
          ],
        }),
    });

    await expect(
      adapter.queryUsage({
        startAt: "2026-08-27",
        endAt: "2026-08-28",
      }),
    ).resolves.toEqual({
      totalSpendUsd: 5,
      records: [
        {
          date: "2026-08-27",
          modelId: "gpt-5",
          externalUserId: undefined,
          externalCredentialId: firstKeyId,
          spendUsd: 2,
          promptTokens: 40,
          completionTokens: 8,
          requests: 1,
        },
        {
          date: "2026-08-27",
          modelId: "gpt-5",
          externalUserId: undefined,
          externalCredentialId: secondKeyId,
          spendUsd: 3,
          promptTokens: 60,
          completionTokens: 12,
          requests: 2,
        },
      ],
    });
  });
});
