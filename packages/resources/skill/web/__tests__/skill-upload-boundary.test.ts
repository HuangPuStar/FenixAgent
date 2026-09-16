import { describe, expect, test } from "bun:test";
import { buildSkillUploadFormData, parseSkillUploadFiles, validateUploadBatch } from "../lib/skill-upload";
import type { UploadSkillSummary } from "../types/config";

function file(path: string): File {
  const item = new File(["content"], path.split(/[\\/]/).at(-1) ?? "file.txt");
  Object.defineProperty(item, "webkitRelativePath", { value: path });
  return item;
}

function skill(skillName: string, hasSkillMd: boolean, paths = ["SKILL.md"]): UploadSkillSummary {
  return {
    skillName,
    hasSkillMd,
    fileCount: paths.length,
    files: paths.map((relativePath) => ({ relativePath, file: file(`${skillName}/${relativePath}`) })),
  };
}

function getManifest(formData: FormData): Array<{ skillName: string; relativePath: string }> {
  const value = formData.get("manifest");
  if (typeof value !== "string") throw new Error("expected manifest");
  return JSON.parse(value) as Array<{ skillName: string; relativePath: string }>;
}

describe("技能上传纯逻辑边界", () => {
  // 顶层带入口文件的目录应被识别为技能。
  test("解析顶层技能目录", () =>
    expect(parseSkillUploadFiles([file("demo/SKILL.md")])[0]).toMatchObject({ skillName: "demo", hasSkillMd: true }));
  // 单一包装目录应被剥离。
  test("剥离包装目录", () => expect(parseSkillUploadFiles([file("bundle/demo/SKILL.md")])[0]?.skillName).toBe("demo"));
  // 多个顶层目录不应被误判为包装目录。
  test("保留多个顶层技能", () =>
    expect(parseSkillUploadFiles([file("one/SKILL.md"), file("two/SKILL.md")]).map((item) => item.skillName)).toEqual([
      "one",
      "two",
    ]));
  // Windows 分隔符必须归一化。
  test("归一化 Windows 分隔符", () =>
    expect(parseSkillUploadFiles([file("demo\\SKILL.md")])[0]?.files[0]?.relativePath).toBe("SKILL.md"));
  // 前导斜杠不能生成空目录名。
  test("移除前导斜杠", () => expect(parseSkillUploadFiles([file("///demo/SKILL.md")])[0]?.skillName).toBe("demo"));
  // 仅目录名没有可上传内容。
  test("忽略仅目录条目", () => expect(parseSkillUploadFiles([file("demo")])).toEqual([]));
  // 同目录文件应合并计数。
  test("合并技能内文件", () =>
    expect(parseSkillUploadFiles([file("demo/SKILL.md"), file("demo/a.txt")])[0]?.fileCount).toBe(2));
  // 入口文件大小写需精确匹配。
  test("区分入口文件大小写", () => expect(parseSkillUploadFiles([file("demo/skill.md")])[0]?.hasSkillMd).toBe(false));
  // 非入口嵌套项应回退顶层目录。
  test("嵌套失败回退顶层", () =>
    expect(parseSkillUploadFiles([file("wrapper/readme.txt")])[0]?.skillName).toBe("wrapper"));
  // 单层包装目录中的文件应移除包装层。
  test("嵌套文件移除包装层", () =>
    expect(parseSkillUploadFiles([file("demo/docs/a.md")])[0]?.files[0]?.relativePath).toBe("a.md"));
  // 空批次必须返回明确错误。
  test("拒绝空批次", () => expect(validateUploadBatch([])).toBe("No skill folders found"));
  // 全部缺失入口时应列出名称。
  test("报告缺失入口", () =>
    expect(validateUploadBatch([skill("one", false), skill("two", false)])).toBe("Missing SKILL.md in: one, two"));
  // 合法和不完整技能混合时允许上传合法部分。
  test("允许混合批次", () => expect(validateUploadBatch([skill("good", true), skill("draft", false)])).toBeNull());
  // 大小写差异不得绕过重复校验。
  test("拒绝大小写重复", () =>
    expect(validateUploadBatch([skill("Demo", true), skill("demo", true)])).toBe(
      "Duplicate skill names in upload: demo",
    ));
  // 首尾空格不得绕过重复校验。
  test("拒绝空白归一化重复", () =>
    expect(validateUploadBatch([skill(" demo ", true), skill("Demo", true)])).toBe(
      "Duplicate skill names in upload: Demo",
    ));
  // 单个完整技能应通过校验。
  test("接受单个完整技能", () => expect(validateUploadBatch([skill("demo", true)])).toBeNull());
  // 不同名称的完整技能可同批上传。
  test("接受不同名称技能", () => expect(validateUploadBatch([skill("one", true), skill("two", true)])).toBeNull());
  // 表单清单必须排除无入口技能。
  test("清单排除无效技能", () =>
    expect(getManifest(buildSkillUploadFormData([skill("good", true), skill("bad", false)]))).toEqual([
      { skillName: "good", relativePath: "SKILL.md" },
    ]));
  // 清单必须包含技能内全部文件。
  test("清单包含全部路径", () =>
    expect(getManifest(buildSkillUploadFormData([skill("demo", true, ["SKILL.md", "docs/a.md"])]))).toHaveLength(2));
  // 清单顺序应与输入顺序一致。
  test("清单保持输入顺序", () =>
    expect(
      getManifest(buildSkillUploadFormData([skill("second", true), skill("first", true)])).map(
        (item) => item.skillName,
      ),
    ).toEqual(["second", "first"]));
  // 未给策略时不能发送空字段。
  test("省略空冲突策略", () =>
    expect(buildSkillUploadFormData([skill("demo", true)]).has("conflictStrategy")).toBe(false));
  // overwrite 策略必须传递。
  test("传递覆盖策略", () =>
    expect(buildSkillUploadFormData([skill("demo", true)], "overwrite").get("conflictStrategy")).toBe("overwrite"));
  // ignore 策略必须传递。
  test("传递忽略策略", () =>
    expect(buildSkillUploadFormData([skill("demo", true)], "ignore").get("conflictStrategy")).toBe("ignore"));
  // 空输入应生成可解析空清单。
  test("空输入生成空清单", () => expect(getManifest(buildSkillUploadFormData([]))).toEqual([]));
  // 所有有效文件都必须写入 multipart。
  test("写入所有有效文件", () =>
    expect(
      buildSkillUploadFormData([skill("demo", true, ["SKILL.md", "run.ts"]), skill("bad", false)]).getAll("files"),
    ).toHaveLength(2));
});
