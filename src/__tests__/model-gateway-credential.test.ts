import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  deleteModelGatewayCredential,
  findModelGatewayCredentialBySubject,
  listModelGatewayCredentialsAfter,
  upsertModelGatewayCredential,
} from "../repositories/model-gateway-credential";
import { createModelGatewayCredentialCipher } from "../services/model-gateway/credential-cipher";
import { resetDbStub, stubDb } from "../test-utils/stubs/db-stub";

const KEY = "a".repeat(32);

describe("model gateway credential persistence", () => {
  // 验证 Virtual Key 使用独立 AES-256-GCM 密钥加密，并且密文格式可持久化。
  test("encrypts and decrypts a credential with the stable mgc1 format", () => {
    const cipher = createModelGatewayCredentialCipher(KEY);
    const encrypted = cipher.encrypt("sk-sensitive-key");

    expect(encrypted.startsWith("mgc1.")).toBe(true);
    expect(encrypted).not.toContain("sk-sensitive-key");
    expect(cipher.decrypt(encrypted)).toBe("sk-sensitive-key");
  });

  // 验证每次加密使用随机 IV，避免相同 Virtual Key 产生可关联的密文。
  test("uses a fresh IV for each encryption", () => {
    const cipher = createModelGatewayCredentialCipher(KEY);

    expect(cipher.encrypt("same-key")).not.toBe(cipher.encrypt("same-key"));
  });

  // 验证错误密钥或篡改密文不会泄露明文，也不会返回认证库的底层错误。
  test("rejects invalid keys and tampered ciphertext safely", () => {
    expect(() => createModelGatewayCredentialCipher("a".repeat(31))).toThrow(
      "credential encryption key must be exactly 32 bytes",
    );

    const cipher = createModelGatewayCredentialCipher(KEY);
    const encrypted = cipher.encrypt("sk-sensitive-key");
    const parts = encrypted.split(".");
    parts[3] = `${parts[3]?.[0] === "A" ? "B" : "A"}${parts[3]?.slice(1) ?? ""}`;
    const tampered = parts.join(".");

    expect(() => cipher.decrypt(tampered)).toThrow("unable to decrypt model gateway credential");
  });

  // 验证四元组唯一约束在并发式重复创建时返回同一映射，而不会覆盖已有密文。
  test("upserts a subject mapping without replacing its encrypted credential", async () => {
    const subject = {
      gatewayProviderId: randomUUID(),
      organizationId: `test-org-${randomUUID()}`,
      userId: `test-user-${randomUUID()}`,
      agentConfigId: randomUUID(),
      externalCredentialId: `test-key-${randomUUID()}`,
      encryptedCredential: "mgc1.initial",
      status: "active" as const,
      metadata: { source: "test" },
    };

    stubDb(createCredentialDbStub());
    try {
      const created = await upsertModelGatewayCredential(subject);
      const repeated = await upsertModelGatewayCredential({ ...subject, encryptedCredential: "mgc1.replaced" });
      expect(repeated.id).toBe(created.id);
      expect(repeated.encryptedCredential).toBe("mgc1.initial");
      expect(
        await findModelGatewayCredentialBySubject({
          gatewayProviderId: subject.gatewayProviderId,
          organizationId: subject.organizationId,
          userId: subject.userId,
          agentConfigId: subject.agentConfigId,
        }),
      ).toMatchObject({ id: created.id, status: "active" });
    } finally {
      resetDbStub();
    }
  });

  // 验证远端 Key 已回收后删除映射，恢复访问时不会复用已禁用的凭证。
  test("deletes a credential mapping after remote key revocation", async () => {
    const id = randomUUID();
    const subject = {
      id,
      gatewayProviderId: randomUUID(),
      organizationId: `test-org-${randomUUID()}`,
      userId: `test-user-${randomUUID()}`,
      agentConfigId: randomUUID(),
      externalCredentialId: `test-key-${randomUUID()}`,
      encryptedCredential: "mgc1.initial",
      status: "active" as const,
      metadata: {},
    };

    stubDb(createCredentialDbStub(id));
    try {
      await upsertModelGatewayCredential(subject);
      await deleteModelGatewayCredential(id);
      const rows = await listModelGatewayCredentialsAfter({
        afterId: "00000000-0000-0000-0000-000000000000",
        limit: 10,
      });
      const row = rows.find((item) => item.id === id);
      expect(row).toBeUndefined();
    } finally {
      resetDbStub();
    }
  });
});

function createCredentialDbStub(initialId?: string) {
  let row: Record<string, unknown> | null = null;
  return {
    insert: () => ({
      values: (input: Record<string, unknown>) => ({
        onConflictDoNothing: () => ({
          returning: async () => {
            if (row) return [];
            row = {
              id: initialId ?? randomUUID(),
              ...input,
              createdAt: new Date(),
              updatedAt: new Date(),
            };
            return [row];
          },
        }),
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (row ? [row] : []),
          orderBy: () => ({ limit: async () => (row ? [row] : []) }),
        }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (row) row = { ...row, ...patch };
          return { returning: async () => (row ? [row] : []) };
        },
      }),
    }),
    delete: () => ({
      where: async () => {
        row = null;
      },
    }),
  };
}
