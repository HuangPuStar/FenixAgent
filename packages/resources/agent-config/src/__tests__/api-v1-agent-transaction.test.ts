import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { agentConfig } from "@fenix/agent-config/db";
import { getDatabase } from "@fenix/platform-sdk/server";
import { initializeTestApplicationInfrastructure, resetAllStubs } from "@fenix/platform-sdk/testing";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createAgentConfigRepository } from "../server/repositories/agent-config-resource";
import { createAgentAssociations } from "../server/services/agent-associations";
import { saveAgentConfig } from "../server/services/agent-config-write";

// 仅显式指定隔离测试库才运行，不默认接入开发者的 DATABASE_URL。
const connectionString = process.env.TEST_EXTERNAL_API_DATABASE_URL;
const pool = connectionString ? new Pool({ connectionString, max: 5 }) : undefined;
const db = pool ? drizzle(pool) : undefined;
const queryUnavailable = async (): Promise<never> => {
  throw new Error("read query is outside this test");
};
const repository = createAgentConfigRepository({
  list: queryUnavailable,
  count: queryUnavailable,
  findById: queryUnavailable,
});
const associations = createAgentAssociations();
const org = `v1-transaction-${randomUUID()}`;
const userId = org;
const agentId = randomUUID();
const skills = [randomUUID(), randomUUID()];
const mcps = [randomUUID(), randomUUID()];
const kbs = [randomUUID(), randomUUID()];

beforeEach(async () => {
  if (!pool || !db) return;
  resetAllStubs();
  initializeTestApplicationInfrastructure({ database: db });
  await pool.query('INSERT INTO "user" (id,name,email) VALUES ($1::text,$1::text,$2::text) ON CONFLICT DO NOTHING', [
    userId,
    `${userId}@example.test`,
  ]);
  await pool.query("DELETE FROM agent_config WHERE user_id=$1", [userId]);
  for (let index = 0; index < 2; index++) {
    await pool.query(
      "INSERT INTO skill (id,user_id,organization_id,name) VALUES ($1,$2,$2,$3) ON CONFLICT DO NOTHING",
      [skills[index], userId, `skill-${index}`],
    );
    await pool.query(
      'INSERT INTO mcp_server (id,user_id,organization_id,name,type,config) VALUES ($1,$2,$2,$3,\'local\',\'{"type":"local","command":["tool"]}\') ON CONFLICT DO NOTHING',
      [mcps[index], userId, `mcp-${index}`],
    );
    await pool.query(
      "INSERT INTO knowledge_base (id,user_id,organization_id,name,slug) VALUES ($1,$2,$2,$3,$3) ON CONFLICT DO NOTHING",
      [kbs[index], userId, `kb-${index}`],
    );
  }
  await pool.query(
    "INSERT INTO agent_config (id,user_id,organization_id,name,prompt) VALUES ($1,$2,$2,'transaction-agent','old')",
    [agentId, userId],
  );
  await save("old", 0);
});
afterEach(resetAllStubs);
afterAll(async () => {
  if (pool) {
    await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
    await pool.end();
  }
});

function save(prompt: string, index: number, overrides = associations, writeGate?: () => Promise<void>) {
  return saveAgentConfig({
    organizationId: userId,
    resourceId: agentId,
    bindings: { skillIds: [skills[index]], mcpIds: [mcps[index]], knowledge: { knowledgeBaseIds: [kbs[index]] } },
    enableMemory: index === 1,
    associations: overrides,
    write: async () => {
      await writeGate?.();
      const [row] = await getDatabase<NonNullable<typeof db>>()
        .update(agentConfig)
        .set({ prompt })
        .where(eq(agentConfig.id, agentId))
        .returning();
      return row;
    },
  });
}
async function snapshot() {
  const row = (await pool!.query("SELECT prompt FROM agent_config WHERE id=$1", [agentId])).rows[0];
  return {
    prompt: row.prompt,
    skills: await associations.listSkillIds(agentId),
    mcps: await associations.listMcpIds(agentId),
    knowledge: await associations.getKnowledge(agentId),
    memory: await associations.isMemoryEnabled(agentId),
  };
}

for (const stage of ["syncSkills", "syncMcps", "syncKnowledge", "setMemoryEnabled"] as const) {
  // 每个实际关联写入后注入故障，Postgres 必须回滚主行、全部关联和记忆开关。
  test.skipIf(!pool)(`Postgres rolls back complete Agent aggregate after ${stage}`, async () => {
    const before = await snapshot();
    const failing = { ...associations };
    if (stage === "setMemoryEnabled")
      failing.setMemoryEnabled = async (...args) => {
        await associations.setMemoryEnabled(...args);
        throw new Error("injected write failure");
      };
    else if (stage === "syncKnowledge")
      failing.syncKnowledge = async (...args) => {
        await associations.syncKnowledge(...args);
        throw new Error("injected write failure");
      };
    else
      failing[stage] = async (...args: [string, readonly string[]]) => {
        await associations[stage](...args);
        throw new Error("injected write failure");
      };
    await expect(save("new", 1, failing)).rejects.toThrow("injected write failure");
    expect(await snapshot()).toEqual(before);
  });
}

// 同 Agent 的第二次保存须等待真实行锁，不能把两次配置和关联拼成混合状态。
test.skipIf(!pool)("Postgres serializes concurrent Agent aggregate replacements", async () => {
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let secondEntered = false;
  const first = save("first", 0, associations, async () => {
    enter();
    await gate;
  });
  await entered;
  const second = save("second", 1, associations, async () => {
    secondEntered = true;
  });
  let waiting = false;
  try {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await pool!.query(
        "SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'",
      );
      if (result.rowCount) {
        waiting = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(waiting).toBe(true);
    expect(secondEntered).toBe(false);
  } finally {
    resume();
  }
  await Promise.all([first, second]);
  expect(await snapshot()).toEqual({
    prompt: "second",
    skills: [skills[1]],
    mcps: [mcps[1]],
    knowledge: { knowledgeBaseIds: [kbs[1]], policy: null },
    memory: true,
  });
});

// 严格创建在数据库唯一约束下只有一个赢家，失败方不得把创建转成覆盖。
test.skipIf(!pool)("Postgres strict concurrent create never overwrites winner", async () => {
  const create = (prompt: string) =>
    repository.create({
      name: "same-name",
      organizationId: org,
      ownerUserId: userId,
      visibility: "private",
      data: { prompt },
      rejectConflict: true,
    });
  const results = await Promise.all([create("one"), create("two")]);
  expect(results.filter(Boolean)).toHaveLength(1);
  const rows = (
    await pool!.query("SELECT prompt FROM agent_config WHERE organization_id=$1 AND name='same-name'", [org])
  ).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].prompt).toBe(results[0] ? "one" : "two");
});
