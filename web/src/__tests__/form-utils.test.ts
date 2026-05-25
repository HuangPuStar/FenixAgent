import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  intRangeSchema,
  nameSchema,
  optionalFloatSchema,
  optionalStringSchema,
  requiredStringSchema,
  validateWithSchema,
  zodResolver,
} from "../lib/form-utils";

describe("nameSchema", () => {
  test("accepts valid name with hyphens", () => {
    const result = nameSchema().safeParse("my-agent");
    expect(result.success).toBe(true);
  });

  test("rejects uppercase letters", () => {
    const result = nameSchema().safeParse("My Agent!");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("只能包含小写字母");
    }
  });

  test("rejects empty string", () => {
    const result = nameSchema().safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("不能为空");
    }
  });

  test("rejects string longer than 64 chars", () => {
    const result = nameSchema().safeParse("a".repeat(65));
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("64");
    }
  });

  test("uses custom label", () => {
    const result = nameSchema({ label: "标识符" }).safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("标识符不能为空");
    }
  });
});

describe("intRangeSchema", () => {
  test("parses valid integer", () => {
    const result = intRangeSchema({ min: 1, max: 200, label: "步数" }).safeParse("50");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(50);
  });

  test("rejects value below min", () => {
    const result = intRangeSchema({ min: 1, max: 200, label: "步数" }).safeParse("0");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("1-200");
    }
  });

  test("rejects non-numeric string", () => {
    const result = intRangeSchema({ min: 1, max: 200, label: "步数" }).safeParse("abc");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("整数");
    }
  });

  test("rejects value above max", () => {
    const result = intRangeSchema({ min: 1, max: 200, label: "步数" }).safeParse("250");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("1-200");
    }
  });
});

describe("optionalFloatSchema", () => {
  test("accepts empty string", () => {
    const result = optionalFloatSchema({ min: 0, max: 2, label: "温度" }).safeParse("");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBeUndefined();
  });

  test("parses valid float", () => {
    const result = optionalFloatSchema({ min: 0, max: 2, label: "温度" }).safeParse("1.5");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(1.5);
  });

  test("rejects value above max", () => {
    const result = optionalFloatSchema({ min: 0, max: 2, label: "温度" }).safeParse("3");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("0-2");
    }
  });

  test("rejects non-numeric string", () => {
    const result = optionalFloatSchema({ min: 0, max: 2, label: "温度" }).safeParse("abc");
    expect(result.success).toBe(false);
    if (!result.success) {
      const msg = result.error.issues.map((i) => i.message).join(";");
      expect(msg).toContain("数字");
    }
  });
});

describe("requiredStringSchema", () => {
  test("accepts non-empty string", () => {
    expect(requiredStringSchema().safeParse("hello").success).toBe(true);
  });

  test("rejects empty string", () => {
    const result = requiredStringSchema().safeParse("");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("不能为空");
    }
  });

  test("rejects string exceeding max", () => {
    const result = requiredStringSchema({ max: 10 }).safeParse("a".repeat(11));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("10");
    }
  });
});

describe("optionalStringSchema", () => {
  test("accepts empty string", () => {
    expect(optionalStringSchema().safeParse("").success).toBe(true);
  });

  test("accepts non-empty string", () => {
    expect(optionalStringSchema().safeParse("hello").success).toBe(true);
  });

  test("rejects string exceeding max", () => {
    const result = optionalStringSchema({ max: 5 }).safeParse("abcdef");
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("5");
    }
  });
});

describe("validateWithSchema", () => {
  const schema = z.object({ name: nameSchema() });

  test("returns null for valid data", () => {
    expect(validateWithSchema(schema, { name: "valid-name" })).toBeNull();
  });

  test("returns error array for invalid data", () => {
    const errors = validateWithSchema(schema, { name: "" });
    expect(errors).not.toBeNull();
    expect(errors!.length).toBeGreaterThan(0);
  });

  test("returns error array for missing fields", () => {
    const errors = validateWithSchema(schema, {});
    expect(errors).not.toBeNull();
  });
});

describe("zodResolver", () => {
  test("is a function", () => {
    expect(typeof zodResolver).toBe("function");
  });
});
