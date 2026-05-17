// addModel onConflictDoUpdate 幂等 upsert 验证
import { describe, test, expect, afterAll } from "bun:test";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { model, provider, team, user } from "../db/schema";
import { addModel } from "../services/config/model";

const TEST_USER_ID = "user_model_upsert_conf";
const TEST_TEAM_SLUG = "model-upsert-conf-team";
const TEST_PROVIDER_NAME = "test-provider-model-uc";
let TEST_TEAM_ID: string | undefined;
let TEST_PROVIDER_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "Model Upsert Conf", email: "model-upsert-conf@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "Model Upsert Conf Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
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

describe("addModel — onConflictDoUpdate 幂等 upsert", () => {
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

  // 首次 insert 成功写入
  test("首次插入成功", async () => {
    await addModel(TEST_PROVIDER_ID!, { modelId: "gpt-4-uc", displayName: "GPT-4" });
    const rows = await db.select().from(model).where(
      and(eq(model.providerId, TEST_PROVIDER_ID!), eq(model.modelId, "gpt-4-uc"))
    );
    expect(rows.length).toBe(1);
    expect(rows[0].displayName).toBe("GPT-4");
  });

  // 重复调用 upsert 不报错且更新值
  test("重复调用 upsert 更新而非报错", async () => {
    await addModel(TEST_PROVIDER_ID!, { modelId: "gpt-4-uc", displayName: "GPT-4 Updated" });
    const rows = await db.select().from(model).where(
      and(eq(model.providerId, TEST_PROVIDER_ID!), eq(model.modelId, "gpt-4-uc"))
    );
    expect(rows.length).toBe(1);
    expect(rows[0].displayName).toBe("GPT-4 Updated");
  });

  // 包含所有可选字段时正确写入
  test("包含所有可选字段时正确写入", async () => {
    await addModel(TEST_PROVIDER_ID!, {
      modelId: "claude-uc",
      displayName: "Claude 3",
      modalities: { input: ["text"] },
      limitConfig: { rpm: 60 },
      cost: { prompt: 0.03 },
      options: { temperature: 0.7 },
    });
    const rows = await db.select().from(model).where(
      and(eq(model.providerId, TEST_PROVIDER_ID!), eq(model.modelId, "claude-uc"))
    );
    expect(rows.length).toBe(1);
    expect(rows[0].displayName).toBe("Claude 3");
  });

  // 只传必填字段 modelId 也能正常工作
  test("只传 modelId 正常工作", async () => {
    await addModel(TEST_PROVIDER_ID!, { modelId: "minimal-uc" });
    const rows = await db.select().from(model).where(
      and(eq(model.providerId, TEST_PROVIDER_ID!), eq(model.modelId, "minimal-uc"))
    );
    expect(rows.length).toBe(1);
  });
});
