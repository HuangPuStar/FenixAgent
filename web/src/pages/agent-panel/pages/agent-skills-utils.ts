export type SkillFormValidationErrorKey = "form.nameRequired" | "form.contentRequired";

/**
 * 返回手动创建/编辑 skill 表单的首个必填校验错误。
 */
export function getSkillFormValidationError(name: string, content: string): SkillFormValidationErrorKey | null {
  if (!name.trim()) return "form.nameRequired";
  if (!content.trim()) return "form.contentRequired";
  return null;
}
