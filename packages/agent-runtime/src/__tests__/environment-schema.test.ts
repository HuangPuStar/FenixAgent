import { describe, expect, test } from "bun:test";
import { CreateEnvironmentRequestSchema, UpdateEnvironmentRequestSchema } from "../schemas/environment.schema";

describe("environment schema", () => {
  test("create requires agentConfigId", () => {
    const result = CreateEnvironmentRequestSchema.safeParse({
      name: "runtime-demo",
      autoStart: true,
    });

    expect(result.success).toBe(false);
  });

  test("update rejects null agentConfigId", () => {
    const result = UpdateEnvironmentRequestSchema.safeParse({
      agentConfigId: null,
    });

    expect(result.success).toBe(false);
  });
});
