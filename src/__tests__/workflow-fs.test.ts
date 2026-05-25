import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exists, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStoragePath,
  ensureWorkflowDir,
  listRecoverable,
  readYamlFile,
  writeYamlFile,
} from "../services/workflow/workflow-fs";

let testRoot: string;

beforeEach(async () => {
  testRoot = join(tmpdir(), `wf-fs-test-${Date.now()}`);
  await mkdir(testRoot, { recursive: true });
});

afterEach(async () => {
  await rm(testRoot, { recursive: true, force: true });
});

describe("workflow-fs", () => {
  // buildStoragePath 拼接正确路径（不再包含 teamId 层级）
  test("buildStoragePath returns correct path", () => {
    const path = buildStoragePath(testRoot, "team-1", "wf-abc");
    expect(path).toBe(join(testRoot, "wf-abc"));
  });

  // ensureWorkflowDir 创建目录
  test("ensureWorkflowDir creates directory", async () => {
    const dir = buildStoragePath(testRoot, "team-1", "wf-abc");
    await ensureWorkflowDir(dir);
    expect(await exists(dir)).toBe(true);
  });

  // writeYamlFile + readYamlFile 写读一致
  test("writeYamlFile + readYamlFile roundtrip", async () => {
    const dir = buildStoragePath(testRoot, "team-1", "wf-abc");
    await ensureWorkflowDir(dir);
    const yaml = 'schema_version: "1"\nname: test\n';
    await writeYamlFile(dir, "draft.yaml", yaml);
    const content = await readYamlFile(dir, "draft.yaml");
    expect(content).toBe(yaml);
  });

  // readYamlFile 文件不存在返回 null
  test("readYamlFile returns null when file not found", async () => {
    const dir = buildStoragePath(testRoot, "team-1", "wf-abc");
    await ensureWorkflowDir(dir);
    const content = await readYamlFile(dir, "draft.yaml");
    expect(content).toBeNull();
  });

  // listRecoverable 返回文件存在但不在排除列表中的目录
  test("listRecoverable returns orphaned directories", async () => {
    const uuid1 = "11111111-aaaa-bbbb-cccc-111111111111";
    const uuid2 = "22222222-aaaa-bbbb-cccc-222222222222";
    const dir1 = buildStoragePath(testRoot, "team-1", uuid1);
    const dir2 = buildStoragePath(testRoot, "team-1", uuid2);
    await ensureWorkflowDir(dir1);
    await ensureWorkflowDir(dir2);
    await writeYamlFile(dir1, "draft.yaml", "name: exists\n");
    await writeYamlFile(dir2, "draft.yaml", "name: orphan\n");

    const result = await listRecoverable(testRoot, "team-1", new Set([uuid1]));
    expect(result).toEqual([uuid2]);
  });

  // listRecoverable 过滤非 UUID 格式的目录名
  test("listRecoverable filters non-UUID directory names", async () => {
    const uuid = "33333333-aaaa-bbbb-cccc-333333333333";
    const nonUuid = "wf-sample-001";
    await ensureWorkflowDir(buildStoragePath(testRoot, "team-1", uuid));
    await ensureWorkflowDir(buildStoragePath(testRoot, "team-1", nonUuid));

    const result = await listRecoverable(testRoot, "team-1", new Set());
    expect(result).toEqual([uuid]);
  });
});
