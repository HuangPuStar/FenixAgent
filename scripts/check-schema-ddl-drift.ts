/**
 * schema 与已发布迁移链的零差异门禁。
 *
 * 1.7 的表搬迁只搬**位置**、不改**结构**：`drizzle.config.ts` 的 schema 路径换到各 owner 包之后，
 * `bunx drizzle-kit generate` 仍必须产出「No schema changes」。人工在搬迁前后各跑一次只能保护一次，
 * 也拦不住「顺手改了列定义或删了外键」——那类改动会让 `db:generate` 静默产出一条新 DDL，而搬迁本身
 * 也会被误判为「结构变更已发生」。
 *
 * 实现方式是拿 config 声明的 schema 聚合结果与**最新 snapshot**（已发布 DDL 链的当前状态）做 diff：
 * - 差异为 0 条 → 通过。基线随合法的 schema 变更自然更新（`db:generate` 会重写 snapshot），不需要维护哈希。
 * - 差异非 0 条 → 打印差异 SQL 并失败。这里不会误报：任何真实的结构变更本就该由 `db:generate` 产出迁移，
 *   而不是被本门禁拦住。
 *
 * 不冻结哈希、不写盘：只读 config、snapshot 与 schema 模块。
 *
 * 已知前提：`generateMigration` 返回 `Promise<string[]>`。忘了 await 会得到 0 条**假绿**，
 * 因此自测里有一条「空 schema 必须报出大量 DROP」的反向用例——loader 一旦失效就会炸响，不会静默通过。
 */

import { join, resolve } from "node:path";
import { generateDrizzleJson, generateMigration } from "drizzle-kit/api";
import drizzleConfig from "../drizzle.config";

const repositoryRoot = resolve(import.meta.dir, "..");

/** 读取 journal 末条对应的 snapshot——它就是「已发布 DDL 链的当前状态」。 */
async function readLatestSnapshot(outDir: string): Promise<Record<string, unknown>> {
  const journalPath = join(outDir, "meta", "_journal.json");
  const journal = (await Bun.file(journalPath).json()) as { entries?: readonly { idx: number }[] };
  const last = journal.entries?.at(-1);
  if (!last) throw new Error(`迁移链为空，无法确定已发布基线：${journalPath}`);

  const snapshotPath = join(outDir, "meta", `${String(last.idx).padStart(4, "0")}_snapshot.json`);
  return (await Bun.file(snapshotPath).json()) as Record<string, unknown>;
}

/** 汇总 config 声明全部 schema 模块的导出；任一文件缺失即抛错，不静默少读。 */
async function loadSchemaModules(paths: readonly string[]): Promise<Record<string, unknown>> {
  const modules = await Promise.all(
    paths.map(async (path) => (await import(resolve(repositoryRoot, path))) as Record<string, unknown>),
  );
  return Object.assign({}, ...modules);
}

/** 找 schema 与已发布迁移链的 DDL 差异；空数组表示零差异。`schemaPaths` 可注入，供自测构造反向用例。 */
export async function findSchemaDdlDrift(
  options: { schemaPaths?: readonly string[] } = {},
): Promise<readonly string[]> {
  const schemaPaths = options.schemaPaths ?? (drizzleConfig.schema as readonly string[]);
  const outDir = resolve(repositoryRoot, drizzleConfig.out ?? "./drizzle");

  const schemaModules = await loadSchemaModules(schemaPaths);
  const lastSnapshot = await readLatestSnapshot(outDir);
  // 第二参数是生成结果的 id：沿用最新 snapshot 的 id，diff 才只反映结构差异。
  const current = await generateDrizzleJson(schemaModules, lastSnapshot.id as string | undefined);
  return generateMigration(lastSnapshot, current);
}

/** 执行门禁并返回进程退出码。 */
export async function checkSchemaDdlDrift(): Promise<number> {
  const drift = await findSchemaDdlDrift();
  if (drift.length === 0) {
    console.log("✓ schema-ddl-drift");
    return 0;
  }

  console.error(`schema 与已发布迁移链存在 ${drift.length} 条 DDL 差异——表搬迁只搬位置、不改结构：`);
  for (const statement of drift) console.error(`  ${statement}`);
  console.error("若这是有意的结构变更，请走 `bun run db:generate --name <name>` 产出迁移并提交完整迁移链。");
  return 1;
}

if (import.meta.main) {
  process.exit(await checkSchemaDdlDrift());
}
