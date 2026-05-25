import { describe, expect, mock, test } from "bun:test";

// 记录 mock 调用，用于断言
const deleteWhereArgs: unknown[] = [];
const insertValues: unknown[][] = [];

mock.module("../db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: async () => [{ skillId: "skill-a" }, { skillId: "skill-b" }],
      }),
    }),
    delete: () => ({
      where: (_cond: unknown) => {
        deleteWhereArgs.push(_cond);
        return Promise.resolve();
      },
    }),
    insert: () => ({
      values: (vals: unknown[]) => {
        insertValues.push(vals);
        return Promise.resolve();
      },
    }),
  },
}));

mock.module("../db/schema", () => ({
  agentConfigSkill: {
    agentConfigId: "agent_config_id",
    skillId: "skill_id",
  },
}));

// mock.module 必须在 import 之前
const { listAgentSkillIds, syncAgentSkills } = await import("../services/config/agent-config-skill");

describe("agent-config-skill service", () => {
  test("listAgentSkillIds 返回 skillId 数组", async () => {
    const ids = await listAgentSkillIds("agent-1");
    expect(ids).toEqual(["skill-a", "skill-b"]);
  });

  test("syncAgentSkills 空数组只调用 delete 不调用 insert", async () => {
    const beforeInsert = insertValues.length;
    await syncAgentSkills("agent-2", []);
    expect(deleteWhereArgs.length).toBeGreaterThan(0);
    expect(insertValues.length).toBe(beforeInsert);
  });

  test("syncAgentSkills 非空数组调用 delete 后 insert", async () => {
    await syncAgentSkills("agent-3", ["s1", "s2"]);
    // 至少有一次 delete 和一次 insert
    expect(deleteWhereArgs.length).toBeGreaterThan(0);
    expect(insertValues.length).toBeGreaterThan(0);
    // 最后一次 insert 的值应包含两条记录
    const lastInsert = insertValues[insertValues.length - 1];
    expect(lastInsert).toEqual([
      { agentConfigId: "agent-3", skillId: "s1" },
      { agentConfigId: "agent-3", skillId: "s2" },
    ]);
  });
});
