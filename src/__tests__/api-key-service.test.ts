import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { apiKey, user, team } from "../db/schema";
import {
  createApiKey,
  listApiKeysByUser,
  deleteApiKey,
  updateApiKeyLabel,
  validateApiKeyAndGetUser,
} from "../auth/api-key-service";

const TEST_USER_ID = "user_apikey_test";
const TEST_USER_EMAIL = "apikey-test@rcs.local";
const TEST_TEAM_ID = "e0000000-0000-0000-0000-000000000001";

async function ensureUser() {
  const existing = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existing.length > 0) return;
  const now = new Date();
  await db.insert(user).values({
    id: TEST_USER_ID,
    name: "API Key Test",
    email: TEST_USER_EMAIL,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
}

async function ensureTeam() {
  const [existing] = await db.select().from(team).where(eq(team.id, TEST_TEAM_ID));
  if (!existing) {
    const now = new Date();
    await db.insert(team).values({
      id: TEST_TEAM_ID,
      name: "API Key Test Team",
      slug: "apikey-test-team",
      createdBy: TEST_USER_ID,
      createdAt: now,
      updatedAt: now,
    });
  }
}

async function cleanupApiKeys() {
  try {
    await db.delete(apiKey).where(eq(apiKey.userId, TEST_USER_ID));
  } catch {}
}

await ensureUser();
await ensureTeam();

describe("API Key Service", () => {
  beforeEach(async () => {
    await cleanupApiKeys();
  });

  afterAll(async () => {
    await cleanupApiKeys();
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  describe("createApiKey", () => {
    test("creates a key with rcs_ prefix", async () => {
      const { record, fullKey } = await createApiKey(TEST_USER_ID, "test-label", TEST_TEAM_ID);
      expect(fullKey).toMatch(/^rcs_/);
      expect(record.label).toBe("test-label");
      expect(record.keyPrefix).toMatch(/^rcs_.*\.\.\..{4}$/);
      expect(record.createdAt).toBeGreaterThan(0);
      expect(record.lastUsedAt).toBeNull();
    });

    test("creates with default label when empty", async () => {
      const { record } = await createApiKey(TEST_USER_ID, "", TEST_TEAM_ID);
      expect(record.label).toBe("Default");
    });

    test("creates unique keys", async () => {
      const { fullKey: key1 } = await createApiKey(TEST_USER_ID, "a", TEST_TEAM_ID);
      const { fullKey: key2 } = await createApiKey(TEST_USER_ID, "b", TEST_TEAM_ID);
      expect(key1).not.toBe(key2);
    });
  });

  describe("validateApiKeyAndGetUser", () => {
    test("returns user for valid key", async () => {
      const { fullKey } = await createApiKey(TEST_USER_ID, "valid", TEST_TEAM_ID);
      const result = await validateApiKeyAndGetUser(fullKey);
      expect(result).not.toBeNull();
      expect(result!.userId).toBe(TEST_USER_ID);
    });

    test("returns null for invalid key", async () => {
      const result = await validateApiKeyAndGetUser("rcs_nonexistent_key");
      expect(result).toBeNull();
    });
  });

  describe("listApiKeysByUser", () => {
    test("returns keys for user", async () => {
      await createApiKey(TEST_USER_ID, "key1", TEST_TEAM_ID);
      await createApiKey(TEST_USER_ID, "key2", TEST_TEAM_ID);
      const keys = await listApiKeysByUser(TEST_TEAM_ID);
      expect(keys).toHaveLength(2);
      expect(keys.map((k) => k.label)).toContain("key1");
      expect(keys.map((k) => k.label)).toContain("key2");
    });

    test("returns empty for user with no keys", async () => {
      const keys = await listApiKeysByUser("team_no_keys_xyz");
      expect(keys).toHaveLength(0);
    });
  });

  describe("deleteApiKey", () => {
    test("deletes own key", async () => {
      const { record } = await createApiKey(TEST_USER_ID, "to-delete", TEST_TEAM_ID);
      const deleted = await deleteApiKey(TEST_TEAM_ID, record.id);
      expect(deleted).toBe(true);
      const keys = await listApiKeysByUser(TEST_TEAM_ID);
      expect(keys.find((k) => k.id === record.id)).toBeUndefined();
    });

    test("returns false for non-existent key", async () => {
      const deleted = await deleteApiKey(TEST_TEAM_ID, "key_nonexistent");
      expect(deleted).toBe(false);
    });

    test("returns false when deleting another user's key", async () => {
      const { record } = await createApiKey(TEST_USER_ID, "owned", TEST_TEAM_ID);
      const deleted = await deleteApiKey("team_other_xyz", record.id);
      expect(deleted).toBe(false);
    });
  });

  describe("updateApiKeyLabel", () => {
    test("updates label", async () => {
      const { record } = await createApiKey(TEST_USER_ID, "old-label", TEST_TEAM_ID);
      const updated = await updateApiKeyLabel(TEST_TEAM_ID, record.id, "new-label");
      expect(updated).toBe(true);
      const keys = await listApiKeysByUser(TEST_TEAM_ID);
      expect(keys.find((k) => k.id === record.id)?.label).toBe("new-label");
    });

    test("returns false for non-existent key", async () => {
      const updated = await updateApiKeyLabel(TEST_TEAM_ID, "key_nonexistent", "label");
      expect(updated).toBe(false);
    });

    test("returns false when updating another user's key", async () => {
      const { record } = await createApiKey(TEST_USER_ID, "owned", TEST_TEAM_ID);
      const updated = await updateApiKeyLabel("team_other_xyz", record.id, "hacked");
      expect(updated).toBe(false);
    });
  });
});
