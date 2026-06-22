import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertValidSkillName,
  buildSkillArchive,
  deleteSkillArchive,
  getSkillArchivePath,
  getSkillMdPath,
  getSkillOrganizationDir,
  getSkillSourceDir,
} from "../services/skill-fs";

function readCentralDirectoryNames(zip: Buffer): string[] {
  const endOffset = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(endOffset).toBeGreaterThanOrEqual(0);
  const count = zip.readUInt16LE(endOffset + 10);
  let offset = zip.readUInt32LE(endOffset + 16);
  const names: string[] = [];

  for (let i = 0; i < count; i++) {
    expect(zip.readUInt32LE(offset)).toBe(0x02014b50);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    names.push(zip.subarray(offset + 46, offset + 46 + nameLength).toString("utf-8"));
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return names;
}

describe("skill fs archive", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-fs-archive-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  // 路径工具统一从 skill root 派生 source 与 zip artifact。
  test("path helpers build source and archive paths", () => {
    expect(getSkillOrganizationDir(root, "org-a")).toBe(join(root, "org-a"));
    expect(getSkillSourceDir(root, "org-a", "demo")).toBe(join(root, "org-a", "demo"));
    expect(getSkillMdPath(root, "org-a", "demo")).toBe(join(root, "org-a", "demo", "SKILL.md"));
    expect(getSkillArchivePath(root, "org-a", "demo")).toBe(join(root, "org-a", "demo.zip"));
  });

  // 非法名称会在进入路径拼接前被拒绝。
  test("skill names reject empty and traversal-like values", () => {
    for (const name of ["", ".", "..", "a/b", "a\\b"]) {
      expect(() => assertValidSkillName(name)).toThrow(/Skill 名称不合法/);
    }
  });

  // 生成的 zip 条目直接包含 skill 目录内容，不额外套一层目录。
  test("buildSkillArchive writes central directory entries", async () => {
    const sourceDir = getSkillSourceDir(root, "org-a", "demo");
    await mkdir(join(sourceDir, "references"), { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Demo", "utf-8");
    await writeFile(join(sourceDir, "references", "ref.md"), "ref", "utf-8");

    const archivePath = getSkillArchivePath(root, "org-a", "demo");
    await buildSkillArchive(sourceDir, archivePath);

    const names = readCentralDirectoryNames(await readFile(archivePath));
    expect(names).toEqual(["SKILL.md", "references/ref.md"]);
  });

  // Web 下载需要显式包一层 skill 目录，避免解压后把 skill 文件直接散在目标位置。
  test("buildSkillArchive can wrap entries in a root directory", async () => {
    const sourceDir = getSkillSourceDir(root, "org-a", "demo");
    await mkdir(join(sourceDir, "references"), { recursive: true });
    await writeFile(join(sourceDir, "SKILL.md"), "# Demo", "utf-8");
    await writeFile(join(sourceDir, "references", "ref.md"), "ref", "utf-8");

    const archivePath = getSkillArchivePath(root, "org-a", "demo");
    await buildSkillArchive(sourceDir, archivePath, { rootDirectory: "demo" });

    const names = readCentralDirectoryNames(await readFile(archivePath));
    expect(names).toEqual(["demo/SKILL.md", "demo/references/ref.md"]);
  });

  // 删除 archive 不要求文件存在，存在时会被清理掉。
  test("deleteSkillArchive removes archive file", async () => {
    const archivePath = getSkillArchivePath(root, "org-a", "demo");
    await mkdir(join(root, "org-a"), { recursive: true });
    await writeFile(archivePath, "zip", "utf-8");

    await deleteSkillArchive(root, "org-a", "demo");

    expect(existsSync(archivePath)).toBe(false);
  });
});
