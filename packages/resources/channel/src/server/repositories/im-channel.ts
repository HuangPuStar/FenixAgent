import { imChannel } from "@fenix/resource-channel/db";
import { and, asc, eq } from "drizzle-orm";
import { getChannelDatabase } from "../db";

/**
 * IM 通道的持久化访问层。
 *
 * 只做行的读写与组织过滤所需的谓词，不做授权判定、不拼接展示字段：授权与编排属于 Facade / Domain
 * Service。`findByIdForOrganization` 与 `findManyByOrganization` 把租户边界写进 WHERE，避免调用方
 * 先按 id 取回再在内存里比对组织。
 */

export type ImChannelRow = typeof imChannel.$inferSelect;

export interface ImChannelInsertInput {
  userId: string;
  organizationId: string;
  name: string;
  description?: string | null;
  platform: string;
  /** LangBot 形态为 `{ botUuid }`；API Key 是实例级共享密钥，不落通道行。 */
  credentials: unknown;
  status?: string;
  lastError?: string | null;
  enabled?: boolean;
}

/** 可更新列的白名单：主键、所有者与租户字段不参与部分更新。 */
export interface ImChannelUpdatePatch {
  name?: string;
  description?: string | null;
  platform?: string;
  credentials?: unknown;
  status?: string;
  lastError?: string | null;
  enabled?: boolean;
}

export interface ImChannelRepository {
  findById(input: { channelId: string }): Promise<ImChannelRow | undefined>;
  findByIdForOrganization(input: { channelId: string; organizationId: string }): Promise<ImChannelRow | undefined>;
  findManyByOrganization(input: { organizationId: string }): Promise<ImChannelRow[]>;
  insert(input: ImChannelInsertInput): Promise<ImChannelRow>;
  updateById(input: { channelId: string; patch: ImChannelUpdatePatch }): Promise<ImChannelRow | undefined>;
  deleteById(input: { channelId: string }): Promise<boolean>;
}

export function createImChannelRepository(): ImChannelRepository {
  return {
    async findById(input) {
      const db = getChannelDatabase();
      const rows = await db.select().from(imChannel).where(eq(imChannel.id, input.channelId)).limit(1);
      return rows[0];
    },

    async findByIdForOrganization(input) {
      const db = getChannelDatabase();
      const rows = await db
        .select()
        .from(imChannel)
        .where(
          // 两列都要命中：只按 id 查询会把别的组织的通道交给调用方。
          and(eq(imChannel.id, input.channelId), eq(imChannel.organizationId, input.organizationId)),
        )
        .limit(1);
      return rows[0];
    },

    async findManyByOrganization(input) {
      const db = getChannelDatabase();
      return db
        .select()
        .from(imChannel)
        .where(eq(imChannel.organizationId, input.organizationId))
        .orderBy(asc(imChannel.createdAt));
    },

    async insert(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .insert(imChannel)
        .values({
          userId: input.userId,
          organizationId: input.organizationId,
          name: input.name,
          description: input.description ?? null,
          platform: input.platform,
          credentials: input.credentials,
          status: input.status ?? "disconnected",
          lastError: input.lastError ?? null,
          enabled: input.enabled ?? true,
        })
        .returning();
      if (row === undefined) throw new Error("im_channel 写入未返回行");
      return row;
    },

    async updateById(input) {
      const db = getChannelDatabase();
      const [row] = await db
        .update(imChannel)
        .set({ ...input.patch, updatedAt: new Date() })
        .where(eq(imChannel.id, input.channelId))
        .returning();
      return row;
    },

    async deleteById(input) {
      const db = getChannelDatabase();
      const rows = await db.delete(imChannel).where(eq(imChannel.id, input.channelId)).returning({ id: imChannel.id });
      return rows.length > 0;
    },
  };
}
