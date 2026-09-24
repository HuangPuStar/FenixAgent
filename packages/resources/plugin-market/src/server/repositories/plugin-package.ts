import { pluginMarketPackage, pluginMarketPublication } from "@fenix/resource-plugin-market/db";
import { and, eq, sql } from "drizzle-orm";
import { getPluginMarketDatabase, type PluginMarketReader, type PluginMarketTransaction } from "../db";
import type { CatalogPackage, CatalogPublication, CatalogState, CatalogWrite } from "../domain/types";

/**
 * 插件市场聚合的持久化原语。
 *
 * 本文件**不含领域规则**（规则在 `../domain/catalog.ts` 的纯函数里）也不含编排（在
 * `../services/plugin-catalog-service.ts`）：这里只有「怎么把状态读出来、怎么把写清单落下去」，以及那条
 * 「先取事务级咨询锁」的并发原语。
 *
 * 为什么锁必须在**任何读之前**取：没有行可以 `SELECT ... FOR UPDATE` —— 新包的聚合根还不存在。两个并发的
 * 首次发布会各自读到「包不存在」，各自插入，其中一方撞唯一索引失败（表现为 500）。事务级咨询锁把同一个
 * `(sourceId, packageName)` 的整个「读—判断—写」串行化，锁在事务结束时自动释放，异常中断也不会留下悬挂锁。
 * 哈希键与 `../db/schema.ts` 的 `hashtextextended` 用法一致，见 `packages/resources/model-management` 的同名
 * 原语。
 */

/** 聚合身份的稳定键。领域侧叫 `sourceId` + `packageName`，这里保持同名以免两处各起一套术语。 */
export interface PackageIdentity {
  readonly sourceId: string;
  readonly packageName: string;
}

/** 主表行的存储形状；读侧仓储与领域投影都以它为输入。 */
export type PluginPackageRow = typeof pluginMarketPackage.$inferSelect;
export type PublicationRow = typeof pluginMarketPublication.$inferSelect;

/** 咨询锁的键。前缀限定命名空间，避免与其它模块的锁键碰撞（碰撞只会让互不相干的写互相等待）。 */
function lockKeyOf(identity: PackageIdentity): string {
  return `fenix:plugin-market:${identity.sourceId}:${identity.packageName}`;
}

/**
 * 行 → 领域模型。
 *
 * 导出它是为了让读侧复用**同一份**列映射：领域模型一旦加字段，漏改一处就会让该字段在列表里静默为
 * `undefined`（编译期不会报错，因为行里确实有同名列）。
 */
export function toCatalogPackage(row: PluginPackageRow): CatalogPackage {
  return {
    id: row.id,
    sourceId: row.sourceId,
    packageName: row.packageName,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    latestPublicationId: row.latestPublicationId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 版本行 → 领域模型；理由同 {@link toCatalogPackage}。 */
export function toCatalogPublication(row: PublicationRow): CatalogPublication {
  return {
    id: row.id,
    packageId: row.packageId,
    exactVersion: row.exactVersion,
    metadataJson: row.metadataJson,
    metadataDigest: row.metadataDigest,
    firstPublishedAt: row.firstPublishedAt,
    publishedAt: row.publishedAt,
    unpublishedAt: row.unpublishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 在一个事务里持有该包的写锁，并把事务句柄交给调用方。
 *
 * 调用方（service）拿到句柄后必须**先读状态再决策**，否则锁就白取了：领域决策的正确性依赖于「读到的是
 * 锁保护下的最新状态」。
 */
export async function withPackageLock<T>(
  identity: PackageIdentity,
  run: (tx: PluginMarketTransaction) => Promise<T>,
): Promise<T> {
  return getPluginMarketDatabase().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKeyOf(identity)}, 0))`);
    return run(tx);
  });
}

/** 读取聚合的全部状态（聚合根 + 它的全部版本行）；包不存在时返回 null。 */
export async function loadCatalogState(
  reader: PluginMarketReader,
  identity: PackageIdentity,
): Promise<CatalogState | null> {
  const [row] = await reader
    .select()
    .from(pluginMarketPackage)
    .where(
      and(
        eq(pluginMarketPackage.sourceId, identity.sourceId),
        eq(pluginMarketPackage.packageName, identity.packageName),
      ),
    )
    .limit(1);
  if (!row) return null;

  // 一次读完整个聚合：领域规则只需要包内数据，分批查询只会把「读两次之间状态变了」的风险引入决策。
  const publications = await reader
    .select()
    .from(pluginMarketPublication)
    .where(eq(pluginMarketPublication.packageId, row.id));

  return { package: toCatalogPackage(row), publications: publications.map(toCatalogPublication) };
}

/**
 * 按写清单顺序执行写入。
 *
 * **顺序即语义**：`planUnpublish` 把 `set-latest` 排在 `update-publication` 之前，因此事务内的任何时刻都
 * 不存在「latest 指向一个已隐藏版本」的中间态（见 `../domain/catalog.ts` 的说明）。这里不做任何重排或合并。
 *
 * `update-publication` 只写可变列（时刻与水印），**不碰快照列**：这是「快照发布后不可变」在存储层的表达，
 * 恢复路径因此不可能改写 `metadata_json` / `metadata_digest` / `first_published_at`。
 */
export async function applyCatalogWrites(tx: PluginMarketTransaction, writes: readonly CatalogWrite[]): Promise<void> {
  for (const write of writes) {
    switch (write.kind) {
      case "create-package": {
        const { package: row } = write;
        await tx.insert(pluginMarketPackage).values({
          id: row.id,
          sourceId: row.sourceId,
          packageName: row.packageName,
          organizationId: row.organizationId,
          ownerUserId: row.ownerUserId,
          // 市场条目按定义就是公开可读（`../access/plugin-package-resource.ts` 的 `publicDefaultActions`
          // 与之配套），因此这里写常量而不取 `resolveInitialScope` 的结果——授权模块对组织资源的默认值是
          // `private`，照抄它会让整个目录除系统管理员外对所有人消失，且不会报任何错。
          visibility: "public",
          latestPublicationId: row.latestPublicationId,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        });
        break;
      }
      case "insert-publication": {
        const { publication } = write;
        await tx.insert(pluginMarketPublication).values({
          id: publication.id,
          packageId: publication.packageId,
          exactVersion: publication.exactVersion,
          metadataJson: publication.metadataJson,
          metadataDigest: publication.metadataDigest,
          firstPublishedAt: publication.firstPublishedAt,
          publishedAt: publication.publishedAt,
          unpublishedAt: publication.unpublishedAt,
          createdAt: publication.createdAt,
          updatedAt: publication.updatedAt,
        });
        break;
      }
      case "update-publication": {
        const { publication } = write;
        await tx
          .update(pluginMarketPublication)
          .set({
            publishedAt: publication.publishedAt,
            unpublishedAt: publication.unpublishedAt,
            updatedAt: publication.updatedAt,
          })
          .where(eq(pluginMarketPublication.id, publication.id));
        break;
      }
      case "set-latest": {
        await tx
          .update(pluginMarketPackage)
          .set({ latestPublicationId: write.latestPublicationId, updatedAt: write.updatedAt })
          .where(eq(pluginMarketPackage.id, write.packageId));
        break;
      }
    }
  }
}
