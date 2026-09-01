import { createLiteLlmAdapter } from "@fenix/model-gateway-litellm";
import { sql } from "drizzle-orm";
import { config } from "../../config";
import { db } from "../../db";
import { agentConfig, member, organization, user } from "../../db/schema";
import { findAgentConfigNamesByIds } from "../../repositories/agent-config";
import {
  deleteModelGatewayCredential,
  findModelGatewayCredentialBySubject,
  findModelGatewayCredentialsByIds,
  listModelGatewayCredentialsAfter,
  listModelGatewayCredentialsPage,
  updateModelGatewayCredentialStatus,
  upsertModelGatewayCredential,
} from "../../repositories/model-gateway-credential";
import { organizationRepo } from "../../repositories/organization";
import { findUsersBasicInfoByIds } from "../../repositories/user";
import { canReadResource } from "../resource-permission";
import { createModelGatewayBudgetService } from "./budget-service";
import { createModelGatewayCredentialCipher } from "./credential-cipher";
import { createModelGatewayCredentialService } from "./credential-service";
import { type ModelGatewayServices, setModelGatewayServices } from "./index";
import { createModelGatewayKeyManagementService } from "./key-management-service";
import { createSystemModelGatewayProviderService } from "./provider-service";
import { createModelGatewayRuntimeCredentialResolver } from "./runtime-credential-resolver";
import { createModelGatewaySubjectService } from "./subject-service";
import { createModelGatewayUsageMappingLister } from "./usage-mapping-service";
import { createModelGatewayUsageService, type UsageCredentialMapping } from "./usage-service";

/**
 * 创建并装配一期模型网关运行时。
 *
 * 未配置管理凭证或本地加密密钥时只保留 Provider 初始化能力，Agent 动态
 * Key 和管理操作会明确失败，避免用空凭证启动或把密钥明文落库。
 */
