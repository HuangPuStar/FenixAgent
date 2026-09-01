import type {
  CreateGatewayCredentialInput,
  EnsureGatewayUserInput,
  GatewayBudget,
  GatewayHealth,
  GatewayModel,
  GatewayUsageQuery,
  ModelGatewayAdapter,
  UpdateGatewayBudgetInput,
} from "@fenix/model-gateway-sdk";
import { createLiteLlmClient, type LiteLlmClientOptions } from "./client";
import {
  buildLiteLlmUsagePath,
  LITELLM_ONE_TIME_BUDGET_DURATION,
  mapLiteLlmBudget,
  mapLiteLlmCredential,
  mapLiteLlmHealth,
  mapLiteLlmModels,
  mapLiteLlmUsage,
  mapLiteLlmUser,
  mapLiteLlmUserBudgetPage,
  mapLiteLlmUserBudgetReset,
} from "./mappers";

export interface CreateLiteLlmAdapterOptions extends LiteLlmClientOptions {
  managementUiUrl: string;
}

export function createLiteLlmAdapter(options: CreateLiteLlmAdapterOptions): ModelGatewayAdapter {
  const client = createLiteLlmClient(options);

  return {
    type: "litellm",
    async checkHealth(): Promise<GatewayHealth> {
      return mapLiteLlmHealth(await client.get<unknown>("/health"));
    },
    async listModels(): Promise<GatewayModel[]> {
      return mapLiteLlmModels(await client.get<unknown>("/model/info"));
    },
    async ensureUser(input: EnsureGatewayUserInput) {
      const userPath = `/user/info?user_id=${encodeURIComponent(input.externalId)}`;
      try {
        return mapLiteLlmUser(await client.get<unknown>(userPath));
      } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "NOT_FOUND") throw error;
        return mapLiteLlmUser(
          await client.post<unknown>("/user/new", {
            user_id: input.externalId,
            ...(input.email ? { user_email: input.email } : {}),
            ...(input.displayName ? { user_alias: input.displayName } : {}),
            user_role: "internal_user",
            auto_create_key: false,
            ...(input.budget?.maxBudgetUsd !== undefined ? { max_budget: input.budget.maxBudgetUsd } : {}),
            ...(input.budget?.duration !== undefined
              ? { budget_duration: input.budget.duration ?? LITELLM_ONE_TIME_BUDGET_DURATION }
              : {}),
          }),
        );
      }
    },
    async getUserBudget(externalUserId: string): Promise<GatewayBudget> {
      return mapLiteLlmBudget(await client.get<unknown>(`/v2/user/info?user_id=${encodeURIComponent(externalUserId)}`));
    },
    async listUserBudgets(externalUserIds?: readonly string[]) {
      const userIds = [...new Set(externalUserIds?.map((id) => id.trim()).filter(Boolean) ?? [])];
      if (externalUserIds && userIds.length === 0) return [];
      const budgets = [];
      const idBatches =
        userIds.length > 0
          ? Array.from({ length: Math.ceil(userIds.length / 100) }, (_, index) =>
              userIds.slice(index * 100, (index + 1) * 100),
            )
          : [undefined];
      for (const ids of idBatches) {
        let page = 1;
        let totalPages = 1;
        do {
          const result = mapLiteLlmUserBudgetPage(
            await client.get<unknown>(
              `/user/list?page=${page}&page_size=100${ids ? `&user_ids=${encodeURIComponent(ids.join(","))}` : ""}`,
            ),
          );
          budgets.push(...result.items);
          totalPages = result.totalPages;
          page += 1;
        } while (page <= totalPages);
      }
      return budgets;
    },
    async updateUserBudget(input: UpdateGatewayBudgetInput): Promise<GatewayBudget> {
      return mapLiteLlmBudget(
        await client.post<unknown>("/user/update", {
          user_id: input.externalUserId,
          max_budget: input.maxBudgetUsd,
          budget_duration: input.duration ?? LITELLM_ONE_TIME_BUDGET_DURATION,
        }),
      );
    },
    async resetUserBudgets(externalUserIds) {
      const userIds = [...new Set(externalUserIds.map((id) => id.trim()).filter(Boolean))];
      if (userIds.length === 0) {
        return { succeededExternalUserIds: [], failed: [] };
      }
      return mapLiteLlmUserBudgetReset(
        await client.post<unknown>("/user/bulk_update", {
          users: userIds.map((user_id) => ({ user_id, spend: 0 })),
        }),
        userIds,
      );
    },
    async createCredential(input: CreateGatewayCredentialInput) {
      return mapLiteLlmCredential(
        await client.post<unknown>("/key/generate", {
          user_id: input.externalUserId,
          ...(input.metadata ? { metadata: input.metadata } : {}),
          key_type: "llm_api",
        }),
      );
    },
    async blockCredential(externalCredentialId: string) {
      await client.post<unknown>("/key/block", { key: externalCredentialId });
    },
    async queryUsage(input: GatewayUsageQuery) {
      return mapLiteLlmUsage(await client.get<unknown>(buildLiteLlmUsagePath(input)));
    },
  };
}
