import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { agentLitellmKey } from "../../db/schema";
import { deleteLitellmKeys } from "./key";

/** 撤销指定用户在某智能体上的所有 LiteLLM Key */
export async function revokeLitellmKeyForUserAgent(
  userId: string,
  agentConfigId: string,
): Promise<{ revoked: number }> {
  const keys = await db
    .select({ litellmKeyId: agentLitellmKey.litellmKeyId })
    .from(agentLitellmKey)
    .where(
      and(
        eq(agentLitellmKey.userId, userId),
        eq(agentLitellmKey.agentConfigId, agentConfigId),
        eq(agentLitellmKey.enabled, true),
      ),
    );

  if (keys.length === 0) return { revoked: 0 };

  const keyIds = keys.map((k) => k.litellmKeyId);
  await deleteLitellmKeys(keyIds);

  await db
    .update(agentLitellmKey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(agentLitellmKey.userId, userId), eq(agentLitellmKey.agentConfigId, agentConfigId)));

  return { revoked: keyIds.length };
}

/** 撤销指定用户在某个组织下的所有 LiteLLm Key */
export async function revokeLitellmKeysForUserInOrg(
  userId: string,
  organizationId: string,
): Promise<{ revoked: number }> {
  const keys = await db
    .select({ litellmKeyId: agentLitellmKey.litellmKeyId })
    .from(agentLitellmKey)
    .where(
      and(
        eq(agentLitellmKey.userId, userId),
        eq(agentLitellmKey.organizationId, organizationId),
        eq(agentLitellmKey.enabled, true),
      ),
    );

  if (keys.length === 0) return { revoked: 0 };

  const keyIds = keys.map((k) => k.litellmKeyId);
  await deleteLitellmKeys(keyIds);

  await db
    .update(agentLitellmKey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(and(eq(agentLitellmKey.userId, userId), eq(agentLitellmKey.organizationId, organizationId)));

  return { revoked: keyIds.length };
}

/** 撤销某个智能体的所有 LiteLLM Key */
export async function revokeAllKeysForAgent(agentConfigId: string): Promise<{ revoked: number }> {
  const keys = await db
    .select({ litellmKeyId: agentLitellmKey.litellmKeyId })
    .from(agentLitellmKey)
    .where(and(eq(agentLitellmKey.agentConfigId, agentConfigId), eq(agentLitellmKey.enabled, true)));

  if (keys.length === 0) return { revoked: 0 };

  const keyIds = keys.map((k) => k.litellmKeyId);
  await deleteLitellmKeys(keyIds);

  await db
    .update(agentLitellmKey)
    .set({ enabled: false, updatedAt: new Date() })
    .where(eq(agentLitellmKey.agentConfigId, agentConfigId));

  return { revoked: keyIds.length };
}
