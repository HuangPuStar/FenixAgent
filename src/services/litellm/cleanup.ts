import { log, error as logError } from "@fenix/logger";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { agentLitellmKey } from "../../db/schema";
import { deleteLitellmKeys } from "./key";

/** 扫描并清理孤儿 Key（enabled=false 的残留记录） */
export async function cleanOrphanLitellmKeys(): Promise<{ cleaned: number }> {
  const orphanKeys = await db
    .select({
      id: agentLitellmKey.id,
      litellmKeyId: agentLitellmKey.litellmKeyId,
    })
    .from(agentLitellmKey)
    .where(eq(agentLitellmKey.enabled, false))
    .limit(100);

  let cleaned = 0;
  for (const record of orphanKeys) {
    try {
      await deleteLitellmKeys([record.litellmKeyId]);
    } catch {
      // Key already deleted on LiteLLM side, just clean up DB record
    }
    await db.delete(agentLitellmKey).where(eq(agentLitellmKey.id, record.id));
    cleaned++;
  }

  if (cleaned > 0) {
    log(`[LiteLLM] 清理了 ${cleaned} 个孤儿 Key 记录`);
  }

  return { cleaned };
}

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startOrphanKeyCleanup(intervalMs = 3600_000): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(async () => {
    try {
      await cleanOrphanLitellmKeys();
    } catch (err) {
      logError("[LiteLLM] 孤儿 Key 清理失败:", err);
    }
  }, intervalMs);
}

export function stopOrphanKeyCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
