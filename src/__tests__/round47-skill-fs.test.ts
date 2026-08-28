import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidSkillName,
  backupSkillDirs,
  buildImportedSkillInfos,
  buildSkillArchive,
  buildSkillMd,
  cleanupBackupDir,
  cleanupWrittenSkills,
  createBackupDir,
  createSkillArchiveBuffer,
  createSkillValidationError,
  deleteSkillDir,
  getSkillArchivePath,
  getSkillMdPath,
  getSkillOrganizationDir,
  getSkillSourceDir,
  groupUploadFiles,
  listSkillsFromDir,
  normalizeUploadPath,
  parseFrontmatter,
  readSkillDetailFromMd,
  resolveImportPlan,
  restoreFromBackup,
  writeImportFiles,
  writeSkillMd,
} from "../services/skill-fs";

function archiveEntryNames(zip: Buffer): string[] {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const names: string[] = [];

  for (let index = 0; index < count; index++) {
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf-8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

describe("round47 skill fs", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "round47-skill-fs-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // 验证错误保留调用方可识别的固定 code。
  test("createSkillValidationError attaches validation code", () => {
    const error = createSkillValidationError("坏输入");

    expect(error.message).toBe("坏输入");
    expect(error.code).toBe("VALIDATION_ERROR");
  });

  // skill 名称会去除两端空白后返回。
  test("assertValidSkillName trims a valid name", () => {
    expect(assertValidSkillName("  demo  ")).toBe("demo");
  });

  // 空名称不能参与后续文件系统路径拼接。
  test("assertValidSkillName rejects blank name", () => {
    expect(() => assertValidSkillName("   ")).toThrow("Skill 名称不合法");
  });

  // Unix 风格分隔符会被名称校验拒绝。
  test("assertValidSkillName rejects slash traversal", () => {
    expect(() => assertValidSkillName("nested/demo")).toThrow("Skill 名称不合法");
  });

  // Windows 风格分隔符同样不能绕过名称校验。
  test("assertValidSkillName rejects backslash traversal", () => {
    expect(() => assertValidSkillName("nested\\demo")).toThrow("Skill 名称不合法");
  });

  // 各路径助手从相同组织根目录推导出一致位置。
  test("path helpers derive organization source markdown and archive paths", () => {
    expect(getSkillOrganizationDir(root, "org-a")).toBe(join(root, "org-a"));
    expect(getSkillSourceDir(root, "org-a", "demo")).toBe(join(root, "org-a", "demo"));
    expect(getSkillMdPath(root, "org-a", "demo")).toBe(join(root, "org-a", "demo", "SKILL.md"));
    expect(getSkillArchivePath(root, "org-a", "demo")).toBe(join(root, "org-a", "demo.zip"));
  });

  // frontmatter 的标量与复合 YAML 值都会收敛到字符串 metadata。
  test("parseFrontmatter stringifies scalar null and collection metadata", () => {
    const parsed = parseFrontmatter(
      "---\ntitle: Demo\nrank: 3\nenabled: false\nempty: null\ntags:\n  - alpha\n---\n正文",
    );

    expect(parsed.metadata).toEqual({ title: "Demo", rank: "3", enabled: "false", empty: "null", tags: "- alpha" });
    expect(parsed.content).toBe("正文");
  });

  // 多行字段用块标量写入后仍可由真实 YAML 解析回原值。
  test("buildSkillMd preserves multiline metadata through parsing", () => {
    const markdown = buildSkillMd("demo", "第一行\n第二行", "正文", { owner: "team-a" });

    expect(parseFrontmatter(markdown)).toEqual({
      metadata: { name: "demo", description: "第一行\n第二行\n", owner: "team-a" },
      content: "正文",
    });
  });

  // 上传路径统一转换 Windows 分隔符且移除外围空白。
  test("normalizeUploadPath normalizes Windows separators", () => {
    expect(normalizeUploadPath("  references\\guide.md ")).toBe("references/guide.md");
  });

  // 绝对上传路径不能写入 skill 目录外。
  test("normalizeUploadPath rejects absolute paths", () => {
    expect(() => normalizeUploadPath("/etc/passwd")).toThrow("上传文件路径无效");
  });

  // 父目录片段不能绕过上传目标目录隔离。
  test("normalizeUploadPath rejects parent segments", () => {
    expect(() => normalizeUploadPath("references/../secret.txt")).toThrow("上传文件路径无效");
  });

  // 分组会保留内容并使用规范化后的相对路径。
  test("groupUploadFiles groups normalized files by skill", () => {
    const grouped = groupUploadFiles([
      { skillName: "demo", relativePath: "SKILL.md", content: "one" },
      { skillName: "demo", relativePath: "docs\\guide.md", content: "two" },
      { skillName: "other", relativePath: "SKILL.md", content: "three" },
    ]);

    expect(grouped.get("demo")).toEqual([
      { skillName: "demo", relativePath: "SKILL.md", content: "one" },
      { skillName: "demo", relativePath: "docs/guide.md", content: "two" },
    ]);
    expect(grouped.get("other")).toHaveLength(1);
  });

  // 等价规范化路径在同一 skill 中被视为重复文件。
  test("groupUploadFiles rejects duplicate normalized paths", () => {
    expect(() =>
      groupUploadFiles([
        { skillName: "demo", relativePath: "docs/guide.md", content: "one" },
        { skillName: "demo", relativePath: "docs\\guide.md", content: "two" },
      ]),
    ).toThrow('Skill "demo" 包含重复文件');
  });

  // 空目录也能生成结构完整且零条目的 zip 内容。
  test("createSkillArchiveBuffer creates an empty archive", async () => {
    const sourceDir = join(root, "empty");
    await mkdir(sourceDir);

    const archive = await createSkillArchiveBuffer(sourceDir);

    expect(archiveEntryNames(archive)).toEqual([]);
    expect(archive.readUInt32LE(archive.length - 22)).toBe(0x06054b50);
  });

  // 非目录源路径生成归档时返回明确的验证错误。
  test("createSkillArchiveBuffer rejects a source file", async () => {
    const sourceFile = join(root, "source.txt");
    await writeFile(sourceFile, "not a directory");

    await expect(createSkillArchiveBuffer(sourceFile)).rejects.toThrow("Skill 源目录不存在");
  });

  // 归档会递归包含嵌套文件，并可选包裹下载根目录。
  test("buildSkillArchive writes nested files under requested root directory", async () => {
    const sourceDir = join(root, "demo");
    const archivePath = join(root, "artifacts", "demo.zip");
    await mkdir(join(sourceDir, "references"), { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Demo");
    await writeFile(join(sourceDir, "references", "guide.md"), "指南");

    await buildSkillArchive(sourceDir, archivePath, { rootDirectory: "demo" });

    expect(archiveEntryNames(await readFile(archivePath))).toEqual(["demo/SKILL.md", "demo/references/guide.md"]);
  });

  // 不存在的扫描根目录安全地返回空列表。
  test("listSkillsFromDir returns empty for missing directory", async () => {
    await expect(listSkillsFromDir(join(root, "missing"))).resolves.toEqual([]);
  });

  // 扫描忽略私有目录、普通文件及没有 SKILL.md 的目录。
  test("listSkillsFromDir scans only public directories containing SKILL.md", async () => {
    await mkdir(join(root, "demo"));
    await mkdir(join(root, "_private"));
    await mkdir(join(root, "incomplete"));
    await writeFile(join(root, "demo", "SKILL.md"), "---\ndescription: 可见技能\n---\n正文");
    await writeFile(join(root, "_private", "SKILL.md"), "---\ndescription: 私有\n---\n正文");
    await writeFile(join(root, "loose.txt"), "忽略");

    await expect(listSkillsFromDir(root)).resolves.toEqual([
      { name: "demo", enabled: true, description: "可见技能", path: join(root, "demo", "SKILL.md") },
    ]);
  });

  // 不存在的 markdown 不触发读取异常，而是返回 null。
  test("readSkillDetailFromMd returns null for missing file", async () => {
    await expect(readSkillDetailFromMd(join(root, "missing.md"))).resolves.toBeNull();
  });

  // 已存在的 markdown 返回解析后的 metadata 与正文。
  test("readSkillDetailFromMd parses existing markdown", async () => {
    const mdPath = join(root, "SKILL.md");
    await writeFile(mdPath, "---\ndescription: 详情\n---\n# Body");

    await expect(readSkillDetailFromMd(mdPath)).resolves.toEqual({
      metadata: { description: "详情" },
      content: "# Body",
    });
  });

  // 写入 markdown 会自动建立缺失父目录并保存 frontmatter。
  test("writeSkillMd creates directory and markdown", async () => {
    const skillDir = join(root, "nested", "demo");

    const mdPath = await writeSkillMd(skillDir, "demo", "说明", "正文", { version: "1" });

    expect(mdPath).toBe(join(skillDir, "SKILL.md"));
    expect(parseFrontmatter(await readFile(mdPath, "utf-8"))).toEqual({
      metadata: { name: "demo", description: "说明", version: "1" },
      content: "正文",
    });
  });

  // 删除已存在 skill 目录会递归清理全部内容。
  test("deleteSkillDir removes an existing directory", async () => {
    const skillDir = join(root, "demo");
    await mkdir(skillDir);
    await writeFile(join(skillDir, "SKILL.md"), "正文");

    await deleteSkillDir(skillDir);

    expect(existsSync(skillDir)).toBe(false);
  });

  // 删除不存在 skill 目录是幂等操作。
  test("deleteSkillDir tolerates missing directory", async () => {
    await expect(deleteSkillDir(join(root, "missing"))).resolves.toBeUndefined();
  });

  // overwrite 策略保留所有待写入项且不产生跳过项。
  test("resolveImportPlan keeps conflicts for overwrite strategy", () => {
    const grouped = new Map([
      ["existing", []],
      ["new", []],
    ]);

    expect(resolveImportPlan(grouped, [{ name: "existing", enabled: true, path: "old" }], "overwrite")).toEqual({
      pendingEntries: [
        ["existing", []],
        ["new", []],
      ],
      skipped: [],
    });
  });

  // ignore 策略仅排除冲突项并报告被跳过名称。
  test("resolveImportPlan skips conflicts for ignore strategy", () => {
    const grouped = new Map([
      ["existing", []],
      ["new", []],
    ]);

    expect(resolveImportPlan(grouped, [{ name: "existing", enabled: true, path: "old" }], "ignore")).toEqual({
      pendingEntries: [["new", []]],
      skipped: ["existing"],
    });
  });

  // 导入写入受 targetDir 约束，并创建嵌套相对目录。
  test("writeImportFiles writes nested content beneath target directory", async () => {
    const targetDir = join(root, "target");

    const names = await writeImportFiles(targetDir, [
      [
        "demo",
        [
          { skillName: "demo", relativePath: "SKILL.md", content: "---\ndescription: 导入\n---\n正文" },
          { skillName: "demo", relativePath: "references/guide.md", content: "指南" },
        ],
      ],
    ]);

    expect(names).toEqual(["demo"]);
    expect(await readFile(join(targetDir, "demo", "references", "guide.md"), "utf-8")).toBe("指南");
  });

  // 已写入目录可构建为带指定 enabled 状态的 SkillInfo。
  test("buildImportedSkillInfos reads descriptions with supplied enabled flag", async () => {
    await writeImportFiles(root, [
      ["demo", [{ skillName: "demo", relativePath: "SKILL.md", content: "---\ndescription: 已导入\n---\n正文" }]],
    ]);

    await expect(buildImportedSkillInfos(root, ["demo"], false)).resolves.toEqual([
      { name: "demo", enabled: false, description: "已导入", path: join(root, "demo", "SKILL.md") },
    ]);
  });

  // 备份会同时记录存在目录的快照和不存在目录的 null 标记。
  test("backupSkillDirs snapshots existing directories and marks missing ones", async () => {
    const targetDir = join(root, "target");
    const backupRoot = join(root, "backup");
    await mkdir(join(targetDir, "demo"), { recursive: true });
    await writeFile(join(targetDir, "demo", "SKILL.md"), "原始");

    const snapshots = await backupSkillDirs(backupRoot, targetDir, ["demo", "missing"]);

    expect(snapshots).toEqual(
      new Map([
        ["demo", join(backupRoot, "demo")],
        ["missing", null],
      ]),
    );
    expect(await readFile(join(backupRoot, "demo", "SKILL.md"), "utf-8")).toBe("原始");
  });

  // 清理仅删除指定的已写入目录，其他 skill 保持隔离。
  test("cleanupWrittenSkills removes only named directories", async () => {
    await mkdir(join(root, "remove"));
    await mkdir(join(root, "keep"));

    await cleanupWrittenSkills(root, ["remove", "missing"]);

    expect(existsSync(join(root, "remove"))).toBe(false);
    expect(existsSync(join(root, "keep"))).toBe(true);
  });

  // 恢复只复制实际存在的快照，不会创建 null 或丢失备份目录。
  test("restoreFromBackup restores only existing snapshots", async () => {
    const backupRoot = join(root, "backup");
    const targetDir = join(root, "target");
    await mkdir(join(backupRoot, "demo"), { recursive: true });
    await writeFile(join(backupRoot, "demo", "SKILL.md"), "恢复内容");

    await restoreFromBackup(
      new Map([
        ["demo", join(backupRoot, "demo")],
        ["missing", null],
      ]),
      targetDir,
    );

    expect(await readFile(join(targetDir, "demo", "SKILL.md"), "utf-8")).toBe("恢复内容");
    expect(existsSync(join(targetDir, "missing"))).toBe(false);
  });

  // 临时备份目录使用前缀创建并可在结束时安全清理。
  test("createBackupDir and cleanupBackupDir manage isolated temporary directory", async () => {
    const backupDir = await createBackupDir("round47-backup-");
    await writeFile(join(backupDir, "marker"), "x");

    await cleanupBackupDir(backupDir);

    expect(existsSync(backupDir)).toBe(false);
  });
});
