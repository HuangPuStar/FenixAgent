import { and, eq, inArray } from "drizzle-orm";
import { db } from "../../../../../../apps/server/src/db";
import { sandboxInstance } from "../../../../../../apps/server/src/db/schema";

/** Machine 注册后投影关联 Sandbox Instance 的就绪状态。 */
export async function markSandboxInstanceReadyForMachine(machineId: string, at = new Date()): Promise<void> {
  await db
    .update(sandboxInstance)
    .set({ status: "ready", lastHeartbeatAt: at, updatedAt: at })
    .where(
      and(
        eq(sandboxInstance.machineId, machineId),
        inArray(sandboxInstance.status, ["creating", "starting", "recovering"]),
      ),
    );
}

/** Machine 心跳投影关联 Sandbox Instance 的活跃时间。 */
export async function touchSandboxInstanceHeartbeatForMachine(machineId: string, at = new Date()): Promise<void> {
  await db
    .update(sandboxInstance)
    .set({ lastHeartbeatAt: at, updatedAt: at })
    .where(eq(sandboxInstance.machineId, machineId));
}
