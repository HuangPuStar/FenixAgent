import { ModelGatewayError } from "@fenix/model-gateway-sdk";

export type CredentialInvalidReason =
  | "USER_NOT_FOUND"
  | "ORGANIZATION_NOT_FOUND"
  | "MEMBERSHIP_NOT_FOUND"
  | "AGENT_NOT_FOUND"
  | "AGENT_ACCESS_REVOKED"
  | "CREDENTIAL_UNUSABLE";

export interface ManagedModelGatewayCredential {
  id: string;
  externalCredentialId: string;
  status: "active" | "blocked" | "error";
  encryptedCredential: string | null;
  organizationId: string;
  userId: string;
  agentConfigId: string;
  createdAt: Date;
  updatedAt: Date;
  organizationName?: string | null;
  userName?: string | null;
  agentName?: string | null;
}

export interface ModelGatewayKeyManagementServiceDeps<T extends ManagedModelGatewayCredential> {
  listMappings: (input: {
    gatewayProviderId: string;
    page: number;
    pageSize: number;
  }) => Promise<{ items: T[]; total: number }>;
  findMappingsByIds: (ids: string[]) => Promise<T[]>;
  evaluateSubject: (mapping: T) => Promise<{ valid: true } | { valid: false; reason: CredentialInvalidReason }>;
  blockCredential: (externalCredentialId: string) => Promise<void>;
  deleteMapping: (id: string) => Promise<void>;
}

/**
 * 为系统管理页实时评估 Fenix 管理的 Virtual Key，并在人工确认后回收所选 Key。
 */
export function createModelGatewayKeyManagementService<T extends ManagedModelGatewayCredential>(
  deps: ModelGatewayKeyManagementServiceDeps<T>,
) {
  async function listKeys(input: { gatewayProviderId: string; page: number; pageSize: number }) {
    const result = await deps.listMappings(input);
    return {
      items: await Promise.all(
        result.items.map(async (mapping) => {
          const { encryptedCredential: _encryptedCredential, ...view } = mapping;
          if (mapping.status !== "active" || !mapping.encryptedCredential) {
            return { ...view, usable: false, invalidReason: "CREDENTIAL_UNUSABLE" as const };
          }
          const subject = await deps.evaluateSubject(mapping);
          return { ...view, usable: subject.valid, invalidReason: subject.valid ? null : subject.reason };
        }),
      ),
      total: result.total,
      page: input.page,
      pageSize: input.pageSize,
    };
  }

  async function removeKeys(ids: string[]) {
    const requestedIds = [...new Set(ids)];
    const mappings = await deps.findMappingsByIds(requestedIds);
    const byId = new Map(mappings.map((mapping) => [mapping.id, mapping]));
    const deletedIds: string[] = [];
    const skipped: Array<{ id: string; reason: "MAPPING_NOT_FOUND" }> = [];
    const failed: Array<{ id: string }> = [];

    for (const id of requestedIds) {
      const mapping = byId.get(id);
      if (!mapping) {
        skipped.push({ id, reason: "MAPPING_NOT_FOUND" });
        continue;
      }
      try {
        await deps.blockCredential(mapping.externalCredentialId);
        await deps.deleteMapping(mapping.id);
        deletedIds.push(mapping.id);
      } catch (error) {
        if (error instanceof ModelGatewayError && error.code === "NOT_FOUND") {
          await deps.deleteMapping(mapping.id);
          deletedIds.push(mapping.id);
        } else {
          failed.push({ id: mapping.id });
        }
      }
    }
    return { deletedIds, skipped, failed };
  }

  return { listKeys, removeKeys };
}
