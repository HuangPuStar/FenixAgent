import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { exists, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStoragePath,
  ensureWorkflowDir,
  listRecoverable,
  readYamlFile,
  resolveStorageDir,
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
  // buildStoragePath 拼接正确路径（含 organizationId 隔离层）
  test("buildStoragePath returns org-isolated path", () => {
    const path = buildStoragePath(testRoot, "team-1", "wf-abc");
    expect(path).toBe(join(testRoot, "team-1", "wf-abc"));
  });

  // ensureWorkspaceDir 创建目录
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

  // listRecoverable 只扫描当前 organization 子目录
  test("listRecoverable returns orphaned directories within org scope", async () => {
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

  // listRecoverable 跨组织隔离：team-2 的 workflow 不能被 team-1 看到
  test("listRecoverable isolates organizations", async () => {
    const uuidTeam1 = "11111111-aaaa-bbbb-cccc-111111111111";
    const uuidTeam2 = "22222222-aaaa-bbbb-cccc-222222222222";
    await ensureWorkflowDir(buildStoragePath(testRoot, "team-1", uuidTeam1));
    await ensureWorkflowDir(buildStoragePath(testRoot, "team-2", uuidTeam2));

    const team1Result = await listRecoverable(testRoot, "team-1", new Set());
    expect(team1Result).toEqual([uuidTeam1]);
    expect(team1Result).not.toContain(uuidTeam2);

    const team2Result = await listRecoverable(testRoot, "team-2", new Set());
    expect(team2Result).toEqual([uuidTeam2]);
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

  // resolveStorageDir 兼容旧路径（迁移前的无 organizationId 路径）
  test("resolveStorageDir falls back to legacy path", async () => {
    const uuid = "44444444-aaaa-bbbb-cccc-444444444444";
    const legacyDir = join(testRoot, uuid);
    await ensureWorkflowDir(legacyDir);
    await writeYamlFile(legacyDir, "draft.yaml", "name: legacy\n");

    // 新路径不存在时，回退到旧路径
    const resolved = await resolveStorageDir(testRoot, "team-1", uuid);
    expect(resolved).toBe(legacyDir);
  });
});
