import { channelBinding } from "@fenix/resource-channel/db";
import { and, eq, inArray } from "drizzle-orm";
import { getChannelDatabase } from "../db";

/** ChannelBinding 行类型 */
export type ChannelBindingRow = typeof channelBinding.$inferSelect;
export type ChannelBindingInsert = typeof channelBinding.$inferInsert;

/** ChannelBinding 仓储接口 */
export interface IChannelBindingRepo {
  /**
   * 按绑定的目标 Environment 读取。
   *
   * 没有「读全表」的方法：通道绑定表不带 `organization_id`，它的租户边界由 `agent_id` 指向的
   * Environment 表达，调用方（Facade）先把组织翻译成 Environment ID 集合，本方法把该集合下推成
   * `agent_id IN (...)`。留下一个无范围的 `list()` 就等于留一条「先读全量再在应用层按组织过滤」的
   * 现成捷径（这正是本方法取代的写法）。
   */
  listByAgentIds(agentIds: readonly string[]): Promise<ChannelBindingRow[]>;
  getById(bindingId: string): Promise<ChannelBindingRow | null>;
  create(data: ChannelBindingInsert): Promise<ChannelBindingRow>;
  delete(bindingId: string): Promise<boolean>;
  update(bindingId: string, data: Partial<ChannelBindingInsert>): Promise<void>;
  listByPlatformAndEnabled(platform: string): Promise<ChannelBindingRow[]>;
}

/**
 * ChannelBinding 仓储：本包唯一的通道绑定数据访问点。
 *
 * DB 句柄在每个方法内取（`getChannelDatabase()` → `@fenix/platform-sdk/server`），不在模块作用域
 * 缓存：句柄只能由宿主在基础设施初始化后提供，而平台 registry 会提前导入模块图；同时避免测试里
 * 提前缓存句柄导致宿主替换替身后读到旧连接（旧写法 `import { db } from "@server/db"` 拿到的是宿主的
 * 模块级单例，无法在包内测试中替换）。
 */
class PgChannelBindingRepo implements IChannelBindingRepo {
  async listByAgentIds(agentIds: readonly string[]) {
    // 空集合：`IN ()` 不是合法 SQL，而「该组织没有任何 Environment」本来就等价于空结果——提前返回，
    // 既避免无效查询，也让该情形与「查询失败」在日志里可区分。
    if (agentIds.length === 0) return [];
    return getChannelDatabase()
      .select()
      .from(channelBinding)
      .where(inArray(channelBinding.agentId, [...agentIds]));
  }

  async getById(bindingId: string) {
    const rows = await getChannelDatabase()
      .select()
      .from(channelBinding)
      .where(eq(channelBinding.id, bindingId))
      .limit(1);
    return rows[0] ?? null;
  }

  async create(data: ChannelBindingInsert) {
    const [row] = await getChannelDatabase().insert(channelBinding).values(data).returning();
    return row;
  }

  async delete(bindingId: string): Promise<boolean> {
    const result = await getChannelDatabase()
      .delete(channelBinding)
      .where(eq(channelBinding.id, bindingId))
      .returning({ id: channelBinding.id });
    return result.length > 0;
  }

  async update(bindingId: string, data: Partial<ChannelBindingInsert>) {
    await getChannelDatabase().update(channelBinding).set(data).where(eq(channelBinding.id, bindingId));
  }

  async listByPlatformAndEnabled(platform: string) {
    return getChannelDatabase()
      .select()
      .from(channelBinding)
      .where(and(eq(channelBinding.platform, platform), eq(channelBinding.enabled, true)));
  }
}

export const channelBindingRepo = new PgChannelBindingRepo();
