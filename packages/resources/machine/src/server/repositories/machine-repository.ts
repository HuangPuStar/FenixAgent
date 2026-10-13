import { machine } from "@fenix/resource-machine/db";
import { eq, inArray } from "drizzle-orm";
import { getMachineDatabase } from "../db";

/** 查询 Machine 当前是否已由 ACP 注册并处于在线状态。 */
export async function isMachineOnline(machineId: string): Promise<boolean> {
  const db = getMachineDatabase();
  const rows = await db.select({ status: machine.status }).from(machine).where(eq(machine.id, machineId)).limit(1);

  return rows[0]?.status === "online";
}

/**
 * 按 machine id 批量查询展示名称（Observer 面板 name(id) 展示用，只读）。
 * 优先 `name` 列，回退到必填的 `agentName` 列；空入参返回空 Map。
 */
export async function findMachineNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const db = getMachineDatabase();
  const rows = await db
    .select({ id: machine.id, name: machine.name, agentName: machine.agentName })
    .from(machine)
    .where(inArray(machine.id, ids));
  return new Map(rows.map((row) => [row.id, row.name ?? row.agentName]));
}

/** 按 machine id 批量查询管理视图所需的状态与心跳信息。 */
export async function findMachinesBasicInfoByIds(ids: string[]) {
  if (ids.length === 0) return [];
  return getMachineDatabase()
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

/** 从 `machine_info` 里取主机名；列是 jsonb、内容由注册方写入，形状不可信，取不到就返回空串。 */
function readHostname(machineInfo: unknown): string {
  if (!machineInfo || typeof machineInfo !== "object") return "";
  return (machineInfo as { hostname?: string }).hostname ?? "";
}

/**
 * 按 machine id 批量取**机器展示标签**：`name`（人工命名）→ `machineInfo.hostname`（自动注册）→
 * `agentName`（必填兜底）；行缺失时由调用方退回 id。
 *
 * 与 {@link findMachineNamesByIds} 的差别只在中间那一环：那个是 Observer 面板的 name(id) 展示，链是
 * `name ?? agentName`；本条多一层 hostname 兜底，喂给的是「Agent 执行节点标签」。两者语义不同，故不合并
 * ——合并会改变其中一方的展示结果。
 */
export async function findMachineLabelsByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getMachineDatabase()
    .select({ id: machine.id, name: machine.name, agentName: machine.agentName, machineInfo: machine.machineInfo })
    .from(machine)
    .where(inArray(machine.id, ids));
  return new Map(rows.map((row) => [row.id, row.name || readHostname(row.machineInfo) || row.agentName]));
}

/** 按 machine id 批量取机器的 **agent 名**（非空列，环境的 `machineName` 用它）；空入参返回空 Map。 */
export async function findMachineAgentNamesByIds(ids: string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await getMachineDatabase()
    .select({ id: machine.id, agentName: machine.agentName })
    .from(machine)
    .where(inArray(machine.id, ids));
  return new Map(rows.map((row) => [row.id, row.agentName]));
}
