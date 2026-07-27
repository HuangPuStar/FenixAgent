/**
 * RAGFlow API Key 解析（shim：无分层，始终返回全局 key）。
 *
 * 原分层功能（个人/组织/公共 keySource）已移除，保留此文件用于兼容其他模块的调用。
 */
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { user } from "../db/schema";

const SYSTEM_ADMIN_EMAIL = "admin@fenix.com";

/** 判断 userId 是否为系统管理员 */
export async function isSystemAdmin(userId: string): Promise<boolean> {
  const [row] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId)).limit(1);
  return row?.email === SYSTEM_ADMIN_EMAIL;
}

/** 始终返回全局 RAGFlow API Key（环境变量 RAGFLOW_API_KEY） */
export async function resolveRagflowApiKey(_keySource: string, _userId: string, _orgId: string): Promise<string> {
  return config.ragflowApiKey;
}
