import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSkillDetail, writeSkillDocument } from "../server/services/skill-content";
import { initializeSkillModuleConfig } from "../server/testing";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "v1-skill-"));
  initializeSkillModuleConfig({ skillDir: root });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
// metadata={} 必须同时清空文件和资源行的元数据，省略 metadata 则保留。
test("explicit empty metadata replaces file and persistent metadata", async () => {
  await writeSkillDocument({
    organizationId: "org",
    name: "demo",
    description: "demo",
    content: "before",
    metadata: { old: "value" },
  });
  let stored: unknown;
  await writeSkillDocument({
    organizationId: "org",
    name: "demo",
    description: "demo",
    content: "after",
    metadata: {},
    replaceMetadata: true,
    persist: async (written) => {
      stored = written.metadata;
    },
  });
  expect(stored).toEqual({});
  expect((await readSkillDetail("org", "demo"))?.metadata.old).toBeUndefined();
});
// 行写入失败必须恢复真实源目录与归档，而非仅记录补偿函数被调用。
test("failed persistence restores actual document and matching archive", async () => {
  await writeSkillDocument({
    organizationId: "org",
    name: "demo",
    description: "demo",
    content: "original",
    metadata: { old: "value" },
  });
  const path = join(root, "org", "demo", "SKILL.md");
  const before = await readFile(path);
  const archive = join(root, "org", "demo.zip");
  const zip = await readFile(archive);
  await expect(
    writeSkillDocument({
      organizationId: "org",
      name: "demo",
      description: "changed",
      content: "changed",
      metadata: {},
      replaceMetadata: true,
      persist: async () => {
        throw new Error("database failure");
      },
    }),
  ).rejects.toThrow("database failure");
  expect(await readFile(path)).toEqual(before);
  expect(await readFile(archive)).toEqual(zip);
});
