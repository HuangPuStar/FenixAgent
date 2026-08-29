import { and, asc, eq, gt, inArray } from "drizzle-orm";
import { db } from "../db";
import { modelGatewayCredential } from "../db/schema";

export type ModelGatewayCredential = typeof modelGatewayCredential.$inferSelect;
export type ModelGatewayCredentialStatus = ModelGatewayCredential["status"];

export type ModelGatewayCredentialSubject = Pick<
  typeof modelGatewayCredential.$inferInsert,
  "gatewayProviderId" | "organizationId" | "userId" | "agentConfigId"
>;

export type UpsertModelGatewayCredentialInput = ModelGatewayCredentialSubject &
  Pick<
    typeof modelGatewayCredential.$inferInsert,
    "externalCredentialId" | "encryptedCredential" | "status" | "metadata"
  >;

/** 按 Gateway Provider、组织、用户和 Agent 查询唯一凭证映射。 */
export async function findModelGatewayCredentialBySubject(
  subject: ModelGatewayCredentialSubject,
): Promise<ModelGatewayCredential | null> {
  const rows = await db
    .select()
    .from(modelGatewayCredential)
    .where(
      and(
        eq(modelGatewayCredential.gatewayProviderId, subject.gatewayProviderId),
        eq(modelGatewayCredential.organizationId, subject.organizationId),
        eq(modelGatewayCredential.userId, subject.userId),
        eq(modelGatewayCredential.agentConfigId, subject.agentConfigId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** 幂等创建凭证映射；并发冲突时读取已存在记录，不覆盖其密文。 */
export async function upsertModelGatewayCredential(
  input: UpsertModelGatewayCredentialInput,
): Promise<ModelGatewayCredential> {
  const [created] = await db
    .insert(modelGatewayCredential)
    .values(input)
    .onConflictDoNothing({
      target: [
        modelGatewayCredential.gatewayProviderId,
        modelGatewayCredential.organizationId,
        modelGatewayCredential.userId,
        modelGatewayCredential.agentConfigId,
      ],
    })
    .returning();
  if (created) return created;

  const existing = await findModelGatewayCredentialBySubject(input);
  if (!existing) throw new Error("model gateway credential mapping disappeared after conflict");
  return existing;
}

/** 更新映射状态，不改变外部凭证 ID 和业务归属。 */
export async function updateModelGatewayCredentialStatus(
  id: string,
  status: ModelGatewayCredentialStatus,
): Promise<ModelGatewayCredential | null> {
  const [updated] = await db
    .update(modelGatewayCredential)
    .set({ status, updatedAt: new Date() })
    .where(eq(modelGatewayCredential.id, id))
    .returning();
  return updated ?? null;
}

/** 清空本地可复用密文，保留映射供历史用量和夜间任务使用。 */
export async function clearModelGatewayCredential(id: string): Promise<void> {
  await db
    .update(modelGatewayCredential)
    .set({ encryptedCredential: null, updatedAt: new Date() })
    .where(eq(modelGatewayCredential.id, id));
}

/** 按主键游标扫描凭证映射，默认返回所有状态供调用方决定业务过滤。 */
export async function listModelGatewayCredentialsAfter(input: {
  gatewayProviderId?: string;
  afterId?: string;
  limit: number;
  statuses?: ModelGatewayCredentialStatus[];
}): Promise<ModelGatewayCredential[]> {
  const conditions = [];
  if (input.gatewayProviderId) {
    conditions.push(eq(modelGatewayCredential.gatewayProviderId, input.gatewayProviderId));
  }
  if (input.afterId) conditions.push(gt(modelGatewayCredential.id, input.afterId));
  if (input.statuses && input.statuses.length > 0) {
    conditions.push(inArray(modelGatewayCredential.status, input.statuses));
  }
  return db
    .select()
    .from(modelGatewayCredential)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(modelGatewayCredential.id))
    .limit(input.limit);
}
