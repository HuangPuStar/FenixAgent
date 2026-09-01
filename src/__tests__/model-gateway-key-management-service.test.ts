import { describe, expect, test } from "bun:test";
import { ModelGatewayError } from "@fenix/model-gateway-sdk";
import { createModelGatewayKeyManagementService } from "../services/model-gateway/key-management-service";

const mapping = (id: string) => ({
  id,
  externalCredentialId: `key-${id}`,
  status: "active" as const,
  encryptedCredential: "encrypted-key",
  organizationId: "org-1",
  userId: "user-1",
  agentConfigId: "agent-1",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

function mappingView(id: string) {
  const { encryptedCredential: _encryptedCredential, ...view } = mapping(id);
  return view;
}

describe("model gateway key management service", () => {
  // 验证管理列表会保留所有本地 Key，并标明当前已失效的具体主体原因。
  test("lists mappings with their current invalid reason", async () => {
    const service = createModelGatewayKeyManagementService({
      listMappings: async () => ({ items: [mapping("valid"), mapping("revoked")], total: 2 }),
      findMappingsByIds: async () => [],
      evaluateSubject: async (item) =>
        item.id === "revoked" ? { valid: false, reason: "AGENT_ACCESS_REVOKED" } : { valid: true },
      blockCredential: async () => {},
      deleteMapping: async () => {},
    });

    await expect(service.listKeys({ gatewayProviderId: "provider-1", page: 1, pageSize: 20 })).resolves.toEqual({
      items: [
        {
          ...mappingView("valid"),
          usable: true,
          invalidReason: null,
        },
        {
          ...mappingView("revoked"),
          usable: false,
          invalidReason: "AGENT_ACCESS_REVOKED",
        },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
    });
  });

  // 验证管理员可回收任意已选 Key，并把远端已不存在的 Key 视为可安全删除。
  test("blocks and deletes every selected mapping", async () => {
    const blocked: string[] = [];
    const deleted: string[] = [];
    const service = createModelGatewayKeyManagementService({
      listMappings: async () => ({ items: [], total: 0 }),
      findMappingsByIds: async () => [mapping("first"), mapping("second"), mapping("gone")],
      evaluateSubject: async (item) =>
        item.id === "second" ? { valid: true } : { valid: false, reason: "MEMBERSHIP_NOT_FOUND" },
      blockCredential: async (externalCredentialId) => {
        blocked.push(externalCredentialId);
        if (externalCredentialId === "key-gone") throw new ModelGatewayError("NOT_FOUND", "not found");
      },
      deleteMapping: async (id) => {
        deleted.push(id);
      },
    });

    await expect(service.removeKeys(["first", "second", "gone"])).resolves.toEqual({
      deletedIds: ["first", "second", "gone"],
      skipped: [],
      failed: [],
    });
    expect(blocked).toEqual(["key-first", "key-second", "key-gone"]);
    expect(deleted).toEqual(["first", "second", "gone"]);
  });
});
