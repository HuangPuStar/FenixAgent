import { describe, expect, test } from "bun:test";

/**
 * 本包聚合根五张表的**列存在性**契约。
 *
 * 为什么需要它：`agent_config.machine_id` 这条断言原先在 machine 包的 `registry-schema.test.ts`（该包当时
 * 直接读这张表）；§1.7 B7 把表迁给本包后，那一处按「资源包不该断言别包表结构」删除——按 B1 对
 * `machine.type` 的同一口径，删掉的断言必须由 owner 接回，否则「迁移时悄悄丢列」这件事全仓无人发现。
 *
 * 只断言存在性、不断言列的完整集合：列名映射（属性名 → DB 列名）由 `bun run check:schema-ddl-drift`
 * 逐字段比对迁移快照保证，那是比列清单更强的门禁；这里挡的是「定义搬迁时漏了一列 / 改了属性名」，
 * 以及未来有人把表定义复制回宿主（重复定义由 `agent-config-source-migration.test.ts` 的路径扫描钉住）。
 *
 * 动态导入而非顶层导入：本文件只关心导出结构，不需要在模块加载期参与宿主的 DB 初始化顺序。
 */
describe("agent_config 聚合根表列契约", () => {
  // 主表列：`machineId` 是 B7 从 machine 包接回的那条断言，其余列一并钉住以免搬迁时丢列。
  test("agent_config 表列定义正确", async () => {
    const { agentConfig } = await import("@fenix/agent-config/db");
    const columns = Object.keys(agentConfig);
    for (const col of [
      "id",
      "userId",
      "organizationId",
      "name",
      "model",
      "modelId",
      "prompt",
      "description",
      "machineId",
      "agentNode",
      "extra",
      "engineType",
      "visibility",
      "createdAt",
      "updatedAt",
    ]) {
      expect(columns).toContain(col);
    }
  });

  // 三张关联表：`agentConfigId` 是指向聚合根的外键，另一列指向各自的资源表，两列缺一即绑定关系断裂。
  test("三张关联表列定义正确", async () => {
    const { agentConfigSkill, agentConfigMcp, agentConfigSiteApp } = await import("@fenix/agent-config/db");
    expect(Object.keys(agentConfigSkill)).toEqual(expect.arrayContaining(["agentConfigId", "skillId", "createdAt"]));
    expect(Object.keys(agentConfigMcp)).toEqual(expect.arrayContaining(["agentConfigId", "mcpServerId", "createdAt"]));
    expect(Object.keys(agentConfigSiteApp)).toEqual(
      expect.arrayContaining(["agentConfigId", "siteAppId", "createdAt"]),
    );
  });

  // Agent Sites 代理表：`visibility` 参与授权受众判定，`appType` 是 custom / pocketbase 两态的判别列。
  test("agent_site_app 表列定义正确", async () => {
    const { agentSiteApp } = await import("@fenix/agent-config/db");
    const columns = Object.keys(agentSiteApp);
    for (const col of [
      "id",
      "organizationId",
      "userId",
      "remoteAppId",
      "name",
      "description",
      "platformToken",
      "platformTokenId",
      "visibility",
      "appType",
      "entryFile",
      "activeSlot",
      "deployedAt",
      "createdByAgentConfigId",
      "createdAt",
      "updatedAt",
    ]) {
      expect(columns).toContain(col);
    }
  });
});
