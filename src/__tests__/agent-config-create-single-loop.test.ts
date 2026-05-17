// createAgentConfig 单循环构建 values/set 测试
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { agentConfig, team, user } from "../db/schema";
import { createAgentConfig } from "../services/config/agent-config";

const TEST_USER_ID = "user_ac_create_loop";
const TEST_TEAM_SLUG = "ac-create-loop-team";
let TEST_TEAM_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "AC Create Loop", email: "ac-create-loop@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "AC Create Loop Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

await ensureTeam();

describe("createAgentConfig 单循环 values/set 构建", () => {
  afterAll(async () => {
    if (TEST_TEAM_ID) {
      try { await db.delete(agentConfig).where(eq(agentConfig.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // 有 settable fields 时 DB 写入正确
  test("写入包含 settable fields 的 agent config", async () => {
    await createAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "test-agent", {
      model: "gpt-4",
      prompt: "test prompt",
      steps: 10,
      mode: "primary",
    });

    const rows = await db.select().from(agentConfig).where(eq(agentConfig.name, "test-agent"));
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("gpt-4");
    expect(rows[0].prompt).toBe("test prompt");
    expect(rows[0].steps).toBe(10);
    expect(rows[0].mode).toBe("primary");
  });

  // 无 settable fields 时 values 仅有 userId/name
  test("写入最小 agent config", async () => {
    await createAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "minimal", {});

    const rows = await db.select().from(agentConfig).where(eq(agentConfig.name, "minimal"));
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe("minimal");
  });

  // 值为 null 时应正确传递 null
  test("null 值正确写入 DB", async () => {
    await createAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "null-agent", {
      model: null,
      prompt: null,
    });

    const rows = await db.select().from(agentConfig).where(eq(agentConfig.name, "null-agent"));
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBeNull();
    expect(rows[0].prompt).toBeNull();
  });
});
