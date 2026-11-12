import { agentConcurrencyPolicy } from "@fenix/agent-runtime/db";
import { eq, isNull } from "drizzle-orm";
import { getAgentRuntimeDatabase } from "../db";
import type { ConcurrencyPolicyRepository } from "../services/agent-concurrency-policy";

/** 单进程管理写入已串行；事务将每次策略替换作为一个提交单位。 */
export const agentConcurrencyPolicyRepository: ConcurrencyPolicyRepository = {
  async list() {
    return getAgentRuntimeDatabase()
      .select({
        userId: agentConcurrencyPolicy.userId,
        agentMaxConcurrency: agentConcurrencyPolicy.agentMaxConcurrency,
        userAgentMaxConcurrency: agentConcurrencyPolicy.userAgentMaxConcurrency,
        scheduledAgentMaxConcurrency: agentConcurrencyPolicy.scheduledAgentMaxConcurrency,
      })
      .from(agentConcurrencyPolicy);
  },
  async save(userId, values) {
    const db = getAgentRuntimeDatabase();
    await db.transaction(async (tx) => {
      const predicate =
        userId === null ? isNull(agentConcurrencyPolicy.userId) : eq(agentConcurrencyPolicy.userId, userId);
      const [existing] = await tx
        .select({ id: agentConcurrencyPolicy.id })
        .from(agentConcurrencyPolicy)
        .where(predicate);
      if (existing)
        await tx
          .update(agentConcurrencyPolicy)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(agentConcurrencyPolicy.id, existing.id));
      else await tx.insert(agentConcurrencyPolicy).values({ userId, ...values });
    });
  },
  async delete(userId) {
    await getAgentRuntimeDatabase().delete(agentConcurrencyPolicy).where(eq(agentConcurrencyPolicy.userId, userId));
  },
};
