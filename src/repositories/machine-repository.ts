import { eq } from "drizzle-orm";
import { db } from "../db";
import { machine } from "../db/schema";

/** 查询 Machine 当前是否已由 ACP 注册并处于在线状态。 */
export async function isMachineOnline(machineId: string): Promise<boolean> {
  const rows = await db.select({ status: machine.status }).from(machine).where(eq(machine.id, machineId)).limit(1);

  return rows[0]?.status === "online";
}
