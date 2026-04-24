import { describe, test, expect } from "bun:test";
import { validateSkillForm, buildSkillMetadata } from "../pages/SkillsPage";

describe("validateSkillForm", () => {
  test("empty name returns error", () => {
    expect(validateSkillForm("", "content")).toBe("名称不能为空");
  });

  test("empty content returns error", () => {
    expect(validateSkillForm("my-skill", "")).toBe("内容不能为空");
  });

  test("valid form returns null", () => {
    expect(validateSkillForm("my-skill", "# Hello")).toBeNull();
  });
});

describe("buildSkillMetadata", () => {
  test("all empty returns undefined", () => {
    expect(buildSkillMetadata("", "")).toBeUndefined();
  });

  test("only license", () => {
    expect(buildSkillMetadata("MIT", "")).toEqual({ license: "MIT" });
  });

  test("both fields", () => {
    expect(buildSkillMetadata("MIT", "v1.0")).toEqual({ license: "MIT", compatibility: "v1.0" });
  });
});
