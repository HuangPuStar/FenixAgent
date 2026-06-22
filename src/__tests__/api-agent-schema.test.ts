import { describe, expect, test } from "bun:test";
import { ApiAgentDetailSchema, ApiAgentUpsertBodySchema } from "../schemas/api-agent.schema";

describe("api agent schema", () => {
  // knowledge 应是可文档化的对象结构，而不是任意 unknown。
  test("knowledge accepts structured object values", () => {
    const bodyResult = ApiAgentUpsertBodySchema.safeParse({
      name: "demo",
      knowledge: {
        knowledgeBaseIds: ["kb-1", "kb-2"],
        policy: {
          searchFirst: true,
          maxResults: 5,
          defaultNamespaces: ["default"],
        },
      },
    });

    const detailResult = ApiAgentDetailSchema.safeParse({
      id: "agc-1",
      name: "demo",
      builtIn: false,
      model: null,
      modelId: null,
      prompt: null,
      description: null,
      extra: null,
      knowledge: {
        knowledgeBaseIds: ["kb-1"],
        policy: {
          searchFirst: true,
          maxResults: 5,
          defaultNamespaces: [],
        },
      },
    });

    expect(bodyResult.success).toBe(true);
    expect(detailResult.success).toBe(true);
  });

  // knowledge 传字符串这类非对象值时，应在 schema 层直接拒绝。
  test("knowledge rejects non-object values", () => {
    const result = ApiAgentUpsertBodySchema.safeParse({
      name: "demo",
      knowledge: "kb-1",
    });

    expect(result.success).toBe(false);
  });
});
