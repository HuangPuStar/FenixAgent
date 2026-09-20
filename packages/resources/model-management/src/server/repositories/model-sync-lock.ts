import { sql } from "drizzle-orm";
import { getModelManagementDatabase } from "../db";

/**
 * 模型投影同步的跨实例互斥锁。
 *
 * 放在仓储层而不是编排层（`../model-gateway/provider-service`）：这是一次**数据访问**——它借用数据库
 * 的事务级 advisory lock 做分布式互斥，不承载任何领域规则。1.3 的目标是「repository 收敛为包内唯一
 * 数据访问点」，编排层再持有一个事务句柄会让该结论无法用 grep 验证（`getModelManagementDatabase()`
 * 的调用点会散在两处）。
 *
 * 锁键 `fenix:model-gateway:models` 与迁移前一致（键变了不会报错，只会让新旧实例各持一把锁，静默失去
 * 互斥），因此这里保留原字面量并注明来源。`pg_advisory_xact_lock` 在事务结束时自动释放，不依赖显式
 * 解锁，异常中断也不会留下悬挂锁。
 */
export async function withModelSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  return getModelManagementDatabase().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended('fenix:model-gateway:models', 0))`);
    return fn();
  });
}
