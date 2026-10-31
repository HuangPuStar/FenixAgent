/** 校验平台 Skill 名称：1–64 个 ASCII 小写字母、数字和单连字符，不自动改写输入。 */
export function isValidSkillName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length >= 1 &&
    name.length <= 64 &&
    !/[^a-z0-9-]/.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-") &&
    !name.includes("--")
  );
}
