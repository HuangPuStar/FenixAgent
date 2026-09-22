import { channelBinding } from "@fenix/resource-channel/db";
import { and, eq } from "drizzle-orm";
import { getChannelDatabase } from "../db";

/** ChannelBinding 行类型 */
export type ChannelBindingRow = typeof channelBinding.$inferSelect;
export type ChannelBindingInsert = typeof channelBinding.$inferInsert;

/** ChannelBinding 仓储接口 */
export interface IChannelBindingRepo {
  list(): Promise<ChannelBindingRow[]>;
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
  async list() {
    return getChannelDatabase().select().from(channelBinding);
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
