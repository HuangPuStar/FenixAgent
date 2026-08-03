import type { AgentMachineData, AgentMachineRepo } from "@fenix/orchestration";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { machine } from "../db/schema";

/** 连接信息缺失时的兜底 host/port：host 指向本机回环，port 0 表示“端口由部署/代理 URL 决定”。 */
const FALLBACK_HOST = "127.0.0.1";
const FALLBACK_PORT = 0;

/**
 * 编排域 AgentMachineRepo 的 PostgreSQL 实现。
 *
 * machine 表只有 `id` 主键是稳定字段，连接地址存放在 `machine_info` jsonb 中。
 */
export class PgAgentMachineRepo implements AgentMachineRepo {
  /**
   * 按机器 ID 读取连接元数据；记录不存在返回 `null`。
   *
   * machine_info 的实际数据形状：注册中心（acp-link）写入的是
   * `{ hostname, ip, mac, os, arch }`，**没有** host/port/wsUrl 字段。因此：
   *   - host：优先取 `host`（兼容未来写入），其次取 `ip`（实际存在且可路由），
   *     都没有时兜底 `127.0.0.1`；
   *   - port：machine_info 中不存在，兜底 `0`（连接端口由服务端部署/代理 URL 决定，
   *     不在 machine 元数据中维护）。
   */
  async getMachine(machineId: string): Promise<AgentMachineData | null> {
    const rows = await db
      .select({ machineInfo: machine.machineInfo })
      .from(machine)
      .where(eq(machine.id, machineId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;

    const info = toRecord(row.machineInfo);
    const host =
      (typeof info.host === "string" && info.host !== "" ? info.host : undefined) ??
      (typeof info.ip === "string" && info.ip !== "" ? info.ip : undefined) ??
      FALLBACK_HOST;
    const port = toPort(info.port);

    return { id: machineId, host, port };
  }
}

/** 将 jsonb 值安全收窄为对象；非对象（null / 数组 / 标量）返回空对象。 */
function toRecord(raw: unknown): Record<string, unknown> {
  return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

/** 将 jsonb 中的 port 安全转换为合法端口号；缺失或非法时返回兜底 0。 */
function toPort(raw: unknown): number {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw >= 1 && raw <= 65535 ? Math.trunc(raw) : FALLBACK_PORT;
  }
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) && parsed >= 1 && parsed <= 65535 ? Math.trunc(parsed) : FALLBACK_PORT;
  }
  return FALLBACK_PORT;
}

/** 编排域 AgentMachineRepo 单例。 */
export const agentMachineRepo = new PgAgentMachineRepo();
