import { expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { workflowV2AuditLog, workflowV2OrgApp, workflowV2PlatformAccount, workflowV2Workflow } from "../../db/schema";

/**
 * 骨架（1A）的表定义契约测试（冻结 §3）。
 *
 * 只断言「表名、列名、约束」三者，不断言 DDL 文本——迁移链的真相由 `bun run check:schema-ddl-drift` 与
 * 生成的 `drizzle/*.sql` 负责，这里锁定的是「代码里那张表长什么样」：表名与列名是跨任务共享的契约
 * （2B 的仓储、3C 的审计写入都按列名读），写错一个列名不会在包内报错，只会让运行期查询落空。
 *
 * 用 `getTableConfig` 而不是手写 SQL 或连库：本用例必须能在没有数据库的环境里跑（precheck 的
 * `package-tests` 步骤不保证有 DB）。
 */

/** 冻结 §3 的四张表：表名 + 列名清单（列序即声明序，与迁移文件的列序一致）。 */
const TABLES = [
  [
    "workflow_v2_platform_account",
    workflowV2PlatformAccount,
    [
      "id",
      "platform_user_id",
      "platform_space_id",
      "email",
      "status",
      "last_login_at",
      "last_probe_at",
      "last_error",
      "created_at",
      "updated_at",
    ],
  ],
  [
    "workflow_v2_org_app",
    workflowV2OrgApp,
    ["id", "organization_id", "app_id", "name", "status", "created_at", "updated_at"],
  ],
  [
    "workflow_v2_workflow",
    workflowV2Workflow,
    [
      "id",
      "organization_id",
      "upstream_workflow_id",
      "app_id",
      "name",
      "owner_user_id",
      "visibility",
      "published_version",
      "sync_state",
      "deleted_at",
      "created_at",
      "updated_at",
    ],
  ],
  [
    "workflow_v2_audit_log",
    workflowV2AuditLog,
    [
      "id",
      "organization_id",
      "actor_user_id",
      "action",
      "upstream_workflow_id",
      "request_id",
      "result",
      "error_code",
      "created_at",
    ],
  ],
] as const;

// 表名与列名是跨任务契约：与冻结 §3 逐项对齐，改列名必须同时改文档与迁移。
test("四张表的表名与列名与冻结 §3 一致", () => {
  for (const [expectedName, table, expectedColumns] of TABLES) {
    const config = getTableConfig(table);
    expect(config.name).toBe(expectedName);
    expect(config.columns.map((column) => column.name)).toEqual([...expectedColumns]);
  }
});

// 平台账号只有一行：`platform_user_id` 必须是唯一索引，否则「进程内只有一个平台账号」没有存储层保证。
test("平台账号表的单行不变量由唯一索引保证", () => {
  const config = getTableConfig(workflowV2PlatformAccount);
  const indexes = config.indexes.map((index) => [index.config.name, index.config.unique]);
  expect(indexes).toEqual([["idx_workflow_v2_platform_account_platform_user", true]]);
  // 会话材料不落库：表里不得出现任何 session/cookie 类列。
  expect(config.columns.some((column) => /session|cookie|token/i.test(column.name))).toBe(false);
});

// 租户与 App 是一对一：两个方向都要唯一，只保一侧会允许两个租户共享一个 App（跨租户可见性）。
test("租户 App 表的两个方向都是唯一索引", () => {
  const config = getTableConfig(workflowV2OrgApp);
  const indexes = config.indexes.map((index) => [index.config.name, index.config.unique]);
  expect(indexes).toEqual([
    ["idx_workflow_v2_org_app_organization", true],
    ["idx_workflow_v2_org_app_app", true],
  ]);
});

// 本地注册表：upstream_workflow_id 唯一（跨系统身份），列表查询的固定谓词 (organization_id, deleted_at) 有索引。
test("本地注册表的唯一性与组织索引就位", () => {
  const config = getTableConfig(workflowV2Workflow);
  const indexes = config.indexes.map((index) => [index.config.name, index.config.unique]);
  expect(indexes).toEqual([
    ["idx_workflow_v2_workflow_upstream", true],
    ["idx_workflow_v2_workflow_org_deleted", false],
  ]);

  const byName = new Map(config.columns.map((column) => [column.name, column]));
  // visibility / sync_state 是带默认值的受众列与软删状态：默认值写错会让新建行的语义整体偏移。
  expect(byName.get("visibility")?.default).toBe("private");
  expect(byName.get("sync_state")?.default).toBe("active");
  // published_version 未发布时为 null，必须可空；组织归属与归属用户必须非空。
  expect(byName.get("published_version")?.notNull).toBe(false);
  expect(byName.get("organization_id")?.notNull).toBe(true);
  expect(byName.get("owner_user_id")?.notNull).toBe(true);
});

// 审计表按 (organization_id, created_at) 查询；对账按 (action, upstream_workflow_id) 查创建补偿标记（4A）。
// upstream_workflow_id / request_id 允许为空（绑定 App、重登等动作没有它们）。
test("审计表的组织索引、对账索引与可空列就位", () => {
  const config = getTableConfig(workflowV2AuditLog);
  const indexes = config.indexes.map((index) => [index.config.name, index.config.unique]);
  expect(indexes).toEqual([
    ["idx_workflow_v2_audit_log_org_created", false],
    ["idx_workflow_v2_audit_log_action_workflow", false],
  ]);

  const byName = new Map(config.columns.map((column) => [column.name, column]));
  expect(byName.get("upstream_workflow_id")?.notNull).toBe(false);
  expect(byName.get("request_id")?.notNull).toBe(false);
  expect(byName.get("actor_user_id")?.notNull).toBe(true);
});
