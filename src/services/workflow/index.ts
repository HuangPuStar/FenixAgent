/**
 * WorkflowEngine 服务单例。
 *
 * 每个 team 缓存一个 (engine + transport + channelFactory) 三元组，因为：
 * - StorageAdapter 按 organizationId 隔离数据，不能跨 organization 共享
 * - Transport 持有 channelFactory，必须绑定到正确的 organizationId（否则跨组织泄露）
 * - 引擎内部维护 activeRuns Map（取消/审批状态），不能每次请求重建
 *
 * 服务层职责：
 * - 解析环境名称 → 启动实例 → 建立 relay 连接
 * - 提供已就绪的 AgentChannel 给 Transport 层
 * - workflow 结束后统一销毁启动的实例
 */

import { createLogger } from "@fenix/logger";
import type { EngineRelayMessage } from "@fenix/plugin-sdk";
import type { Transport, WorkflowEngine } from "@fenix/workflow-engine";
import { createWorkflowEngine } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { environment } from "../../db/schema";
import { getCoreRuntime } from "../../services/core-bootstrap";
import { ensureRunning, getRunningInstancesByEnvironment, stopInstance } from "../instance";
import { type AgentChannel, type ChannelFactory, createAcpTransport } from "./acp-transport";
import { getCustomToolsRegistry } from "./custom-tools";
import { createPgStorageAdapter } from "./pg-storage-adapter";

const logger = createLogger("wf-service");

interface TeamRuntime {
  engine: WorkflowEngine;
  transport: Transport;
}

// 每个 team 一个 (engine, transport) 对，lazy 创建、互相隔离
const teamRuntimes = new Map<string, TeamRuntime>();

/**
 * 创建 ChannelFactory — 服务层的核心桥接。
 *
 * 流程：envName → DB 查 Environment → ensureRunning 启动实例 → connectInstanceRelay 建立 relay → 返回 AgentChannel
 *
 * 注意：factory 闭包绑定 organizationId，所有 DB 查询都带 organizationId 过滤，
 * 避免跨组织数据泄露。
 */
function createChannelFactory(organizationId: string): ChannelFactory {
  return async (envName: string, options?: { spawnedEnvIds?: Set<string> }): Promise<AgentChannel> => {
    // 1. 按 name 查 Environment（限定当前组织）
    const [envRow] = await db
      .select({ id: environment.id })
      .from(environment)
      .where(and(eq(environment.name, envName), eq(environment.organizationId, organizationId)))
      .limit(1);

    if (!envRow) throw new Error(`Environment '${envName}' not found`);

    // 2. 确保实例运行
    const { instance, status } = await ensureRunning("system", envRow.id);
    if (status === "spawned") {
      options?.spawnedEnvIds?.add(envRow.id);
    }

    // 3. 通过 CoreRuntimeFacade 建立 relay 连接
    const facade = getCoreRuntime();
    const handle = await facade.connectInstanceRelay({ instanceId: instance.id });

    // 4. 等待 relay ready（ready 已在 EngineRelayHandle 中声明）
    if (handle.ready) {
      await handle.ready;
    }

    // 5. 适配为 AgentChannel
    return {
      send: (message: unknown) => {
        handle.send(message as { type: string; payload?: unknown });
      },
      onMessage: (handler: (msg: Record<string, unknown>) => void) => {
        if (handle.onMessage) {
          return handle.onMessage(handler as unknown as (message: EngineRelayMessage) => void);
        }
        return () => {};
      },
    };
  };
}

/** workflow 结束后销毁期间启动的实例 */
export async function cleanupSpawnedEnvironments(envIds: Set<string>, organizationId: string): Promise<void> {
  for (const envId of envIds) {
    try {
      const instances = getRunningInstancesByEnvironment(envId);
      for (const inst of instances) {
        await stopInstance(inst.id, organizationId);
      }
    } catch (err) {
      logger.error(`Failed to stop environment: envId=${envId}`, err);
    }
  }
}

/** 获取或创建指定 team 的 WorkflowEngine 实例。
 *  Transport + ChannelFactory 全部按 organizationId 隔离，绝不跨组织复用。 */
export function getTeamEngine(organizationId: string): WorkflowEngine {
  let runtime = teamRuntimes.get(organizationId);
  if (!runtime) {
    const channelFactory = createChannelFactory(organizationId);
    const transport = createAcpTransport(channelFactory);
    const storage = createPgStorageAdapter(organizationId);
    const engine = createWorkflowEngine({
      storage,
      transport,
      hmacSecret: process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID(),
      // 注入全局 CustomNodeRegistry（启动时 discover tools/ 已就绪）
      // 让 yaml 中 type: custom + tool: trim_galore 等节点找到对应实现
      customRegistry: getCustomToolsRegistry(),
    });
    runtime = { engine, transport };
    teamRuntimes.set(organizationId, runtime);
  }
  return runtime.engine;
}

/** 移除指定 team 的 WorkflowEngine 实例（释放内存） */
export function removeTeamEngine(organizationId: string): boolean {
  return teamRuntimes.delete(organizationId);
}

/** 清理所有缓存的 engine 实例 */
export function clearAllEngines(): void {
  teamRuntimes.clear();
}
