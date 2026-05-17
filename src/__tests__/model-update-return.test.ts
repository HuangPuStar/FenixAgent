// ── updateModel 返回 boolean（与 removeModel 对齐） ──
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { model, provider, team, user } from "../db/schema";
import { addModel, updateModel } from "../services/config/model";

const TEST_USER_ID = "user_model_update_ret";
const TEST_TEAM_SLUG = "model-update-ret-team";
const TEST_PROVIDER_NAME = "test-provider-model-upd";
let TEST_TEAM_ID: string | undefined;
let TEST_PROVIDER_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "Model Update Ret", email: "model-update-ret@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "Model Update Ret Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

async function ensureProvider() {
  const existing = await db.select().from(provider).where(eq(provider.name, TEST_PROVIDER_NAME)).limit(1);
  if (existing.length > 0) { TEST_PROVIDER_ID = existing[0].id; return; }
  const [created] = await db.insert(provider).values({
    userId: TEST_USER_ID, teamId: TEST_TEAM_ID!, name: TEST_PROVIDER_NAME,
    apiKeyHint: null, baseUrl: null, updatedAt: new Date(),
  }).returning();
  TEST_PROVIDER_ID = created.id;
}

await ensureTeam();
await ensureProvider();

describe("updateModel returns boolean", () => {
  afterAll(async () => {
    if (TEST_PROVIDER_ID) {
      try { await db.delete(model).where(eq(model.providerId, TEST_PROVIDER_ID)); } catch {}
      try { await db.delete(provider).where(eq(provider.id, TEST_PROVIDER_ID)); } catch {}
    }
    if (TEST_TEAM_ID) {
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // 存在的 model 返回 true
  test("returns true when model exists", async () => {
    await addModel(TEST_PROVIDER_ID!, { modelId: "gpt-4-test-upd", displayName: "GPT-4 Test" });
    const result = await updateModel(TEST_PROVIDER_ID!, "gpt-4-test-upd", { displayName: "GPT-4 Updated" });
    expect(result).toBe(true);
  });

  // 不存在的 model 返回 false
  test("returns false when model does not exist", async () => {
    const result = await updateModel(TEST_PROVIDER_ID!, "nonexistent-model-xyz", { displayName: "X" });
    expect(result).toBe(false);
  });
});
