/**
 * 工作流存储抽象接口。
 *
 * 所有方法返回 Promise，适配内存、PostgreSQL 等不同后端。
 * 内存实现天然原子；数据库实现需要在 `atomicNodeComplete` 中使用事务。
 */

import type { DAGEvent, DAGSnapshot, DAGStatus, EventType, NodeOutput, RunSummary } from "../types/execution";

export interface StorageAdapter {
  // ---------- 事件 ----------

  /** 追加一条 DAG 事件 */
  appendEvent(event: DAGEvent): Promise<void>;

  /**
   * 查询事件，支持组合过滤（AND 逻辑）。
   * - `afterEventId`: 返回该事件之后的事件
   * - `nodeId`: 按节点 ID 过滤
   * - `types`: 按事件类型过滤
   */
  getEvents(
    runId: string,
    opts?: {
      afterEventId?: string;
      nodeId?: string;
      types?: EventType[];
    },
  ): Promise<DAGEvent[]>;

  // ---------- 快照 ----------

  /** 获取指定运行最新的快照，不存在返回 null */
  getLatestSnapshot(runId: string): Promise<DAGSnapshot | null>;

  /** 持久化快照 */
  createSnapshot(snapshot: DAGSnapshot): Promise<void>;

  // ---------- 节点输出 ----------

  /** 获取指定节点的输出，不存在返回 null */
  getOutput(runId: string, nodeId: string): Promise<NodeOutput | null>;

  /** 写入节点输出 */
  setOutput(runId: string, nodeId: string, output: NodeOutput): Promise<void>;

  // ---------- 运行查询 ----------

  /** 列出所有运行摘要，可按 projectId 过滤 */
  listRuns(projectId?: string): Promise<RunSummary[]>;

  /** 获取运行状态，不存在返回 null */
  getRunStatus(runId: string): Promise<DAGStatus | null>;

  // ---------- 原子操作 ----------

  /**
   * 原子写入节点完成结果：output + snapshot + event 在同一事务中写入。
   * 内存实现按顺序写入即可（单线程天然原子）。
   */
  atomicNodeComplete(opts: { output: NodeOutput; snapshot: DAGSnapshot; event: DAGEvent }): Promise<void>;

  // ---------- 清理 ----------

  /** 删除指定运行的所有关联数据（事件、快照、输出、状态、摘要） */
  deleteRun(runId: string): Promise<void>;
}
