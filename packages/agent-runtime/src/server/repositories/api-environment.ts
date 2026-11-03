import { runInTransaction } from "@fenix/platform-sdk/server";
import { sql } from "drizzle-orm";
import { getAgentRuntimeDatabase } from "../db";

/** Serialize default Environment preparation across requests and server processes. */
export function withApiEnvironmentLock<T>(
  owner: { organizationId: string; userId: string },
  agentConfigId: string,
  operation: () => Promise<T>,
): Promise<T> {
  return runInTransaction(async () => {
    const key = JSON.stringify(["api-environment", owner.organizationId, owner.userId, agentConfigId]);
    await getAgentRuntimeDatabase().execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    return operation();
  });
}