export function createModelGatewayRuntime() {
  if (!config.modelGatewayAdminKey || !config.modelGatewayCredentialEncryptionKey) return null;

  const adapter = createLiteLlmAdapter({
    baseUrl: config.modelGatewayBaseUrl,
    adminKey: config.modelGatewayAdminKey,
    managementUiUrl: config.modelGatewayAdminUiUrl,
    timeoutMs: 10_000,
  });
  const providerService = createSystemModelGatewayProviderService(
    { adapter },
    {
      // Provider 会被 Agent 使用，使用对沙盒可达的公开地址。
      baseUrl: config.modelGatewayPublicBaseUrl,
      gatewayType: config.modelGatewayType,
    },
  );
  const cipher = createModelGatewayCredentialCipher(config.modelGatewayCredentialEncryptionKey);
  const credential = createModelGatewayCredentialService({
    adapter,
    cipher,
    defaultBudget:
      config.modelGatewayDefaultUserBudgetUsd === undefined
        ? undefined
        : {
            maxBudgetUsd: config.modelGatewayDefaultUserBudgetUsd,
            duration: config.modelGatewayDefaultBudgetDuration ?? null,
          },
    ensureSubject: async (input) => {
      const rows = await db
        .select({ id: member.id })
        .from(member)
        .where(sql`${member.organizationId} = ${input.organizationId} AND ${member.userId} = ${input.userId}`)
        .limit(1);
      if (!rows[0]) throw new Error("user is not a member of the requested organization");
      const readable = await canReadResource(
        { organizationId: input.organizationId, userId: input.userId, role: "member" },
        "agent_config",
        input.agentConfigId,
        input.organizationId,
      );
      if (!readable) throw new Error("user cannot access the requested agent");
    },
    findMapping: findModelGatewayCredentialBySubject,
    upsertMapping: upsertModelGatewayCredential,
    updateStatus: updateModelGatewayCredentialStatus,
  });
  const defaultBudget =
    config.modelGatewayDefaultUserBudgetUsd === undefined
      ? undefined
      : {
          maxBudgetUsd: config.modelGatewayDefaultUserBudgetUsd,
          duration: config.modelGatewayDefaultBudgetDuration ?? null,
        };
  const budget = createModelGatewayBudgetService({ adapter, defaultBudget });
  const subject = createModelGatewaySubjectService();
  const usageMappingLister = createModelGatewayUsageMappingLister({
    listCredentials: listModelGatewayCredentialsAfter,
  });
  const listMappings = async (gatewayProviderId: string): Promise<UsageCredentialMapping[]> => {
    const rows = await usageMappingLister.listMappings(gatewayProviderId);
    const organizationIds = [...new Set(rows.map((row) => row.organizationId))];
    const userIds = [...new Set(rows.map((row) => row.userId))];
    const agentIds = [...new Set(rows.map((row) => row.agentConfigId))];
    const [organizationNames, users, agentNames] = await Promise.all([
      organizationRepo.listNamesByIds(organizationIds),
      findUsersBasicInfoByIds(userIds),
      findAgentConfigNamesByIds(agentIds),
    ]);
    const usersById = new Map(users.map((row) => [row.id, row]));
    return rows.map((row) => ({
      externalCredentialId: row.externalCredentialId,
      organizationId: row.organizationId,
      organizationName: organizationNames.get(row.organizationId) ?? null,
      userId: row.userId,
      userName: usersById.get(row.userId)?.name ?? null,
      userEmail: usersById.get(row.userId)?.email ?? null,
      agentConfigId: row.agentConfigId,
      agentName: agentNames.get(row.agentConfigId) ?? null,
    }));
  };
  const usage = createModelGatewayUsageService({ adapter, listCredentialMappings: listMappings });
  const listManagedKeyMappings = async (input: { gatewayProviderId: string; page: number; pageSize: number }) => {
    const result = await listModelGatewayCredentialsPage(input);
    const [organizationNames, users, agentNames] = await Promise.all([
      organizationRepo.listNamesByIds([...new Set(result.items.map((item) => item.organizationId))]),
      findUsersBasicInfoByIds([...new Set(result.items.map((item) => item.userId))]),
      findAgentConfigNamesByIds([...new Set(result.items.map((item) => item.agentConfigId))]),
    ]);
    const usersById = new Map(users.map((item) => [item.id, item]));
    return {
      ...result,
      items: result.items.map((item) => ({
        ...item,
        organizationName: organizationNames.get(item.organizationId) ?? null,
        userName: usersById.get(item.userId)?.name ?? null,
        agentName: agentNames.get(item.agentConfigId) ?? null,
      })),
    };
  };
  const evaluateCredentialSubject = async (mapping: {
    organizationId: string;
    userId: string;
    agentConfigId: string;
  }) => {
    const [userRow] = await db.select({ id: user.id }).from(user).where(sql`${user.id} = ${mapping.userId}`).limit(1);
    if (!userRow) return { valid: false as const, reason: "USER_NOT_FOUND" as const };
    const [orgRow] = await db
      .select({ id: organization.id })
      .from(organization)
      .where(sql`${organization.id} = ${mapping.organizationId}`)
      .limit(1);
    if (!orgRow) return { valid: false as const, reason: "ORGANIZATION_NOT_FOUND" as const };
    const [memberRow] = await db
      .select({ id: member.id })
      .from(member)
      .where(sql`${member.organizationId} = ${mapping.organizationId} AND ${member.userId} = ${mapping.userId}`)
      .limit(1);
    if (!memberRow) return { valid: false as const, reason: "MEMBERSHIP_NOT_FOUND" as const };
    const [agentRow] = await db
      .select({ id: agentConfig.id })
      .from(agentConfig)
      .where(
        sql`${agentConfig.id} = ${mapping.agentConfigId} AND ${agentConfig.organizationId} = ${mapping.organizationId}`,
      )
      .limit(1);
    if (!agentRow) return { valid: false as const, reason: "AGENT_NOT_FOUND" as const };
    const readable = await canReadResource(
      { organizationId: mapping.organizationId, userId: mapping.userId, role: "member" },
      "agent_config",
      mapping.agentConfigId,
      mapping.organizationId,
    );
    return readable ? { valid: true as const } : { valid: false as const, reason: "AGENT_ACCESS_REVOKED" as const };
  };
  const keyManagement = createModelGatewayKeyManagementService({
    listMappings: listManagedKeyMappings,
    findMappingsByIds: findModelGatewayCredentialsByIds,
    evaluateSubject: evaluateCredentialSubject,
    blockCredential: (externalCredentialId) => adapter.blockCredential(externalCredentialId),
    deleteMapping: deleteModelGatewayCredential,
  });
  const services = { provider: providerService, budget, subject, usage, keyManagement } as ModelGatewayServices;
  setModelGatewayServices(services);
  const resolveRuntimeCredential = createModelGatewayRuntimeCredentialResolver({
    getUserBudget: budget.getUserBudget,
    resolveCredential: credential.resolveCredential,
  });

  return { services, credential, resolveRuntimeCredential };
}
