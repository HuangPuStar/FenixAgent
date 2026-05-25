import { describe, expect, test } from "bun:test";
import { z } from "zod";

const addTokenSchema = z.object({
  token: z.string().min(1, "Token is required"),
  label: z.string(),
});

describe("addTokenSchema", () => {
  test("rejects empty token", () => {
    const result = addTokenSchema.safeParse({ token: "", label: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const tokenError = result.error.issues.find((i) => i.path[0] === "token");
      expect(tokenError?.message).toBe("Token is required");
    }
  });

  test("accepts token with empty label", () => {
    const result = addTokenSchema.safeParse({ token: "sk-abc123", label: "" });
    expect(result.success).toBe(true);
  });

  test("accepts full input", () => {
    const result = addTokenSchema.safeParse({ token: "sk-abc123", label: "My Token" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.token).toBe("sk-abc123");
      expect(result.data.label).toBe("My Token");
    }
  });

  test("accepts whitespace-only token (trim handled in onAdd)", () => {
    const result = addTokenSchema.safeParse({ token: "   ", label: "test" });
    expect(result.success).toBe(true);
  });

  test("accepts very long token", () => {
    const result = addTokenSchema.safeParse({ token: "a".repeat(1000), label: "test" });
    expect(result.success).toBe(true);
  });
});
