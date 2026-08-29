import type { ModelGatewayCredentialStatus } from "../../repositories/model-gateway-credential";

const USAGE_MAPPING_BATCH_SIZE = 500;
const USAGE_MAPPING_STATUSES: ModelGatewayCredentialStatus[] = ["active", "blocked", "error"];

export interface ListUsageCredentialMappingsInput {
  gatewayProviderId: string;
  afterId?: string;
  limit: number;
  statuses: ModelGatewayCredentialStatus[];
}

export interface ModelGatewayUsageMappingListerDeps<T extends { id: string }> {
  listCredentials: (input: ListUsageCredentialMappingsInput) => Promise<T[]>;
  batchSize?: number;
}

/** 分页读取一个 Gateway Provider 的全部凭证映射，供用量归因使用。 */
export function createModelGatewayUsageMappingLister<T extends { id: string }>(
  deps: ModelGatewayUsageMappingListerDeps<T>,
) {
  const batchSize = deps.batchSize ?? USAGE_MAPPING_BATCH_SIZE;

  async function listMappings(gatewayProviderId: string): Promise<T[]> {
    const mappings: T[] = [];
    let afterId: string | undefined;
    while (true) {
      const page = await deps.listCredentials({
        gatewayProviderId,
        ...(afterId ? { afterId } : {}),
        limit: batchSize,
        statuses: USAGE_MAPPING_STATUSES,
      });
      mappings.push(...page);
      if (page.length < batchSize) return mappings;
      afterId = page.at(-1)?.id;
      if (!afterId) return mappings;
    }
  }

  return { listMappings };
}
