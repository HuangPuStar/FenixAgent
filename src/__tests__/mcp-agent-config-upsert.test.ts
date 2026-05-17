// createMcpServer / createAgentConfig onConflictDoUpdate 幂等 upsert 验证
import { describe, test, expect, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { mcpServer, agentConfig, team, user } from "../db/schema";
import { createMcpServer } from "../services/config/mcp-server";
import { createAgentConfig } from "../services/config/agent-config";

const TEST_USER_ID = "user_mcp_ac_upsert";
const TEST_TEAM_SLUG = "mcp-ac-upsert-team";
let TEST_TEAM_ID: string | undefined;

async function ensureTeam() {
  const now = new Date();
  const existingUser = await db.select().from(user).where(eq(user.id, TEST_USER_ID)).limit(1);
  if (existingUser.length === 0) {
    await db.insert(user).values({ id: TEST_USER_ID, name: "MCP AC Upsert", email: "mcp-ac-upsert@rcs.local", emailVerified: false, createdAt: now, updatedAt: now }).catch(() => {});
  }
  const existing = await db.select().from(team).where(eq(team.slug, TEST_TEAM_SLUG)).limit(1);
  if (existing.length > 0) { TEST_TEAM_ID = existing[0].id; return; }
  const [created] = await db.insert(team).values({ name: "MCP AC Upsert Team", slug: TEST_TEAM_SLUG, createdBy: TEST_USER_ID }).returning();
  TEST_TEAM_ID = created.id;
}

await ensureTeam();

describe("McpServer + AgentConfig onConflictDoUpdate upsert", () => {
  afterAll(async () => {
    if (TEST_TEAM_ID) {
      try { await db.delete(agentConfig).where(eq(agentConfig.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(mcpServer).where(eq(mcpServer.teamId, TEST_TEAM_ID)); } catch {}
      try { await db.delete(team).where(eq(team.id, TEST_TEAM_ID)); } catch {}
    }
    try { await db.delete(user).where(eq(user.id, TEST_USER_ID)); } catch {}
  });

  // MCP: 首次创建成功
  test("createMcpServer 首次创建成功", async () => {
    await createMcpServer({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "my-server", "local", { command: ["npx", "test"] });
    const rows = await db.select().from(mcpServer).where(eq(mcpServer.name, "my-server"));
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("local");
  });

  // MCP: 重复创建 upsert 更新
  test("createMcpServer 重复创建 upsert 更新", async () => {
    await createMcpServer({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "my-server", "remote", { url: "http://example.com" });
    const rows = await db.select().from(mcpServer).where(eq(mcpServer.name, "my-server"));
    expect(rows.length).toBe(1);
    expect(rows[0].type).toBe("remote");
  });

  // AgentConfig: 首次创建成功
  test("createAgentConfig 首次创建成功", async () => {
    await createAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "general", { model: "gpt-4" });
    const rows = await db.select().from(agentConfig).where(eq(agentConfig.name, "general"));
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("gpt-4");
  });

  // AgentConfig: 重复创建 upsert 更新
  test("createAgentConfig 重复创建 upsert 更新", async () => {
    await createAgentConfig({ teamId: TEST_TEAM_ID!, userId: TEST_USER_ID, role: "owner" }, "general", { model: "claude-3" });
    const rows = await db.select().from(agentConfig).where(eq(agentConfig.name, "general"));
    expect(rows.length).toBe(1);
    expect(rows[0].model).toBe("claude-3");
  });
});
