import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  _deps,
  _resetDeps,
  compensateBackfillResourceVisibility,
  migrateBackfillResourceVisibility,
  verifyBackfillResourceVisibility,
} from "../services/data-migrates/backfill-resource-visibility";

/**
 * 旧授权栈的"任意已认证用户可读"（`principal_type='all' AND action='read'`）必须收敛进资源主表
 * 的 `visibility` 列，否则 mcp 等资源切换授权读取后会丢失既有公开受众。这里以 `_deps` 为界桩
 * 验证回填口径：只写有公开读授权的行、`principal_type='organization'` 出现即停止、完成后
 * pending 为 0、可补偿回 private。
 */

const GRANTS: Readonly<Record<string, string[]>> = {
  agent_config: ["cfg-public", "cfg-private"],
  skill: [],
  mcp_server: ["mcp-public"],
  provider: [],
};

function stubDeps(overrides: Partial<typeof _deps> = {}) {
  const markPublic = mock(async (_target: unknown, ids: readonly string[]) => ids.length);
  const markPrivate = mock(async (_target: unknown, ids: readonly string[]) => ids.length);

  _deps.listPublicReadResourceIds = async (resourceType) => GRANTS[resourceType] ?? [];
  _deps.countOrganizationPrincipalGrants = async () => 0;
  _deps.markPublic = markPublic;
  _deps.countNonPublic = async () => 0;
  _deps.markPrivate = markPrivate;
  _deps.log = mock(() => {});
  Object.assign(_deps, overrides);

  return { markPublic, markPrivate };
}

describe("backfill resource visibility", () => {
  beforeEach(() => {
    _resetDeps();
  });

  afterEach(() => {
    _resetDeps();
  });

  // 四种受控资源都要按 resourceType 各自回填，且只回填 public 读授权指向的资源。
  test("backfills public visibility per controlled resource type", async () => {
    const { markPublic } = stubDeps();

    await migrateBackfillResourceVisibility.run();

    const targets = markPublic.mock.calls.map((call) => (call[0] as { resourceType: string }).resourceType);
    expect(targets.sort()).toEqual(["agent_config", "mcp_server"]);
    expect(markPublic.mock.calls[0]?.[1]).toEqual(["cfg-public", "cfg-private"]);
  });

  // 没有公开读授权的资源类型不得产生写操作，避免无谓 UPDATE 与锁。
  test("skips resource types without public read grants", async () => {
    const { markPublic } = stubDeps();

    await migrateBackfillResourceVisibility.run();

    const targets = markPublic.mock.calls.map((call) => (call[0] as { resourceType: string }).resourceType);
    expect(targets).not.toContain("skill");
    expect(targets).not.toContain("provider");
  });

  // `principal_type='organization'` 超出迁移假设：必须中止且不写任何行，等待人工处置。
  test("stops without writing when organization principal grants exist", async () => {
    const { markPublic } = stubDeps({ countOrganizationPrincipalGrants: async () => 2 });

    await expect(migrateBackfillResourceVisibility.run()).rejects.toThrow("principal_type='organization'");
    expect(markPublic).not.toHaveBeenCalled();
  });

  // 回填结束后仍存在"有公开读授权但非 public"的行时，迁移必须失败而不是静默记录成功。
  test("fails verification when rows remain private", async () => {
    stubDeps({ countNonPublic: async () => 3 });

    await expect(verifyBackfillResourceVisibility()).rejects.toThrow("仍有 3 行未回填公开受众");
  });

  // 重复执行不新增写入：已回填的行返回 0 行受影响，回填结果保持收敛。
  test("is idempotent across repeated runs", async () => {
    const { markPublic } = stubDeps();
    await migrateBackfillResourceVisibility.run();

    // 第二次执行时主表已是 public，UPDATE 命中 0 行。
    markPublic.mockImplementation(async (_target: unknown, ids: readonly string[]) => ids.length * 0);
    const log = mock(() => {});
    _deps.log = log;

    await migrateBackfillResourceVisibility.run();

    expect(log).not.toHaveBeenCalled();
  });

  // 补偿把由公开读授权推导为 public 的行改回 private，且只作用于这些资源 id。
  test("compensates backfilled rows to private", async () => {
    const { markPrivate } = stubDeps();

    await compensateBackfillResourceVisibility();

    const targets = markPrivate.mock.calls.map((call) => (call[0] as { resourceType: string }).resourceType);
    expect(targets.sort()).toEqual(["agent_config", "mcp_server"]);
    expect(markPrivate.mock.calls[0]?.[1]).toEqual(["cfg-public", "cfg-private"]);
  });
});
