import { describe, expect, test } from "bun:test";
import { getSkillFormValidationError } from "../pages/agent-panel/pages/agent-skills-utils";

describe("getSkillFormValidationError", () => {
  // 名称为空时应优先返回名称必填提示。
  test("returns nameRequired when name is blank", () => {
    expect(getSkillFormValidationError("", "content")).toBe("form.nameRequired");
    expect(getSkillFormValidationError("   ", "content")).toBe("form.nameRequired");
  });

  // 内容为空时应返回内容必填提示，而不是错误复用名称提示。
  test("returns contentRequired when content is blank", () => {
    expect(getSkillFormValidationError("demo-skill", "")).toBe("form.contentRequired");
    expect(getSkillFormValidationError("demo-skill", "   ")).toBe("form.contentRequired");
  });

  // 名称和内容都填写时不应报校验错误。
  test("returns null when name and content are both present", () => {
    expect(getSkillFormValidationError("demo-skill", "# Skill")).toBeNull();
  });
});
