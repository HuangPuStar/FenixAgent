import { pluginMarketAdminOperation } from "@fenix/resource-plugin-market/db";
import type { PluginMarketTransaction } from "../db";
import type { CatalogAuditEntry } from "../domain/types";

/**
 * 市场管理操作审计：只追加不修改。
 *
 * 审计行与目录变更在**同一个事务**里写：分开写会留下两种都能被观测到的中间态——「变了没记录」（事后无法
 * 解释谁动过市场）与「记录了没变」（读到的人会去查一个不存在的变更）。这也是表定义里 `package_id` /
 * `publication_id` 都带级联外键的前提：审计行永远指向真实存在的行。
 *
 * `noop` 不写审计：领域决策在幂等分支直接返回 `audit: null`，这里的调用方据此跳过（见
 * `../services/plugin-catalog-service.ts`）。重复发布的调用者不该在流水里留下第二条记录——否则「市场被
 * 改了几次」这个问题就无法从流水回答。
 */
export async function recordAdminOperation(tx: PluginMarketTransaction, entry: CatalogAuditEntry): Promise<void> {
  await tx.insert(pluginMarketAdminOperation).values({
    id: entry.id,
    action: entry.action,
    packageId: entry.packageId,
    publicationId: entry.publicationId,
    operatorUserId: entry.operatorUserId,
    occurredAt: entry.occurredAt,
    requestId: entry.requestId,
  });
}
