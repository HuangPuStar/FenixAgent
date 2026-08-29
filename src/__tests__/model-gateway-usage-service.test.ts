import { describe, expect, test } from "bun:test";
import type { ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import { createModelGatewayUsageService } from "../services/model-gateway/usage-service";

function createAdapter(): ModelGatewayAdapter {
  return {
    type: "litellm",
    checkHealth: async () => ({ status: "healthy" }),
    listModels: async () => [],
    ensureUser: async () => ({ externalId: "user" }),
    getUserBudget: async () => ({
      maxBudgetUsd: null,
      duration: null,
      spendUsd: 0,
      resetAt: null,
    }),
    listUserBudgets: async () => [],
    updateUserBudget: async () => ({
      maxBudgetUsd: 10,
      duration: null,
      spendUsd: 0,
      resetAt: null,
    }),
    createCredential: async () => ({ externalId: "key", secret: "secret" }),
    blockCredential: async () => {},
    queryUsage: async () => ({
      totalSpendUsd: 999,
      records: [
        {
          date: "2026-08-01",
          modelId: "gpt",
          externalCredentialId: "key-1",
          spendUsd: 2,
          promptTokens: 10,
          completionTokens: 5,
          requests: 1,
        },
        {
          date: "2026-08-01",
          modelId: "other",
          externalCredentialId: "key-1",
          spendUsd: 3,
          promptTokens: 20,
          completionTokens: 5,
          requests: 2,
        },
      ],
    }),
  };
}

function createKeyScopedAdapter(calls: string[]): ModelGatewayAdapter {
  return {
    ...createAdapter(),
    queryUsage: async (query) => {
      calls.push(query.externalCredentialId ?? "global");
      return {
        totalSpendUsd: 1,
        records: [
          {
            date: "2026-08-01",
            modelId: "gpt",
            spendUsd: 1,
            promptTokens: 2,
            completionTokens: 3,
            requests: 1,
          },
        ],
      };
    },
  };
}

describe("model gateway usage service", () => {
  // 默认查询只返回原始记录和轻量摘要，避免概览页构造不需要的多维聚合数组。
  test("默认查询不返回多维聚合结果", async () => {
    const service = createModelGatewayUsageService({
      adapter: createAdapter(),
      listCredentialMappings: async () => [
        {
          externalCredentialId: "key-1",
          organizationId: "org-1",
          organizationName: "研发部",
          userId: "user-1",
          userName: "测试用户",
          userEmail: "test@example.com",
          agentConfigId: "agent-1",
          agentName: "代码助手",
        },
      ],
    });

    const result = await service.queryUsage({
      gatewayProviderId: "gateway-1",
      startAt: "2026-08-01",
      endAt: "2026-08-02",
    });

    expect(result.totalSpendUsd).toBe(5);
    expect(result.records).toHaveLength(2);
    expect(result.activeUserCount).toBe(1);
    expect(result).not.toHaveProperty("byModel");
    expect(result).not.toHaveProperty("byOrganization");
    expect(result).not.toHaveProperty("byUser");
    expect(result).not.toHaveProperty("byAgent");
  });

  test("按模型筛选并按消耗金额降序返回聚合明细", async () => {
    const service = createModelGatewayUsageService({
      adapter: createAdapter(),
      listCredentialMappings: async () => [
        {
          externalCredentialId: "key-1",
          organizationId: "org-1",
          organizationName: "研发部",
          userId: "user-1",
          userName: "测试用户",
          userEmail: "test@example.com",
          agentConfigId: "agent-1",
          agentName: "代码助手",
        },
      ],
    });

    const result = await service.queryUsage({
      gatewayProviderId: "gateway-1",
      startAt: "2026-08-01",
      endAt: "2026-08-02",
      organizationId: "org-1",
      agentConfigId: "agent-1",
      includeBreakdowns: true,
    });

    expect(result.totalSpendUsd).toBe(5);
    expect(result.byModel).toEqual([
      {
        modelId: "other",
        spendUsd: 3,
        requests: 2,
        promptTokens: 20,
        completionTokens: 5,
      },
      {
        modelId: "gpt",
        spendUsd: 2,
        requests: 1,
        promptTokens: 10,
        completionTokens: 5,
      },
    ]);
    expect(result.byAgent).toEqual([
      { agentConfigId: "agent-1", organizationName: "研发部", agentName: "代码助手", spendUsd: 5, requests: 3 },
    ]);
    expect(result.byOrganization).toEqual([
      { organizationId: "org-1", organizationName: "研发部", spendUsd: 5, requests: 3 },
    ]);
    expect(result.byUser).toEqual([
      { userId: "user-1", userName: "测试用户", userEmail: "test@example.com", spendUsd: 5, requests: 3 },
    ]);
  });

  // 日期范围使用首尾包含的 UTC 自然日，且拒绝旧的 ISO 时间戳输入。
  test("拒绝超过 90 天、ISO 时间戳或倒序日期范围", async () => {
    const service = createModelGatewayUsageService({
      adapter: createAdapter(),
      listCredentialMappings: async () => [],
    });
    await expect(
      service.queryUsage({
        gatewayProviderId: "gateway",
        startAt: "2026-01-01",
        endAt: "2026-04-02",
      }),
    ).rejects.toThrow("90 days");
    await expect(
      service.queryUsage({
        gatewayProviderId: "gateway",
        startAt: "2026-08-02",
        endAt: "2026-08-01",
      }),
    ).rejects.toThrow("not be after");
    await expect(
      service.queryUsage({
        gatewayProviderId: "gateway",
        startAt: "2026-08-01T00:00:00.000Z",
        endAt: "2026-08-02T00:00:00.000Z",
      }),
    ).rejects.toThrow("YYYY-MM-DD");
  });

  // 当前 Provider 没有任何凭证映射时，不得查询或汇入 LiteLLM 实例上的其他 Key 用量。
  test("没有凭证映射时返回空聚合且不查询 LiteLLM", async () => {
    let queryCount = 0;
    const service = createModelGatewayUsageService({
      adapter: {
        ...createAdapter(),
        queryUsage: async () => {
          queryCount += 1;
          return {
            totalSpendUsd: 9,
            records: [],
          };
        },
      },
      listCredentialMappings: async () => [],
    });

    const result = await service.queryUsage({
      gatewayProviderId: "gateway-1",
      startAt: "2026-08-01",
      endAt: "2026-08-02",
      includeBreakdowns: true,
    });

    expect(queryCount).toBe(0);
    expect(result).toEqual({
      totalSpendUsd: 0,
      records: [],
      activeUserCount: 0,
      byModel: [],
      byOrganization: [],
      byUser: [],
      byAgent: [],
    });
  });

  test("LiteLLM 不返回 key 标识时按筛选映射逐 key 查询并归因", async () => {
    const calls: string[] = [];
    const service = createModelGatewayUsageService({
      adapter: createKeyScopedAdapter(calls),
      listCredentialMappings: async () => [
        {
          externalCredentialId: "key-1",
          organizationId: "org-1",
          userId: "user-1",
          agentConfigId: "agent-1",
        },
        {
          externalCredentialId: "key-2",
          organizationId: "org-2",
          userId: "user-2",
          agentConfigId: "agent-2",
        },
      ],
    });

    const result = await service.queryUsage({
      gatewayProviderId: "gateway-1",
      startAt: "2026-08-01",
      endAt: "2026-08-02",
      organizationId: "org-2",
      includeBreakdowns: true,
    });

    expect(calls).toEqual(["key-2"]);
    expect(result.totalSpendUsd).toBe(1);
    expect(result.byAgent).toEqual([
      { agentConfigId: "agent-2", organizationName: null, agentName: null, spendUsd: 1, requests: 1 },
    ]);
  });

  // 主体筛选保留逐 Key 查询时，每批最多并发三个请求，避免瞬间打满 LiteLLM。
  test("主体筛选按每批三个 Key 查询 LiteLLM", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const service = createModelGatewayUsageService({
      adapter: {
        ...createAdapter(),
        queryUsage: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 1));
          inFlight -= 1;
          return {
            totalSpendUsd: 1,
            records: [
              {
                date: "2026-08-01",
                modelId: "gpt",
                spendUsd: 1,
                promptTokens: 1,
                completionTokens: 1,
                requests: 1,
              },
            ],
          };
        },
      },
      listCredentialMappings: async () =>
        Array.from({ length: 7 }, (_, index) => ({
          externalCredentialId: `key-${index}`,
          organizationId: "org-1",
          userId: `user-${index}`,
          agentConfigId: `agent-${index}`,
        })),
    });

    const result = await service.queryUsage({
      gatewayProviderId: "gateway-1",
      startAt: "2026-08-01",
      endAt: "2026-08-02",
      organizationId: "org-1",
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(result.totalSpendUsd).toBe(7);
  });

  // 验证 Adapter 已将网关返回的 Key 标识归一后，服务只按 Fenix 凭证 ID 过滤并归因。
  test("全局查询按 Adapter 归一后的 Key 过滤并归因", async () => {
    const service = createModelGatewayUsageService({
      adapter: {
        ...createAdapter(),
        queryUsage: async () => ({
          totalSpendUsd: 15,
          records: [
            {
              date: "2026-08-01",
              modelId: "gpt",
              externalCredentialId: "key-1",
              spendUsd: 2,
              promptTokens: 10,
              completionTokens: 5,
              requests: 1,
            },
            {
              date: "2026-08-01",
              modelId: "other",
              externalCredentialId: "hash:foreign-key",
              spendUsd: 13,
              promptTokens: 20,
              completionTokens: 5,
              requests: 2,
            },
          ],
        }),
      },
      listCredentialMappings: async () => [
        {
          externalCredentialId: "key-1",
          organizationId: "org-1",
          userId: "user-1",
          agentConfigId: "agent-1",
        },
      ],
    });

    const result = await service.queryUsage({
      gatewayProviderId: "gateway-1",
      startAt: "2026-08-01",
      endAt: "2026-08-02",
      includeBreakdowns: true,
    });

    expect(result.totalSpendUsd).toBe(2);
    expect(result.byUser).toEqual([{ userId: "user-1", userName: null, userEmail: null, spendUsd: 2, requests: 1 }]);
  });
});
