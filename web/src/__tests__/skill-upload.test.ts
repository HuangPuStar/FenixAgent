import { describe, expect, test } from "bun:test";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../lib/skill-upload";

function createUploadFile(path: string, content: string) {
  const file = new File([content], path.split("/").pop() || "file.txt");
  Object.defineProperty(file, "webkitRelativePath", {
    value: path,
    configurable: true,
  });
  return file;
}

describe("parseSkillUploadFiles", () => {
  test("按一级目录聚合并忽略根级散文件", () => {
    const items = parseSkillUploadFiles([
      createUploadFile("skill-a/SKILL.md", "# A"),
      createUploadFile("skill-a/references/ref.md", "ref"),
      createUploadFile("skill-b/SKILL.md", "# B"),
      createUploadFile("loose.md", "loose"),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ skillName: "skill-a", fileCount: 2, hasSkillMd: true });
    expect(items[1]).toMatchObject({ skillName: "skill-b", fileCount: 1, hasSkillMd: true });
  });

  test("选择父目录时按其一级子目录识别多个 skill", () => {
    const items = parseSkillUploadFiles([
      createUploadFile("skills/skill-a/SKILL.md", "# A"),
      createUploadFile("skills/skill-a/references/ref.md", "ref"),
      createUploadFile("skills/skill-b/SKILL.md", "# B"),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ skillName: "skill-a", fileCount: 2, hasSkillMd: true });
    expect(items[1]).toMatchObject({ skillName: "skill-b", fileCount: 1, hasSkillMd: true });
  });
});

describe("validateUploadBatch", () => {
  test("空批次返回错误", () => {
    expect(validateUploadBatch([])).toBe("未解析出任何 skill 文件夹");
  });

  test("缺少 SKILL.md 返回错误", () => {
    expect(validateUploadBatch([{ skillName: "broken", fileCount: 1, hasSkillMd: false, files: [] }])).toBe(
      "以下目录缺少 SKILL.md：broken",
    );
  });

  test("混合有效和无效目录时允许继续导入有效项", () => {
    expect(
      validateUploadBatch([
        { skillName: "skill-a", fileCount: 1, hasSkillMd: true, files: [] },
        { skillName: "broken", fileCount: 1, hasSkillMd: false, files: [] },
      ]),
    ).toBeNull();
  });

  test("重复 skill 名返回错误", () => {
    expect(
      validateUploadBatch([
        { skillName: "skill-a", fileCount: 1, hasSkillMd: true, files: [] },
        { skillName: "Skill-A", fileCount: 1, hasSkillMd: true, files: [] },
      ]),
    ).toContain("本次上传批次包含重复 skill 名");
  });
});

describe("buildSkillUploadFormData", () => {
  test("manifest 顺序与 files 顺序一致", () => {
    const items = parseSkillUploadFiles([
      createUploadFile("skill-a/SKILL.md", "# A"),
      createUploadFile("skill-a/references/ref.md", "ref"),
    ]);

    const formData = buildSkillUploadFormData(items, "overwrite");
    const manifest = JSON.parse(String(formData.get("manifest")));
    const files = formData.getAll("files") as File[];

    expect(manifest).toEqual([
      { skillName: "skill-a", relativePath: "SKILL.md" },
      { skillName: "skill-a", relativePath: "references/ref.md" },
    ]);
    expect(files.map((file) => file.name)).toEqual(["SKILL.md", "ref.md"]);
    expect(formData.get("conflictStrategy")).toBe("overwrite");
  });

  test("未传策略时不追加 conflictStrategy", () => {
    const items = parseSkillUploadFiles([createUploadFile("skill-a/SKILL.md", "# A")]);

    const formData = buildSkillUploadFormData(items);
    expect(formData.get("conflictStrategy")).toBeNull();
  });

  test("构建 FormData 时跳过缺少 SKILL.md 的目录", () => {
    const formData = buildSkillUploadFormData([
      {
        skillName: "skill-a",
        fileCount: 1,
        hasSkillMd: true,
        files: [{ relativePath: "SKILL.md", file: createUploadFile("skill-a/SKILL.md", "# A") }],
      },
      {
        skillName: "broken",
        fileCount: 1,
        hasSkillMd: false,
        files: [{ relativePath: "readme.md", file: createUploadFile("broken/readme.md", "x") }],
      },
    ]);

    expect(JSON.parse(String(formData.get("manifest")))).toEqual([{ skillName: "skill-a", relativePath: "SKILL.md" }]);
    expect((formData.getAll("files") as File[]).map((file) => file.name)).toEqual(["SKILL.md"]);
  });
});
