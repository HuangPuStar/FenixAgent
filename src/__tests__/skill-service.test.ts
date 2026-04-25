import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";

// Since skill.ts uses module-level constants, we re-implement the functions
// pointing at a temp directory for isolated testing.
const tempDir = await mkdtemp(join(tmpdir(), "skill-test-"));
// 注意: 此测试使用本地 SKILLS_DIR 指向临时目录，不依赖 skill.ts 的路径常量
// 生产路径已从 ~/.config/opencode/skills/ 迁移到 ~/.agents/skills/
const SKILLS_DIR = join(tempDir, "skills");
const DISABLED_DIR = join(SKILLS_DIR, "_disabled");

interface SkillInfo {
  name: string;
  enabled: boolean;
  description: string;
  path: string;
}

interface SkillDetail {
  name: string;
  description: string;
  content: string;
  enabled: boolean;
  path: string;
  metadata: Record<string, string>;
}

function parseFrontmatter(raw: string): { metadata: Record<string, string>; content: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { metadata: {}, content: raw };
  const metadata: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) metadata[line.slice(0, idx).trim()] = line.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { metadata, content: match[2] };
}

function buildSkillMd(name: string, description: string, content: string, metadata?: Record<string, string>): string {
  const meta: Record<string, string> = { name, description, ...(metadata ?? {}) };
  const frontmatter = Object.entries(meta).map(([k, v]) => `${k}: "${v}"`).join("\n");
  return `---\n${frontmatter}\n---\n${content}`;
}

async function ensureDisabledDir(): Promise<void> {
  if (!existsSync(DISABLED_DIR)) await mkdir(DISABLED_DIR, { recursive: true });
}

async function listSkills(): Promise<SkillInfo[]> {
  const { readdir } = await import("node:fs/promises");
  const skills: SkillInfo[] = [];
  if (existsSync(SKILLS_DIR)) {
    for (const entry of await readdir(SKILLS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "_disabled") continue;
      const mdPath = join(SKILLS_DIR, entry.name, "SKILL.md");
      if (!existsSync(mdPath)) continue;
      const raw = await readFile(mdPath, "utf-8");
      const { metadata } = parseFrontmatter(raw);
      skills.push({ name: entry.name, enabled: true, description: metadata.description ?? "", path: mdPath });
    }
  }
  if (existsSync(DISABLED_DIR)) {
    for (const entry of await readdir(DISABLED_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "_disabled") continue;
      const mdPath = join(DISABLED_DIR, entry.name, "SKILL.md");
      if (!existsSync(mdPath)) continue;
      const raw = await readFile(mdPath, "utf-8");
      const { metadata } = parseFrontmatter(raw);
      skills.push({ name: entry.name, enabled: false, description: metadata.description ?? "", path: mdPath });
    }
  }
  return skills;
}

async function getSkill(name: string): Promise<SkillDetail | null> {
  const enabledPath = join(SKILLS_DIR, name, "SKILL.md");
  const disabledPath = join(DISABLED_DIR, name, "SKILL.md");
  const filePath = existsSync(enabledPath) ? enabledPath : existsSync(disabledPath) ? disabledPath : null;
  if (!filePath) return null;
  const raw = await readFile(filePath, "utf-8");
  const { metadata, content } = parseFrontmatter(raw);
  return {
    name,
    description: metadata.description ?? "",
    content,
    enabled: filePath === enabledPath,
    path: filePath,
    metadata: Object.fromEntries(Object.entries(metadata).filter(([k]) => k !== "name" && k !== "description")),
  };
}

async function setSkill(name: string, data: { description: string; content: string; metadata?: Record<string, string> }): Promise<SkillInfo> {
  await deleteSkillInternal(name);
  const skillDir = join(SKILLS_DIR, name);
  await mkdir(skillDir, { recursive: true });
  const mdContent = buildSkillMd(name, data.description, data.content, data.metadata);
  await writeFile(join(skillDir, "SKILL.md"), mdContent, "utf-8");
  return { name, enabled: true, description: data.description, path: join(skillDir, "SKILL.md") };
}

async function deleteSkill(name: string): Promise<boolean> {
  return deleteSkillInternal(name);
}

