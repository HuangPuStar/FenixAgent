import { describe, expect, test } from "bun:test";

import {
  intRangeSchema,
  nameSchema,
  optionalFloatSchema,
  optionalStringSchema,
  requiredStringSchema,
  validateWithSchema,
} from "../lib/form-utils";

describe("form schema helpers", () => {
  // 名称 schema 只接受约定的短横线分隔小写标识，并使用调用方标签生成错误信息。
  test("nameSchema validates slug-like names with custom labels", () => {
    const schema = nameSchema({ label: "Agent" });

    expect(schema.parse("agent-2")).toBe("agent-2");
    expect(schema.safeParse("Agent-2").error?.issues[0]?.message).toBe(
      "Agent can only contain lowercase letters, digits, and hyphens",
    );
    expect(schema.safeParse("agent--2").success).toBe(false);
    expect(schema.safeParse("a".repeat(65)).error?.issues[0]?.message).toBe("Agent must be at most 64 characters");
  });

  // 整数范围 schema 会转换合法输入，并区分非数值、非整数与超出边界的场景。
  test("intRangeSchema transforms and validates bounded integers", () => {
    const schema = intRangeSchema({ label: "Steps", min: 2, max: 4 });

    expect(schema.parse("3")).toBe(3);
    expect(schema.safeParse("three").error?.issues[0]?.message).toBe("Steps must be an integer");
    expect(schema.parse("2.5")).toBe(2);
    expect(schema.safeParse("1").error?.issues[0]?.message).toBe("Steps must be between 2 and 4");
    expect(schema.safeParse("5").error?.issues[0]?.message).toBe("Steps must be between 2 and 4");
  });

  // 可选浮点 schema 将空白输入归一为 undefined，并校验实际数值范围。
  test("optionalFloatSchema handles blank values and numeric bounds", () => {
    const schema = optionalFloatSchema({ label: "Temperature", min: 0, max: 1 });

    expect(schema.parse("  ")).toBeUndefined();
    expect(schema.parse("0.25")).toBe(0.25);
    expect(schema.safeParse("invalid").error?.issues[0]?.message).toBe("Temperature must be a number");
    expect(schema.safeParse("1.5").error?.issues[0]?.message).toBe("Temperature must be between 0 and 1");
  });

  // 字符串 schema 保持必填与可选字段不同的长度约束，并由统一助手提取全部错误消息。
  test("string schemas and validateWithSchema expose validation messages", () => {
    const content = requiredStringSchema({ label: "Content", max: 3 });
    const description = optionalStringSchema({ max: 2 });

    expect(content.parse("abc")).toBe("abc");
    expect(validateWithSchema(content, "")).toEqual(["Content is required"]);
    expect(validateWithSchema(content, "abcd")).toEqual(["Content must be at most 3 characters"]);
    expect(validateWithSchema(description, "ok")).toBeNull();
    expect(validateWithSchema(description, "long")).toEqual(["Must be at most 2 characters"]);
  });
});
