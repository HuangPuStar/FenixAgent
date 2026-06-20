/**
 * WorkflowEngine 服务单例。
 *
 * 每个 team 缓存一个引擎实例（Map），因为：
 * - StorageAdapter 按 organizationId 隔离数据，不能跨 organization 共享
 * - 引擎内部维护 activeRuns Map（取消/审批状态），不能每次请求重建
 *
 * 服务层职责：
 * - 解析环境名称 → 启动实例 → 建立 relay 连接
 * - 提供已就绪的 AgentChannel 给 Transport 层
 * - workflow 结束后统一销毁启动的实例
 */

import type { Transport, WorkflowEngine } from "@fenix/workflow-engine";
import { createWorkflowEngine } from "@fenix/workflow-engine";
import { and, eq } from "drizzle-orm";
import { db } from "../../db";
import { environment } from "../../db/schema";
import { getCoreRuntime } from "../../services/core-bootstrap";
import { ensureRunning, getRunningInstancesByEnvironment, stopInstance } from "../instance";
import { type AgentChannel, createAcpTransport, setChannelFactory } from "./acp-transport";
import { getCustomToolsRegistry } from "./custom-tools";
import { createPgStorageAdapter } from "./pg-storage-adapter";

// 每个 team 一个引擎实例，lazy 创建
const engines = new Map<string, WorkflowEngine>();
let _transport: Transport | null = null;

/** 获取全局共享的 Transport 单例，注入 ChannelFactory */
function getTransport(organizationId: string): Transport {
  if (!_transport) {
    _transport = createAcpTransport();
    setChannelFactory(createChannelFactory(organizationId));
  }
  return _transport;
}

/**
 * 创建 ChannelFactory — 服务层的核心桥接。
 *
 * 流程：envName → DB 查 Environment → ensureRunning 启动实例 → connectInstanceRelay 建立 relay → 返回 AgentChannel
 */
function createChannelFactory(organizationId: string) {
  return async (envName: string, options?: { spawnedEnvIds?: Set<string> }): Promise<AgentChannel> => {
    console.error(`[workflow] ChannelFactory start: envName=${envName} orgId=${organizationId}`);

    // 1. 按 name 查 Environment
    const [envRow] = await db
      .select({ id: environment.id })
      .from(environment)
      .where(and(eq(environment.name, envName), eq(environment.organizationId, organizationId)))
      .limit(1);

    if (!envRow) {
      console.error(`[workflow] ChannelFactory environment not found: envName=${envName}`);
      throw new Error(`Environment '${envName}' not found`);
    }

    // 2. 确保实例运行
    const { instance, status } = await ensureRunning("system", envRow.id);
    console.error(
      `[workflow] ChannelFactory ensureRunning: envId=${envRow.id} instanceId=${instance.id} status=${status}`,
    );
    if (status === "spawned") {
      options?.spawnedEnvIds?.add(envRow.id);
    }

    // 3. 通过 CoreRuntimeFacade 建立 relay 连接
    const facade = getCoreRuntime();
    const handle = await facade.connectInstanceRelay({ instanceId: instance.id });

    // 4. 等待 relay ready（handle 内部会等 WS open）
    if ("ready" in handle && handle.ready instanceof Promise) {
      await handle.ready;
    }

    const hasOnMessage = "onMessage" in handle && typeof (handle as { onMessage?: unknown }).onMessage === "function";
    console.error(`[workflow] ChannelFactory relay ready: instanceId=${instance.id} hasOnMessage=${hasOnMessage}`);

    // 5. 适配为 AgentChannel
    return {
      send: (message: unknown) => {
        handle.send(message as { type: string; payload?: unknown });
      },
      onMessage: (handler: (msg: Record<string, unknown>) => void) => {
        if (hasOnMessage) {
          const opencodeHandle = handle as {
            onMessage: (listener: (msg: Record<string, unknown>) => void) => () => void;
          };
          return opencodeHandle.onMessage(handler);
        }
        console.error(
          `[workflow] ChannelFactory onMessage UNAVAILABLE: instanceId=${instance.id} — relay handle has no onMessage`,
        );
        // 没有 onMessage 则返回空 unsub
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
      console.error(`[Workflow] Failed to stop environment ${envId}:`, err);
    }
  }
}

/** 获取或创建指定 team 的 WorkflowEngine 实例 */
export function getTeamEngine(organizationId: string): WorkflowEngine {
  let engine = engines.get(organizationId);
  if (!engine) {
    const storage = createPgStorageAdapter(organizationId);
    engine = createWorkflowEngine({
      storage,
      transport: getTransport(organizationId),
      hmacSecret: process.env.RCS_WORKFLOW_HMAC_SECRET || crypto.randomUUID(),
      // 注入全局 CustomNodeRegistry（启动时 discover tools/ 已就绪）
      // 让 yaml 中 type: custom + tool: trim_galore 等节点找到对应实现
      customRegistry: getCustomToolsRegistry(),
    });
    engines.set(organizationId, engine);
  }
  return engine;
}

/** 移除指定 team 的 WorkflowEngine 实例（释放内存） */
export function removeTeamEngine(organizationId: string): boolean {
  return engines.delete(organizationId);
}

/** 清理所有缓存的 engine 实例 */
export function clearAllEngines(): void {
  engines.clear();
}
