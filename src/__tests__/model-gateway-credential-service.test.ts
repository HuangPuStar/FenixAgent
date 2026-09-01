import { describe, expect, test } from "bun:test";
import type {
  CreateGatewayCredentialInput,
  GatewayCredentialSecret,
  ModelGatewayAdapter,
} from "@fenix/model-gateway-sdk";
import type {
  ModelGatewayCredentialSubject,
  UpsertModelGatewayCredentialInput,
} from "../repositories/model-gateway-credential";
import {
  createModelGatewayCredentialService,
  type ModelGatewayCredentialServiceDeps,
} from "../services/model-gateway/credential-service";

function createAdapter(
  created: GatewayCredentialSecret[] = [],
  credentialInputs: CreateGatewayCredentialInput[] = [],
): ModelGatewayAdapter {
  return {
    type: "litellm",
    checkHealth: async () => ({ status: "healthy" }),
    listModels: async () => [],
    ensureUser: async (input) => ({
      externalId: input.externalId,
      email: input.email,
    }),
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
    createCredential: async (input) => {
      credentialInputs.push(input);
      return created.shift() ?? { externalId: "key-1", secret: "secret-1" };
    },
    blockCredential: async () => {},
    queryUsage: async () => ({ totalSpendUsd: 0, records: [] }),
  };
}

function createFixture() {
  const mappings = new Map<
    string,
    {
      id: string;
      externalCredentialId: string;
      encryptedCredential: string | null;
      status: "active" | "blocked" | "error";
    }
  >();
  const calls: string[] = [];
  const credentialInputs: CreateGatewayCredentialInput[] = [];
  const adapter = createAdapter([], credentialInputs);
  const service = createModelGatewayCredentialService({
    adapter,
    defaultBudget: { maxBudgetUsd: 20, duration: "30d" },
    cipher: {
      encrypt: (value: string) => `encrypted:${value}`,
      decrypt: (value: string) => value.replace("encrypted:", ""),
    },
    ensureSubject: async () => {},
    findMapping: async (subject: ModelGatewayCredentialSubject) => mappings.get(JSON.stringify(subject)) ?? null,
    upsertMapping: async (input: UpsertModelGatewayCredentialInput) => {
      const key = JSON.stringify({
        gatewayProviderId: input.gatewayProviderId,
        organizationId: input.organizationId,
        userId: input.userId,
        agentConfigId: input.agentConfigId,
      });
      const existing = mappings.get(key);
      if (existing) return existing;
      const mapping = {
        id: `mapping-${mappings.size + 1}`,
        externalCredentialId: input.externalCredentialId,
        encryptedCredential: input.encryptedCredential ?? null,
        status: input.status ?? "active",
      };
      mappings.set(key, mapping);
      return mapping;
    },
    updateStatus: async (id: string, status: "active" | "blocked" | "error") => {
      for (const mapping of mappings.values()) {
        if (mapping.id === id) mapping.status = status;
      }
    },
  } as unknown as ModelGatewayCredentialServiceDeps);
  return { service, mappings, calls, credentialInputs, adapter };
}

describe("model gateway credential service", () => {
  // 验证首次使用时创建稳定 Internal User、Virtual Key，并写入默认预算快照。
  test("使用 Gateway Provider 和用户生成稳定 Internal User ID，并在首次创建时快照默认预算", async () => {
    const { service, credentialInputs } = createFixture();

    const first = await service.resolveCredential({
      gatewayProviderId: "gateway-1",
      organizationId: "org-1",
      userId: "user-1",
      agentConfigId: "agent-1",
      email: "user@example.com",
    });
    const second = await service.resolveCredential({
      gatewayProviderId: "gateway-1",
      organizationId: "org-2",
      userId: "user-1",
      agentConfigId: "agent-2",
    });

    expect(first.internalUserId).toBe(second.internalUserId);
    expect(first.internalUserId).toBe("fenix-user-1");
    expect(credentialInputs[0]?.metadata).toMatchObject({
      fenix_organization_id: "org-1",
      fenix_user_id: "user-1",
      fenix_agent_config_id: "agent-1",
    });
    expect(first.secret).toBe("secret-1");
  });

  // 验证同一主体组合复用已有 Key，不因 Agent 选择的模型发起远端 Key 更新。
  test("同一四元主体复用已有 Key", async () => {
    const { service, calls } = createFixture();
    const input = {
      gatewayProviderId: "gateway-1",
      organizationId: "org-1",
      userId: "user-1",
      agentConfigId: "agent-1",
    };

    const first = await service.resolveCredential(input);
    const second = await service.resolveCredential(input);

    expect(second.secret).toBe(first.secret);
    expect(calls).toEqual([]);
  });

  // 验证并发首次请求最终只保留一个本地映射，并清理竞态产生的远端 Key。
  test("并发首次创建只采用一个 Key，未采用的远端 Key 会被禁用", async () => {
    const { service, calls, adapter } = createFixture();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let creates = 0;
    adapter.createCredential = async () => {
      creates += 1;
      await gate;
      return { externalId: `key-${creates}`, secret: `secret-${creates}` };
    };

    const input = {
      gatewayProviderId: "gateway-1",
      organizationId: "org-1",
      userId: "user-1",
      agentConfigId: "agent-1",
    };
    const firstPromise = service.resolveCredential(input);
    const secondPromise = service.resolveCredential(input);
    release?.();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.secret).toBe(second.secret);
    expect(creates).toBe(1);
    expect(calls).toEqual([]);
  });

  // 验证本地落库失败时，已创建的远端 Key 会执行尽力而为的禁用补偿。
  test("远端 Key 已创建但本地映射失败时执行禁用补偿", async () => {
    const { calls } = createFixture();
    const failingService = createModelGatewayCredentialService({
      adapter: {
        ...createAdapter(),
        blockCredential: async (externalCredentialId) => {
          calls.push(`block:${externalCredentialId}`);
        },
      },
      cipher: {
        encrypt: (value: string) => `encrypted:${value}`,
        decrypt: (value: string) => value.replace("encrypted:", ""),
      },
      defaultBudget: { maxBudgetUsd: 20, duration: "30d" },
      ensureSubject: async () => {},
      findMapping: async () => null,
      upsertMapping: async () => {
        throw new Error("local mapping failed");
      },
      updateStatus: async () => {},
    });

    await expect(
      failingService.resolveCredential({
        gatewayProviderId: "gateway-1",
        organizationId: "org-1",
        userId: "user-1",
        agentConfigId: "agent-1",
      }),
    ).rejects.toThrow("local mapping failed");
    expect(calls).toEqual(["block:key-1"]);
  });
});
