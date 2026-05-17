// ── getAgentFullConfig 查询并行化验证 ──
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, provider, skill, mcpServer, team, user } from "../db/schema";
import { getAgentFullConfig } from "../services/config/aggregate";

const TEST_USER_ID = "user_aggregate_par";
const TEST_TEAM_SLUG = "aggregate-par-team";
let TEST_TEAM_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "Aggregate Par", email: "aggregate-par@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "Aggregate Par Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

await ensureTeam();

describe("getAgentFullConfig", () => {
  afterAll(async () => {
    if (TEST_TEAM_ID) {
      try { await db.delete(skill).where(eq(skill.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(mcpServer).where(eq(mcpServer.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(provider).where(eq(provider.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(agentConfig).where(eq(agentConfig.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // agentConfigId 为 null 时返回 null agentConfig + 全局 skills
  test("returns null agentConfig with global skills when agentConfigId is null", async () => {
    // 插入测试数据
    await db.insert(provider).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!, name: "test-provider-agg",
      apiKeyHint: null, baseUrl: null, updatedAt: new Date(),
    });
    await db.insert(mcpServer).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!, name: "test-mcp-agg",
      type: "local", config: { command: ["npx", "test"] }, enabled: true, updatedAt: new Date(),
    });
    await db.insert(skill).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!, name: "global-skill-agg",
      content: null, description: null, enabled: true,
      agentConfigId: null, updatedAt: new Date(),
    });

    const result = await getAgentFullConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, null);

    expect(result.agentConfig).toBe(null);
    expect(result.providers.length).toBeGreaterThan(0);
    expect(result.mcpServers.length).toBeGreaterThan(0);
    expect(result.skills.length).toBeGreaterThan(0);
  });

  // agentConfigId 存在时返回对应 agentConfig
  test("returns agentConfig when agentConfigId is provided", async () => {
    const [ac] = await db.insert(agentConfig).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!, name: "coder-agg",
      model: "gpt-4", prompt: null, steps: null, mode: null, permission: null,
      variant: null, temperature: null, topP: null, disable: false, hidden: false,
      color: null, description: null, knowledge: null, updatedAt: new Date(),
    }).returning();

    const result = await getAgentFullConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, ac.id);

    expect(result.agentConfig).not.toBe(null);
    if (result.agentConfig) {
      expect(result.agentConfig.name).toBe("coder-agg");
    }
  });

  // agentConfigId 指向不存在的记录时返回 null
  test("returns null agentConfig when id not found", async () => {
    const result = await getAgentFullConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "00000000-0000-0000-0000-000000000000");
    expect(result.agentConfig).toBe(null);
  });
});
