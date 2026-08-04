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
   * 按环境 ID 读取环境数据；仅记录不存在时返回 `null`。
   *
   * 无 agentConfigId 的环境（ACP/Bridge 注册路径创建）不在此拒绝：编排域
   * LaunchSpecBuilder 的 agentConfig 必填约束在 spawn 层兜底（LaunchSpecBuildError
   * → 422），这里只需保证 machineId 仍按 fallback 链解析，与
   * src/services/remote-file-service.ts 的 getRemoteMachineId 语义对齐。
   *
   * machineId 解析优先级（与旧 services/instance.ts 的节点选择逻辑一致）：
   *   1. environment.agentConfigId → agent_config.machineId（leftJoin 一次取出，
   *      空串视为未绑定，见下方 `||` 注释）；
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
        autoStart: environment.autoStart,
        configMachineId: agentConfig.machineId,
      })
      .from(environment)
      .leftJoin(agentConfig, eq(environment.agentConfigId, agentConfig.id))
      .where(eq(environment.id, envId))
      .limit(1);

    const row = rows[0];
    // 仅记录不存在时返回 null。无 agentConfigId 的环境（ACP/Bridge 注册路径创建）不再在此
    // 拒绝（断裂点 5）：machineId fallback 仍需执行，agentConfig 必填约束由编排域
    // LaunchSpecBuilder 在 spawn 层兜底（错误从 404 变为 422，见类注释）。
    if (!row) return null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      agentConfigId: row.agentConfigId,
      machineId:
        // `||`（而非 `??`）是有意为之：空串表示"未绑定"（请求体直传 machineId:"" 或历史
        // 脏数据），须与 null 同样走 fallback 链；`??` 只归一 null/undefined，会把空串当
        // 合法绑定值透传导致 ensureNode 启动失败。与 CLAUDE.md 默认 `??` 惯例相悖处，
        // 以"空串 = 未绑定"这一旧路径 falsy 语义（0dcb2e2d 前）为准。
        (row.configMachineId || null) ??
        config.defaultMachineId ??
        // 本地执行占位节点（与旧路径 nodeId 兜底语义一致）；禁用本地执行时
        // 无兜底，编排域 AgentController 会以配置错误拒绝启动。
        (config.disableLocalExecution ? null : "local-default"),
      // 特例（临时放宽）：当前 Web 创建路径将 maxSessions 硬编码为 1 且无配置入口，
      // 导致多实例场景被单环境并发闸门拦截。暂不从 DB 读取，并发上限写死为 1000；
      // 移除条件：Web 控制台提供 maxSessions 配置入口并完成存量数据调整后，
      // 恢复为 maxConcurrency: row.maxSessions。
      maxConcurrency: 1000,
      autoStart: row.autoStart ?? false,
    };
  }
}

/** 编排域 EnvironmentRepo 单例。 */
export const environmentOrchestrationRepo = new PgEnvironmentOrchestrationRepo();