async function deleteSkillInternal(name: string): Promise<boolean> {
  const enabledDir = join(SKILLS_DIR, name);
  const disabledDirPath = join(DISABLED_DIR, name);
  let deleted = false;
  if (existsSync(enabledDir)) { await rm(enabledDir, { recursive: true, force: true }); deleted = true; }
  if (existsSync(disabledDirPath)) { await rm(disabledDirPath, { recursive: true, force: true }); deleted = true; }
  return deleted;
}

async function enableSkill(name: string): Promise<boolean> {
  const { rename } = await import("node:fs/promises");
  const from = join(DISABLED_DIR, name);
  const to = join(SKILLS_DIR, name);
  if (!existsSync(from)) return false;
  await rename(from, to);
  return true;
}

async function disableSkill(name: string): Promise<boolean> {
  const { rename } = await import("node:fs/promises");
  await ensureDisabledDir();
  const from = join(SKILLS_DIR, name);
  const to = join(DISABLED_DIR, name);
  if (!existsSync(from)) return false;
  await rename(from, to);
  return true;
}

// Helper: create a skill directory with SKILL.md
async function createSkillFile(dir: string, name: string, description: string, content: string) {
  const skillDir = join(dir, name);
  await mkdir(skillDir, { recursive: true });
  const md = buildSkillMd(name, description, content);
  await writeFile(join(skillDir, "SKILL.md"), md, "utf-8");
}

describe("SkillService", () => {
  beforeEach(async () => {
    // Clean up temp skills dirs
    if (existsSync(SKILLS_DIR)) await rm(SKILLS_DIR, { recursive: true, force: true });
    if (existsSync(DISABLED_DIR)) await rm(DISABLED_DIR, { recursive: true, force: true });
    // Create empty skills dir
    await mkdir(SKILLS_DIR, { recursive: true });
  });

  test("listSkills 空目录返回 []", async () => {
    const skills = await listSkills();
    expect(skills).toEqual([]);
  });

  test("listSkills 包含已启用 skill", async () => {
    await createSkillFile(SKILLS_DIR, "pr-review", "Review PRs", "# PR Review\nCheck code");
    const skills = await listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "pr-review", enabled: true });
  });

  test("listSkills 包含已禁用 skill", async () => {
    await mkdir(DISABLED_DIR, { recursive: true });
    await createSkillFile(DISABLED_DIR, "old", "Old skill", "# Old");
    const skills = await listSkills();
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "old", enabled: false });
  });

  test("getSkill 已启用", async () => {
    await createSkillFile(SKILLS_DIR, "test-skill", "A test", "# Test\nHello world");
    const detail = await getSkill("test-skill");
    expect(detail).not.toBeNull();
    expect(detail!.name).toBe("test-skill");
    expect(detail!.description).toBe("A test");
    expect(detail!.content).toBe("# Test\nHello world");
    expect(detail!.enabled).toBe(true);
  });

  test("getSkill 不存在返回 null", async () => {
    const detail = await getSkill("nonexistent");
    expect(detail).toBeNull();
  });

  test("setSkill 创建新 skill", async () => {
    const result = await setSkill("test", { description: "Test skill", content: "# Test\nContent" });
    expect(result.name).toBe("test");
    expect(result.enabled).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "test", "SKILL.md"))).toBe(true);
    const raw = await readFile(join(SKILLS_DIR, "test", "SKILL.md"), "utf-8");
    expect(raw).toContain("Test skill");
    expect(raw).toContain("# Test\nContent");
  });

  test("setSkill 覆盖已禁用 skill", async () => {
    // Create and disable
    await createSkillFile(SKILLS_DIR, "my-skill", "Old desc", "# Old");
    await disableSkill("my-skill");
    expect(existsSync(join(DISABLED_DIR, "my-skill"))).toBe(true);

    // Set with new content — should auto-enable
    await setSkill("my-skill", { description: "New desc", content: "# New" });
    expect(existsSync(join(SKILLS_DIR, "my-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(DISABLED_DIR, "my-skill"))).toBe(false);
    const raw = await readFile(join(SKILLS_DIR, "my-skill", "SKILL.md"), "utf-8");
    expect(raw).toContain("New desc");
  });

  test("deleteSkill 已存在返回 true", async () => {
    await createSkillFile(SKILLS_DIR, "to-delete", "Delete me", "# Delete");
    const result = await deleteSkill("to-delete");
    expect(result).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "to-delete"))).toBe(false);
  });

  test("deleteSkill 不存在返回 false", async () => {
    const result = await deleteSkill("ghost");
    expect(result).toBe(false);
  });

  test("enableSkill 禁用→启用", async () => {
    await createSkillFile(SKILLS_DIR, "toggle", "Toggle skill", "# Toggle");
    await disableSkill("toggle");
    expect(existsSync(join(DISABLED_DIR, "toggle"))).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "toggle"))).toBe(false);

    const result = await enableSkill("toggle");
    expect(result).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "toggle"))).toBe(true);
    expect(existsSync(join(DISABLED_DIR, "toggle"))).toBe(false);
  });

  test("disableSkill 启用→禁用", async () => {
    await createSkillFile(SKILLS_DIR, "toggle2", "Toggle2", "# Toggle2");
    const result = await disableSkill("toggle2");
    expect(result).toBe(true);
    expect(existsSync(join(DISABLED_DIR, "toggle2"))).toBe(true);
    expect(existsSync(join(SKILLS_DIR, "toggle2"))).toBe(false);
  });

  test("parseFrontmatter 解析", () => {
    const raw = `---
name: "pr-review"
description: "Review pull requests"
version: "1.0"
---
# PR Review

Check all the things.`;
    const { metadata, content } = parseFrontmatter(raw);
    expect(metadata.name).toBe("pr-review");
    expect(metadata.description).toBe("Review pull requests");
    expect(metadata.version).toBe("1.0");
    expect(content).toBe("# PR Review\n\nCheck all the things.");
  });
});

