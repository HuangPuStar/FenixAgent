import { afterEach, describe, expect, mock, test } from "bun:test";
import type { UploadSkillFile } from "../server/services/skill-content";
import { _deps, groupUploadFilesForImport, resetSkillContentDeps } from "../server/services/skill-content";

/**
 * 上传校验用例（两个上传入口共用：`/web/config/skills/upload` 与对外 `/api/skills`）。
 *
 * 校验必须发生在写入之前：清单非法的请求不应该留下任何文件或资源行。这里直接测内容层的校验入口，
 * 用真实的名称规范化与分组实现——它们是纯函数，"没经过校验的文件不会被写入"这条保证就落在它们身上。
 */

afterEach(() => {
  resetSkillContentDeps();
});

function makeFile(skillName: string, relativePath = "SKILL.md"): UploadSkillFile {
  return { skillName, relativePath, content: "Body" };
}

describe("上传校验", () => {
  // 空上传是请求错误：没有任何文件就没有可写入的技能。
  test("空文件列表抛出验证错误", () => {
    expect(() => groupUploadFilesForImport([])).toThrow("未提供任何上传文件");
  });

  // 分组实现若把所有文件都过滤掉，必须在写入前失败，而不是继续走空导入。
  test("分组结果为空时抛出验证错误", () => {
    _deps.skillFs.groupUploadFiles = mock(() => new Map());

    expect(() => groupUploadFilesForImport([makeFile("demo")])).toThrow("未解析出任何 skill");
  });

  // 缺少 SKILL.md 的目录无法提供技能定义，整批上传都算非法。
  test("缺少 SKILL.md 抛出验证错误", () => {
    expect(() => groupUploadFilesForImport([makeFile("bad-skill", "README.md")])).toThrow(
      'Skill "bad-skill" 缺少 SKILL.md',
    );
  });

  // 名称不合法（路径穿越）在分组阶段就被拒绝，避免拼出组织目录之外的写路径。
  test("非法技能名称抛出验证错误", () => {
    expect(() => groupUploadFilesForImport([makeFile("../escape")])).toThrow("Skill 名称不合法");
  });
});
