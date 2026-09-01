export { createModelGatewayAdapterRegistry } from "./adapter-registry";
export { type BudgetUpdateResult, createModelGatewayBudgetService } from "./budget-service";
export { createModelGatewayCredentialCipher } from "./credential-cipher";
export {
  createModelGatewayCredentialService,
  type ModelGatewayCredentialServiceDeps,
  type ResolvedModelGatewayCredential,
  type ResolveModelGatewayCredentialInput,
  stableInternalUserId,
} from "./credential-service";
export { type CredentialInvalidReason, createModelGatewayKeyManagementService } from "./key-management-service";
export {
  createModelGatewaySubjectService,
  type ModelGatewaySubjectAgent,
  type SubjectSearchInput,
} from "./subject-service";
export { type AggregatedUsage, createModelGatewayUsageService, type UsageQueryInput } from "./usage-service";

import type { createModelGatewayBudgetService } from "./budget-service";
import type { createModelGatewayKeyManagementService } from "./key-management-service";
import type { createSystemModelGatewayProviderService } from "./provider-service";
import type { createModelGatewaySubjectService } from "./subject-service";
import type { createModelGatewayUsageService } from "./usage-service";

export type ModelGatewayServices = {
  provider: ReturnType<typeof createSystemModelGatewayProviderService>;
  budget: ReturnType<typeof createModelGatewayBudgetService>;
  subject: ReturnType<typeof createModelGatewaySubjectService>;
  usage: ReturnType<typeof createModelGatewayUsageService>;
  keyManagement: ReturnType<typeof createModelGatewayKeyManagementService>;
};

let services: ModelGatewayServices | null = null;

/** 由宿主启动流程注入具体 Adapter 和业务服务，路由只依赖稳定服务面。 */
export function setModelGatewayServices(value: ModelGatewayServices | null): void {
  services = value;
}

export function getModelGatewayServices(): ModelGatewayServices {
  if (!services) throw new Error("model gateway services are not configured");
  return services;
}
export {
  createSystemModelGatewayProviderService,
  type ModelGatewayModelSyncDeps,
  type ModelSyncChange,
  type ModelSyncCheckResult,
  type ModelSyncResult,
  SYSTEM_MODEL_GATEWAY_PROVIDER_NAME,
  type SystemModelGatewayProviderOptions,
} from "./provider-service";
