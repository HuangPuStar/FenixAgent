import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildImportedSkillInfos, parseFrontmatter } from "../services/skill-fs";

describe("skill frontmatter parsing", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-frontmatter-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // YAML 折叠块语法会被解析成完整 description，而不是字面量 ">"。
  test("parseFrontmatter resolves folded description blocks", () => {
    const raw = `---
name: intelligentTeam-labor-analyzer
description: >
  班组长劳效异常数据分析。
  当用户提到以下意图时进入本 Skill：
  劳效分析、劳效异常、低效人员、劳效趋势、劳效报警、效率分析、班组劳效。
uses:
  - tool-platform
---

# Demo
`;

    const parsed = parseFrontmatter(raw);

    expect(parsed.metadata.description).toBe(
      "班组长劳效异常数据分析。 当用户提到以下意图时进入本 Skill： 劳效分析、劳效异常、低效人员、劳效趋势、劳效报警、效率分析、班组劳效。\n",
    );
    expect(parsed.metadata.uses).toBe("- tool-platform");
    expect(parsed.content).toContain("# Demo");
  });

  // 导入目录后的 SkillInfo.description 应该使用真实 YAML 解析结果。
  test("buildImportedSkillInfos reads folded descriptions from SKILL.md", async () => {
    const skillDir = join(root, "demo");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: demo
description: >
  第一行描述。
  第二行描述。
---

Body
`,
      "utf-8",
    );

    const infos = await buildImportedSkillInfos(root, ["demo"]);

    expect(infos[0]?.description).toBe("第一行描述。 第二行描述。\n");
    expect((await readFile(join(skillDir, "SKILL.md"), "utf-8")).includes("description: >")).toBe(true);
  });
});
