import type { EnsureGatewayUserInput, GatewayBudgetConfig, ModelGatewayAdapter } from "@fenix/model-gateway-sdk";
import type {
  ModelGatewayCredential,
  ModelGatewayCredentialSubject,
  UpsertModelGatewayCredentialInput,
} from "../../repositories/model-gateway-credential";
import type { ModelGatewayCredentialCipher } from "./credential-cipher";

export interface ResolveModelGatewayCredentialInput extends ModelGatewayCredentialSubject {
  email?: string;
  displayName?: string;
}

export interface ResolvedModelGatewayCredential {
  internalUserId: string;
  externalCredentialId: string;
  secret: string;
}

export interface ModelGatewayCredentialServiceDeps {
  adapter: ModelGatewayAdapter;
  cipher: Pick<ModelGatewayCredentialCipher, "encrypt" | "decrypt">;
  defaultBudget?: GatewayBudgetConfig;
  ensureSubject: (input: ResolveModelGatewayCredentialInput) => Promise<void>;
  findMapping: (subject: ModelGatewayCredentialSubject) => Promise<ModelGatewayCredential | null>;
  upsertMapping: (input: UpsertModelGatewayCredentialInput) => Promise<ModelGatewayCredential>;
  updateStatus: (id: string, status: "active" | "blocked" | "error") => Promise<unknown>;
}

/**
 * 将 Fenix 用户映射为 LiteLLM Internal User ID。
 *
 * 预算在 Gateway Provider 内按用户全局共享，因此组织和 Agent 不参与 ID。
 */
function stableInternalUserId(_gatewayProviderId: string, userId: string): string {
  return `fenix-${userId}`;
}

/**
 * 管理模型网关用户和 Agent 级 Virtual Key 的懒创建。
 *
 * Fenix 只保存加密后的密钥映射；明文只在返回值中短暂存在，供 LaunchSpec
 * 构建器写入当前 Agent 进程环境。相同四元主体在进程内串行化，跨实例竞态
 * 由数据库唯一约束和未采用 Key 的 block 补偿收敛。
 */
export function createModelGatewayCredentialService(deps: ModelGatewayCredentialServiceDeps) {
  const inFlight = new Map<string, Promise<ResolvedModelGatewayCredential>>();

  async function resolveCredential(input: ResolveModelGatewayCredentialInput): Promise<ResolvedModelGatewayCredential> {
    const lockKey = [input.gatewayProviderId, input.organizationId, input.userId, input.agentConfigId].join(":");
    const existingTask = inFlight.get(lockKey);
    if (existingTask) return existingTask;
    const task = resolveCredentialInternal(input);
    inFlight.set(lockKey, task);
    try {
      return await task;
    } finally {
      if (inFlight.get(lockKey) === task) inFlight.delete(lockKey);
    }
  }

  async function resolveCredentialInternal(
    input: ResolveModelGatewayCredentialInput,
  ): Promise<ResolvedModelGatewayCredential> {
    await deps.ensureSubject(input);
    const internalUserId = stableInternalUserId(input.gatewayProviderId, input.userId);
    const userInput: EnsureGatewayUserInput = {
      externalId: internalUserId,
      email: input.email,
      displayName: input.displayName,
      budget: deps.defaultBudget,
    };
    await deps.adapter.ensureUser(userInput);

    const subject: ModelGatewayCredentialSubject = {
      gatewayProviderId: input.gatewayProviderId,
      organizationId: input.organizationId,
      userId: input.userId,
      agentConfigId: input.agentConfigId,
    };
    const current = await deps.findMapping(subject);
    if (current?.status === "active" && current.encryptedCredential) {
      const secret = deps.cipher.decrypt(current.encryptedCredential);
      return { internalUserId, externalCredentialId: current.externalCredentialId, secret };
    }

    const created = await deps.adapter.createCredential({
      externalUserId: internalUserId,
      keyAlias: `fenix:${input.organizationId}:${input.userId}:${input.agentConfigId}`,
      metadata: {
        fenix_gateway_provider_id: input.gatewayProviderId,
        fenix_organization_id: input.organizationId,
        fenix_user_id: input.userId,
        fenix_agent_config_id: input.agentConfigId,
      },
    });
    try {
      const mapping = await deps.upsertMapping({
        ...subject,
        externalCredentialId: created.externalId,
        encryptedCredential: deps.cipher.encrypt(created.secret),
        status: "active",
        metadata: {
          fenix_gateway_provider_id: input.gatewayProviderId,
          fenix_organization_id: input.organizationId,
          fenix_user_id: input.userId,
          fenix_agent_config_id: input.agentConfigId,
        },
      });
      if (mapping.externalCredentialId !== created.externalId) {
        await deps.adapter.blockCredential(created.externalId);
        if (mapping.status !== "active" || !mapping.encryptedCredential) {
          throw new Error("existing model gateway credential is unavailable");
        }
        return {
          internalUserId,
          externalCredentialId: mapping.externalCredentialId,
          secret: deps.cipher.decrypt(mapping.encryptedCredential),
        };
      }
      return {
        internalUserId,
        externalCredentialId: created.externalId,
        secret: created.secret,
      };
    } catch (error) {
      await deps.adapter.blockCredential(created.externalId).catch(() => undefined);
      throw error;
    }
  }

  return { resolveCredential, stableInternalUserId };
}

export { stableInternalUserId };
