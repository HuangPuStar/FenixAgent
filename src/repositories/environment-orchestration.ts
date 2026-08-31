import type { EnvironmentData, EnvironmentRepo } from "@fenix/orchestration";
import { eq } from "drizzle-orm";
import { config } from "../config";
import { db } from "../db";
import { agentConfig, environment } from "../db/schema";

/**
 * 宿主注入的"执行节点解析器"（可选）。
 *
 * 编排域 EnvironmentRepo 只负责读数据与默认 fallback，不承载业务规则；sandbox /
 * agentNode 等执行节点解析属业务语义（资源创建、节点优先级），由 services 层
 * （orchestration-bootstrap 装配时）注入实现，避免 repository 反向依赖 services。
 *
 * @param input.agentNode agent_config.agentNode 原始 JSON（未解析）
 * @param input.configMachineId agent_config.machineId 列值（历史字段，空串视为未绑定）
 * @returns 解析出的执行节点 machineId；返回 null 时由本 repo 走默认 fallback 链
 */
export type ExecutionNodeResolver = (input: {
  envId: string;
  organizationId: string | null;
  userId?: string;
  agentNode: unknown;
  configMachineId: string | null;
}) => Promise<string | null>;

/**
 * 编排域 EnvironmentRepo 的 PostgreSQL 实现。
 *
 * 与 repositories/environment.ts（管理侧 CRUD repo）独立：本实现只提供编排域所需的
 * 最小读视图，并承担 machineId 的默认值 fallback，编排域不读取环境变量。
 */
export class PgEnvironmentOrchestrationRepo implements EnvironmentRepo {
  private executionNodeResolver: ExecutionNodeResolver | null = null;

  /** 注入执行节点解析器（services 层装配时调用）；传入 null 恢复默认解析链。 */
  setExecutionNodeResolver(resolver: ExecutionNodeResolver | null): void {
    this.executionNodeResolver = resolver;
  }

  /**
   * 按环境 ID 读取环境数据；仅记录不存在时返回 `null`。
   *
   * 无 agentConfigId 的环境（ACP/Bridge 注册路径创建）不在此拒绝：编排域
   * LaunchSpecBuilder 的 agentConfig 必填约束在 spawn 层兜底（LaunchSpecBuildError
   * → 422），这里只需保证 machineId 仍按 fallback 链解析，与
   * src/services/remote-file-service.ts 的 getRemoteMachineId 语义对齐。
   *
   * machineId 解析优先级（与旧 services/instance.ts 的节点选择逻辑一致）：
   *   1. 注入的 executionNodeResolver（agentNode 显式 sandbox / machine 解析，
   *      见 orchestration-bootstrap 装配实现；sandbox 分支会准备执行节点）；
   *   2. agent_config.machineId 列（仅 agentNode 为 null 时生效 —— agentNode 存在
   *      即权威，与 resolveAgentNode 语义对齐，避免 spawn/文件路径分裂；
   *      空串视为未绑定，见下方 `||` 注释）；
   *   3. config.defaultMachineId（RCS_DEFAULT_MACHINE_ID 环境变量）；
   *   4. 本地执行占位节点 "local-default"（RCS_DISABLE_LOCAL_EXECUTION 未设置时），
   *      与旧路径 nodeId 三选一（agent config 绑定 > 系统默认 > local-default）一致；
   *   5. 禁用本地执行且无任何 machine 配置时为 null，编排域视为配置错误拒绝启动。
   * 占位节点由宿主侧本地节点服务（src/services/local-node-service.ts）供给，
   * core 侧在 disableLocalExecution 时同样不注册 local-default 节点。
   */
  async getEnvironment(envId: string, userId?: string): Promise<EnvironmentData | null> {
    const rows = await db
      .select({
        id: environment.id,
        organizationId: environment.organizationId,
        agentConfigId: environment.agentConfigId,
        autoStart: environment.autoStart,
        maxSessions: environment.maxSessions,
        configMachineId: agentConfig.machineId,
        agentNode: agentConfig.agentNode,
        envUserId: environment.userId,
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

    // 业务节点解析（sandbox / agentNode）优先，默认链兜底。
    // userId 缺省时回退到环境属主（历史调用方不传 userId 时资源归属到环境属主）。
    const resolvedNodeId = this.executionNodeResolver
      ? await this.executionNodeResolver({
          envId,
          organizationId: row.organizationId,
          userId: userId ?? row.envUserId ?? undefined,
          agentNode: row.agentNode,
          configMachineId: row.configMachineId,
        })
      : null;

    return {
      id: row.id,
      organizationId: row.organizationId,
      agentConfigId: row.agentConfigId,
      machineId:
        resolvedNodeId ??
        // `||`（而非 `??`）是有意为之：空串表示"未绑定"（请求体直传 machineId:"" 或历史
        // 脏数据），须与 null 同样走 fallback 链；`??` 只归一 null/undefined，会把空串当
        // 合法绑定值透传导致 ensureNode 启动失败。与 CLAUDE.md 默认 `??` 惯例相悖处，
        // 以"空串 = 未绑定"这一旧路径 falsy 语义（0dcb2e2d 前）为准。
        //
        // agentNode 非 null 时跳过 machineId 列：与 resolveAgentNode 的权威语义对齐
        // （agent_config.agentNode 存在即权威，空对象 {} 表示"显式清空"也应忽略历史列，
        // 否则 spawn 用列、文件路径忽略列会分裂，实例在列绑定机器上运行而文件操作
        // 落到默认机器/本地）。agentNode 为 null（历史数据、合并前恒为 null）时列照常生效。
        (row.agentNode == null ? row.configMachineId || null : null) ??
        config.defaultMachineId ??
        // 本地执行占位节点（与旧路径 nodeId 兜底语义一致）；禁用本地执行时
        // 无兜底，编排域 AgentController 会以配置错误拒绝启动。
        (config.disableLocalExecution ? null : "local-default"),
      maxConcurrency: row.maxSessions,
      autoStart: row.autoStart ?? false,
    };
  }
}

/** 编排域 EnvironmentRepo 单例。 */
export const environmentOrchestrationRepo = new PgEnvironmentOrchestrationRepo();