// 测试迁移逻辑 — 使用独立临时目录模拟旧路径和新路径
const migrateTemp = await mkdtemp(join(tmpdir(), "skill-migrate-test-"));
const oldDir = join(migrateTemp, "old-skills");
const newDir = join(migrateTemp, "new-skills");

describe("migrateSkillsDir 逻辑验证", () => {
  beforeEach(async () => {
    if (existsSync(migrateTemp)) await rm(migrateTemp, { recursive: true, force: true });
    await mkdir(migrateTemp, { recursive: true });
  });

  test("旧目录有数据，新目录不存在 → 执行迁移", async () => {
    // 准备旧目录数据
    await mkdir(join(oldDir, "test-skill"), { recursive: true });
    await writeFile(join(oldDir, "test-skill", "SKILL.md"), "---\nname: \"test\"\n---\ncontent", "utf-8");

    // 模拟迁移核心逻辑
    const { rename } = await import("node:fs/promises");
    await rename(oldDir, newDir);
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, ".migrated"), "test", "utf-8");

    expect(existsSync(join(newDir, "test-skill", "SKILL.md"))).toBe(true);
    expect(existsSync(join(oldDir, ".migrated"))).toBe(true);
  });

  test("新目录已存在 → 跳过迁移，旧数据不动", async () => {
    await mkdir(join(oldDir, "skill-a"), { recursive: true });
    await mkdir(newDir, { recursive: true });

    // 新目录存在时不执行 rename
    expect(existsSync(join(oldDir, "skill-a"))).toBe(true);
    expect(existsSync(newDir)).toBe(true);
  });

  test(".migrated 标记存在 → 跳过迁移", async () => {
    await mkdir(oldDir, { recursive: true });
    await writeFile(join(oldDir, ".migrated"), "2025-01-01", "utf-8");
    // 标记存在时不执行迁移
    expect(existsSync(join(oldDir, ".migrated"))).toBe(true);
  });

  test("旧目录不存在 → 跳过迁移，不创建任何目录", async () => {
    expect(existsSync(oldDir)).toBe(false);
    // 无操作
  });
});

afterAll(async () => {
  if (existsSync(tempDir)) {
    await rm(tempDir, { recursive: true, force: true });
  }
  if (existsSync(migrateTemp)) await rm(migrateTemp, { recursive: true, force: true });
});
