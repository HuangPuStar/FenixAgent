import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { machine } from "../db/schema";

/** 查询 Machine 当前是否已由 ACP 注册并处于在线状态。 */
export async function isMachineOnline(machineId: string): Promise<boolean> {
  const rows = await db.select({ status: machine.status }).from(machine).where(eq(machine.id, machineId)).limit(1);

  return rows[0]?.status === "online";
}

/**
 * 按 machine id 批量查询展示名称（Observer 面板 name(id) 展示用，只读）。
 * 优先 `name` 列，回退到必填的 `agentName` 列；空入参返回空 Map。
 */
export async function findMachineNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: machine.id, name: machine.name, agentName: machine.agentName })
    .from(machine)
    .where(inArray(machine.id, ids));
  return new Map(rows.map((row) => [row.id, row.name ?? row.agentName]));
}

/** 按 machine id 批量查询管理视图所需的状态与心跳信息。 */
export async function findMachinesBasicInfoByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return db
    .select({
      id: machine.id,
      name: machine.name,
      agentName: machine.agentName,
      status: machine.status,
      lastHeartbeatAt: machine.lastHeartbeatAt,
    })
    .from(machine)
    .where(inArray(machine.id, ids));
}
