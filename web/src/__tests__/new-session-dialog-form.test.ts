import { describe, expect, test } from "bun:test";
import { z } from "zod";

const newSessionSchema = z.object({
  title: z.string(),
  envId: z.string(),
});

describe("newSessionSchema", () => {
  test("accepts empty title and envId", () => {
    const result = newSessionSchema.safeParse({ title: "", envId: "" });
    expect(result.success).toBe(true);
  });

  test("accepts full input", () => {
    const result = newSessionSchema.safeParse({ title: "My Session", envId: "env-123" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("My Session");
      expect(result.data.envId).toBe("env-123");
    }
  });

  test("accepts title only with empty envId", () => {
    const result = newSessionSchema.safeParse({ title: "Test", envId: "" });
    expect(result.success).toBe(true);
  });

  test("accepts whitespace title (trim handled in handleCreate)", () => {
    const result = newSessionSchema.safeParse({ title: "   ", envId: "env-456" });
    expect(result.success).toBe(true);
  });

  test("rejects non-object input", () => {
    const result = newSessionSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});
