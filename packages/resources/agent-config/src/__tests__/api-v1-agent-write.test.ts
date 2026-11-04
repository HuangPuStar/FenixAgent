import { describe, expect, test } from "bun:test";
import { ApiAgentUpdateBodySchema, ApiAgentUpsertBodySchema } from "../server/schemas/api-agent.schema";

describe("Agent v1 write contract", () => {
  // PATCH 必须保持未出现的字段，不能隐式清空关联或默认关闭记忆。
  test("prompt-only PATCH preserves omitted configuration", () => {
    expect(ApiAgentUpdateBodySchema.parse({ prompt: "changed" })).toEqual({ prompt: "changed" });
    expect(ApiAgentUpdateBodySchema.safeParse({ name: "rename" }).success).toBe(false);
    expect(ApiAgentUpdateBodySchema.safeParse({}).success).toBe(false);
  });
  // 非法集合在任何数据库写入前拒绝，避免静默去重改变调用语义。
  test("duplicate resource IDs are invalid", () => {
    for (const input of [
      { skillIds: ["s1", "s1"] },
      { mcpIds: ["m1", "m1"] },
      { knowledge: { knowledgeBaseIds: ["k1", "k1"] } },
    ]) {
      expect(ApiAgentUpdateBodySchema.safeParse(input).success).toBe(false);
    }
  });
  // 显式清空和空数组解绑是合法更新，创建默认关闭已有记忆能力。
  test("clear and unbind remain explicit values", () => {
    expect(
      ApiAgentUpdateBodySchema.parse({
        modelId: null,
        prompt: null,
        knowledge: null,
        skillIds: [],
        mcpIds: [],
        enableMemory: false,
      }),
    ).toEqual({ modelId: null, prompt: null, knowledge: null, skillIds: [], mcpIds: [], enableMemory: false });
    expect(ApiAgentUpsertBodySchema.parse({ name: "minimal" }).enableMemory).toBe(false);
  });
});
