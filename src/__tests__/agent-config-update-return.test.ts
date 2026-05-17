// ── updateAgentConfig 返回 boolean（与 deleteAgentConfig 对齐） ──
import { describe, test, expect, mock, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, team, user } from "../db/schema";
import { updateAgentConfig } from "../services/config/agent-config";

const TEST_USER_ID = "user_ac_update_ret";
const TEST_TEAM_SLUG = "ac-update-ret-team";
let TEST_TEAM_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "AC Update Ret", email: "ac-update-ret@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "AC Update Ret Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

await ensureTeam();

describe("updateAgentConfig returns boolean", () => {
  afterAll(async () => {
    if (TEST_TEAM_ID) {
      try { await db.delete(agentConfig).where(eq(agentConfig.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // 存在的 agent config 返回 true
  test("returns true when agent config exists", async () => {
    // 先创建一个 agent config
    await db.insert(agentConfig).values({
      userId: TEST_USER_ID, teamId: TEST_TEAM_ID!, name: "general", model: null,
      prompt: null, steps: null, mode: null, permission: null, variant: null,
      temperature: null, topP: null, disable: false, hidden: false, color: null,
      description: null, knowledge: null, updatedAt: new Date(),
    });

    const result = await updateAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "general", { model: "gpt-4" });
    expect(result).toBe(true);
  });

  // 不存在的 agent config 返回 false
  test("returns false when agent config does not exist", async () => {
    const result = await updateAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "nonexistent_agent_xyz", { model: "gpt-4" });
    expect(result).toBe(false);
  });
});
