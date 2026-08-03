import type { EnvironmentData, EnvironmentRepo } from "@fenix/orchestration";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { agentConfig, environment } from "../db/schema";

/**
 * 编排域 EnvironmentRepo 的 PostgreSQL 实现。
 *
 * 与 repositories/environment.ts（管理侧 CRUD repo）独立：本实现只提供编排域所需的
 * 最小读视图，并承担 machineId 的默认值 fallback，编排域不读取环境变量。
 */
export class PgEnvironmentOrchestrationRepo implements EnvironmentRepo {
  /**
   * 按环境 ID 读取环境数据；记录不存在或未绑定 agentConfigId 时返回 `null`。
   *
   * machineId 解析优先级（与旧 services/instance.ts 的节点选择逻辑一致）：
   *   1. environment.agentConfigId → agent_config.machineId（leftJoin 一次取出）；
   *   2. config.defaultMachineId（RCS_DEFAULT_MACHINE_ID 环境变量）；
   *   3. 本地执行占位节点 "local-default"（RCS_DISABLE_LOCAL_EXECUTION 未设置时），
   *      与旧路径 nodeId 三选一（agent config 绑定 > 系统默认 > local-default）一致；
   *   4. 禁用本地执行且无任何 machine 配置时为 null，编排域视为配置错误拒绝启动。
   * 占位节点由宿主侧本地节点服务（src/services/local-node-service.ts）供给，
   * core 侧在 disableLocalExecution 时同样不注册 local-default 节点。
   */
  async getEnvironment(envId: string): Promise<EnvironmentData | null> {
    const rows = await db
      .select({
        id: environment.id,
        organizationId: environment.organizationId,
        agentConfigId: environment.agentConfigId,
        maxSessions: environment.maxSessions,
        autoStart: environment.autoStart,
        configMachineId: agentConfig.machineId,
      })
      .from(environment)
      .leftJoin(agentConfig, eq(environment.agentConfigId, agentConfig.id))
      .where(eq(environment.id, envId))
      .limit(1);

    const row = rows[0];
    // 记录不存在，或未绑定 AgentConfig（旧的无配置最小启动路径不在编排域范围内）。
    if (!row?.agentConfigId) return null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      agentConfigId: row.agentConfigId,
      machineId:
        row.configMachineId ??
        config.defaultMachineId ??
        // 本地执行占位节点（与旧路径 nodeId 兜底语义一致）；禁用本地执行时
        // 无兜底，编排域 AgentController 会以配置错误拒绝启动。
        (config.disableLocalExecution ? null : "local-default"),
      // environment.maxSessions 即编排域的并发上限语义。
      maxConcurrency: row.maxSessions,
      autoStart: row.autoStart ?? false,
    };
  }
}

/** 编排域 EnvironmentRepo 单例。 */
export const environmentOrchestrationRepo = new PgEnvironmentOrchestrationRepo();
