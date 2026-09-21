import { expect, test } from "bun:test";
import { findSchemaDdlDrift } from "../check-schema-ddl-drift";

/**
 * 零差异门禁是 1.7 表搬迁的唯一「只搬位置、不改结构」证据，因此它本身必须被测试锁住：
 * 一条正向用例证明当前仓库确实与已发布迁移链零差异，一条反向用例证明 loader 失效时会炸响。
 */

// 当前仓库的 schema 聚合结果必须与最新 snapshot 完全一致——搬迁批次每批都靠这条守住零 DDL 变化。
test("当前 schema 与已发布迁移链零差异", async () => {
  expect(await findSchemaDdlDrift()).toEqual([]);
});

// 反向自检：schema 模块读不到时（loader 失效、路径写错、`generateMigration` 忘了 await）必须报出大量
// 差异，而不是静默返回 0 条。空 schema 相对已发布基线必然缺表，因此差异非空。
test("schema 读不到时报出差异而非静默通过", async () => {
  const drift = await findSchemaDdlDrift({ schemaPaths: [] });

  expect(drift.length).toBeGreaterThan(0);
  expect(drift.some((statement) => statement.includes("DROP TABLE"))).toBe(true);
});
