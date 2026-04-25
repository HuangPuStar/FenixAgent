import { describe, test, expect } from "bun:test";
import { isValidAgentNameInput, isValidStepsInput } from "../pages/AgentsPage";

describe("isValidAgentNameInput", () => {
  test("valid name", () => {
    expect(isValidAgentNameInput("my-agent")).toBe(true);
  });

  test("uppercase rejected", () => {
    expect(isValidAgentNameInput("MY-AGENT")).toBe(false);
  });

  test("single char valid", () => {
    expect(isValidAgentNameInput("a")).toBe(true);
  });

  test("double hyphen rejected", () => {
    expect(isValidAgentNameInput("a--b")).toBe(false);
  });

  test("empty rejected", () => {
    expect(isValidAgentNameInput("")).toBe(false);
  });
});

describe("isValidStepsInput", () => {
  test("valid steps", () => {
    expect(isValidStepsInput("50")).toBe(true);
  });

  test("zero rejected", () => {
    expect(isValidStepsInput("0")).toBe(false);
  });

  test("over 200 rejected", () => {
    expect(isValidStepsInput("201")).toBe(false);
  });

  test("non-number rejected", () => {
    expect(isValidStepsInput("abc")).toBe(false);
  });
});

describe("isValidAgentNameInput — Task 5 回归", () => {
  test("带连字符的合法名称", () => {
    expect(isValidAgentNameInput("my-custom-agent")).toBe(true);
  });

  test("纯数字名称", () => {
    expect(isValidAgentNameInput("123")).toBe(true);
  });

  test("64 字符名称仍合法", () => {
    expect(isValidAgentNameInput("a".repeat(64))).toBe(true);
  });

  test("65 字符名称不合法", () => {
    expect(isValidAgentNameInput("a".repeat(65))).toBe(false);
  });
});

describe("isValidStepsInput — Task 5 回归", () => {
  test("边界值 1", () => {
    expect(isValidStepsInput("1")).toBe(true);
  });

  test("边界值 200", () => {
    expect(isValidStepsInput("200")).toBe(true);
  });

  test("负数", () => {
    expect(isValidStepsInput("-1")).toBe(false);
  });

  test("小数被 parseInt 截断为整数", () => {
    // parseInt("1.5") = 1, 所以 isValidStepsInput("1.5") = true
    expect(isValidStepsInput("1.5")).toBe(true);
  });
});
