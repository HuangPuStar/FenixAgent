import { findAgentConfigNamesByIds } from "@fenix/agent-config/server";
import { createLiteLlmAdapter } from "@fenix/model-gateway-litellm";
import { getIdentityDirectory } from "@fenix/platform-sdk/server";
import { config } from "@server/config";
import { SUBJECT_REJECTION_MESSAGES, type SubjectVerificationPort } from "../ports/subject-verification";
import {
  deleteModelGatewayCredential,
  findModelGatewayCredentialBySubject,
  findModelGatewayCredentialsByIds,
  listModelGatewayCredentialsAfter,
  listModelGatewayCredentialsPage,
  updateModelGatewayCredentialStatus,
  upsertModelGatewayCredential,
} from "../repositories/model-gateway-credential";
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
 * 运行时装配依赖。
 *
 * `subjectVerification` 由宿主注入：本包不依赖 `@fenix/identity` / `access-control` 的具体实现，也不
 * 依赖 `agent-config` 的资源定义，签发凭据前的"主体还能不能用这个 Agent"判定统一走宿主实现的
 * `agent_config` 真实授权路径（见 `../ports/subject-verification` 的取舍说明）。
 */
export interface ModelGatewayRuntimeDeps {
  readonly subjectVerification: SubjectVerificationPort;
}

/**
 * 创建并装配一期模型网关运行时。
 *
 * 未配置管理凭证或本地加密密钥时只保留 Provider 初始化能力，Agent 动态
 * Key 和管理操作会明确失败，避免用空凭证启动或把密钥明文落库。
 */
export function createModelGatewayRuntime(deps: ModelGatewayRuntimeDeps) {
  if (!config.modelGatewayAdminKey || !config.modelGatewayCredentialEncryptionKey) return null;
  const subjectVerification = deps.subjectVerification;

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
      const verdict = await subjectVerification.verify({
        organizationId: input.organizationId,
        userId: input.userId,
        agentConfigId: input.agentConfigId,
      });
      if (!verdict.valid) throw new Error(SUBJECT_REJECTION_MESSAGES[verdict.reason]);
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
    const [organizationNames, usersById, agentNames] = await Promise.all([
      getIdentityDirectory().listOrganizationNames(organizationIds),
      getIdentityDirectory().listUserDisplayInfo(userIds),
      findAgentConfigNamesByIds(agentIds),
    ]);
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
    const [organizationNames, usersById, agentNames] = await Promise.all([
      getIdentityDirectory().listOrganizationNames([...new Set(result.items.map((item) => item.organizationId))]),
      getIdentityDirectory().listUserDisplayInfo([...new Set(result.items.map((item) => item.userId))]),
      findAgentConfigNamesByIds([...new Set(result.items.map((item) => item.agentConfigId))]),
    ]);
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
  /**
   * 凭据吊销检测的主体判定；与签发路径共用同一端口，因此"签发时可用 + 吊销时可用"恒等价。
   *
   * 迁移前这里自己拼了 4 步存在性查询 + 一次恒真的读权限检查（`role: "member"` 硬编码，且不含角色
   * 与公开性语义），与签发路径的判定并不一致——同一主体可能在签发时被拒、在吊销时被判为有效。
   */
  const evaluateCredentialSubject = (mapping: { organizationId: string; userId: string; agentConfigId: string }) =>
    subjectVerification.verify(mapping);
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
