import { inArray } from "drizzle-orm";
import { db } from "../db";
import { user } from "../db/schema";

/**
 * 按用户 ID 批量查询基础展示信息。
 */
export async function findUsersBasicInfoByIds(userIds: string[]) {
  if (userIds.length === 0) return [];

  return db
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
    })
    .from(user)
    .where(inArray(user.id, userIds))
    .execute();
}
