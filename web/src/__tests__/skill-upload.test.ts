import { describe, expect, test } from "bun:test";
import { buildSkillUploadFormData, parseSkillUploadFiles } from "../lib/skill-upload";

function makeUploadFile(path: string, content = "---\nname: ignored\n---\nBody"): File {
  const segments = path.split("/");
  const file = new File([content], segments[segments.length - 1] ?? "SKILL.md", { type: "text/markdown" });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

describe("skill upload helpers", () => {
  // 测试上传载荷使用目录名作为 skill 身份，并携带冲突策略。
  test("buildSkillUploadFormData uses directory name and appends conflictStrategy", () => {
    const items = parseSkillUploadFiles([makeUploadFile("bundle/demo/SKILL.md")]);
    const formData = buildSkillUploadFormData(items, "overwrite");
    const manifest = JSON.parse(formData.get("manifest") as string) as Array<{ skillName: string }>;

    expect(formData.get("conflictStrategy")).toBe("overwrite");
    expect(manifest[0]?.skillName).toBe("demo");
  });
});
