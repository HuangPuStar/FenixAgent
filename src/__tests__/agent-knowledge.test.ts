import { beforeEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { agentKnowledgeBinding, agentConfig, knowledgeBase, user, team } from "../db/schema";
import {
  countBindingsByKnowledgeBaseIds,
  listAgentKnowledgeBindings,
  listAgentKnowledgeBindingsById,
  resolveAgentKnowledgePolicy,
  syncAgentKnowledgeBindings,
  syncAgentKnowledgeBindingsById,
} from "../services/agent-knowledge";

// 固定的测试团队 UUID
const TEST_TEAM_ID = "c0000000-0000-0000-0000-000000000001";

async function ensureUser(userId: string) {
  const now = new Date();
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@test.local`,
    emailVerified: false,
    createdAt: now,
    updatedAt: now,
  });
}

/** 确保测试团队存在 */
async function ensureTeam() {
  const [existing] = await db.select().from(team).where(eq(team.id, TEST_TEAM_ID));
  if (!existing) {
    const now = new Date();
    await db.insert(team).values({
      id: TEST_TEAM_ID,
      name: "Agent KB Test Team",
      slug: "agent-kb-test-team",
      createdBy: "agent-kb-user",
      createdAt: now,
      updatedAt: now,
    });
  }
}

describe("agent-knowledge service", () => {
  let kbAgent1Id: string;
  let kbAgent2Id: string;

  beforeEach(async () => {
    await db.delete(agentKnowledgeBinding);
    await db.delete(agentConfig);
    await db.delete(knowledgeBase);
    await db.delete(user).where(inArray(user.id, ["agent-kb-user", "agent-kb-user-2"]));
    await ensureUser("agent-kb-user");
    await ensureUser("agent-kb-user-2");
    await ensureTeam();

    const now = new Date();
    const kbRows = await db.insert(knowledgeBase).values([
      {
        userId: "agent-kb-user",
        teamId: TEST_TEAM_ID,
        name: "KB 1",
        slug: "kb-1",
        description: null,
        provider: "openviking",
        remoteId: "remote-1",
        status: "ready",
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        userId: "agent-kb-user",
        teamId: TEST_TEAM_ID,
        name: "KB 2",
        slug: "kb-2",
        description: null,
        provider: "openviking",
        remoteId: "remote-2",
        status: "ready",
        lastError: null,
        createdAt: now,
        updatedAt: now,
      },
    ]).returning();
    kbAgent1Id = kbRows[0].id;
    kbAgent2Id = kbRows[1].id;
  });

  test("syncAgentKnowledgeBindings replaces old bindings and preserves priority order", async () => {
    // 先创建一个旧绑定
    await syncAgentKnowledgeBindings("agent-kb-user", "build", {
      knowledgeBaseIds: [kbAgent1Id],
    });

    // 替换为新顺序
    await syncAgentKnowledgeBindings("agent-kb-user", "build", {
      knowledgeBaseIds: [kbAgent2Id, kbAgent1Id],
      policy: { searchFirst: false, maxResults: 2 },
    });

    const bindings = await listAgentKnowledgeBindings("build");
    expect(bindings).toEqual([
      { knowledgeBaseId: kbAgent2Id, priority: 0, enabled: true },
      { knowledgeBaseId: kbAgent1Id, priority: 1, enabled: true },
    ]);
  });

  test("resolveAgentKnowledgePolicy returns defaults when config is missing", () => {
    expect(resolveAgentKnowledgePolicy()).toEqual({
      searchFirst: true,
      maxResults: 5,
      defaultNamespaces: [],
    });
  });

  test("countBindingsByKnowledgeBaseIds returns count per knowledge base", async () => {
    await syncAgentKnowledgeBindings("agent-kb-user", "build", { knowledgeBaseIds: [kbAgent1Id, kbAgent2Id] });
    await syncAgentKnowledgeBindings("agent-kb-user", "plan", { knowledgeBaseIds: [kbAgent1Id] });

    const counts = await countBindingsByKnowledgeBaseIds([kbAgent1Id, kbAgent2Id]);
    expect(counts).toEqual({
      [kbAgent1Id]: 2,
      [kbAgent2Id]: 1,
    });
  });

  test("syncAgentKnowledgeBindings rejects missing knowledge bases before insert", async () => {
    await expect(syncAgentKnowledgeBindings("agent-kb-user", "build", {
      knowledgeBaseIds: [kbAgent1Id, "00000000-0000-0000-0000-000000009999"],
    })).rejects.toThrow("知识库不存在或无权限访问: 00000000-0000-0000-0000-000000009999");
  });

  // ByConfigId 版本测试
  test("syncAgentKnowledgeBindingsById replaces old bindings and preserves priority order", async () => {
    const now = new Date();
    const [ac] = await db.insert(agentConfig).values({
      userId: "agent-kb-user",
      teamId: TEST_TEAM_ID,
      name: "test-by-id",
      createdAt: now,
      updatedAt: now,
    }).returning();

    // 先创建一个旧绑定
    await syncAgentKnowledgeBindingsById(TEST_TEAM_ID, ac.id, {
      knowledgeBaseIds: [kbAgent1Id],
    });

    // 替换为新顺序
    await syncAgentKnowledgeBindingsById(TEST_TEAM_ID, ac.id, {
      knowledgeBaseIds: [kbAgent2Id, kbAgent1Id],
    });

    const bindings = await listAgentKnowledgeBindingsById(ac.id);
    expect(bindings).toEqual([
      { knowledgeBaseId: kbAgent2Id, priority: 0, enabled: true },
      { knowledgeBaseId: kbAgent1Id, priority: 1, enabled: true },
    ]);
  });

  test("syncAgentKnowledgeBindingsById rejects missing knowledge bases before insert", async () => {
    const now = new Date();
    const [ac] = await db.insert(agentConfig).values({
      userId: "agent-kb-user",
      teamId: TEST_TEAM_ID,
      name: "test-by-id-reject",
      createdAt: now,
      updatedAt: now,
    }).returning();

    await expect(syncAgentKnowledgeBindingsById(TEST_TEAM_ID, ac.id, {
      knowledgeBaseIds: [kbAgent1Id, "00000000-0000-0000-0000-000000009999"],
    })).rejects.toThrow("知识库不存在或无权限访问: 00000000-0000-0000-0000-000000009999");
  });
});
