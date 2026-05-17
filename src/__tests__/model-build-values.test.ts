// R35: model.ts buildModelValues 辅助函数（values/set 共享字段映射）
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { model, provider, team, user } from "../db/schema";
import { addModel, updateModel } from "../services/config/model";

const TEST_USER_ID = "user_model_build_val";
const TEST_TEAM_SLUG = "model-build-val-team";
const TEST_PROVIDER_NAME = "test-provider-model-bv";
let TEST_TEAM_ID: string | undefined;
let TEST_PROVIDER_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "Model Build Val", email: "model-build-val@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "Model Build Val Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
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

describe("buildModelValues 字段映射", () => {
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

  // addModel 写入完整字段后可从 DB 读回
  test("addModel 应成功写入并可读回", async () => {
    await addModel(TEST_PROVIDER_ID!, {
      modelId: "gpt-4-bv",
      displayName: "GPT-4 BV",
      modalities: ["text"],
      limitConfig: { rpm: 60 },
      cost: { input: 0.03 },
      options: { stream: true },
    });

    const rows = await db.select().from(model).where(eq(model.modelId, "gpt-4-bv"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].displayName).toBe("GPT-4 BV");
  });

  // updateModel 修改后可从 DB 读回
  test("updateModel 应成功更新并可读回", async () => {
    await updateModel(TEST_PROVIDER_ID!, "gpt-4-bv", {
      displayName: "GPT-4 BV Updated",
    });

    const rows = await db.select().from(model).where(eq(model.modelId, "gpt-4-bv"));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].displayName).toBe("GPT-4 BV Updated");
  });

  // addModel 无可选字段时正常执行
  test("addModel 无可选字段时正常执行", async () => {
    await addModel(TEST_PROVIDER_ID!, { modelId: "base-model-bv" });
    const rows = await db.select().from(model).where(eq(model.modelId, "base-model-bv"));
    expect(rows.length).toBeGreaterThan(0);
  });
});
