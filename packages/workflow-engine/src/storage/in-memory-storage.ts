/**
 * 内存存储实现，用于测试和开发。
 *
 * 所有数据保存在内存 Map 中，不持久化。
 * `atomicNodeComplete` 按顺序写入，单线程 JS 下天然原子。
 */

import type { DAGEvent, DAGSnapshot, DAGStatus, EventType, NodeOutput, RunSummary } from "../types/execution";
import type { StorageAdapter } from "./storage-adapter";

export function createInMemoryStorage(): StorageAdapter {
  const events = new Map<string, DAGEvent[]>();
  const snapshots = new Map<string, DAGSnapshot[]>();
  const outputs = new Map<string, Map<string, NodeOutput>>();
  const runStatuses = new Map<string, DAGStatus>();
  const runSummaries = new Map<string, RunSummary>();

  return {
    // ---------- 事件 ----------

    async appendEvent(event: DAGEvent): Promise<void> {
      const list = events.get(event.run_id) ?? [];
      list.push(event);
      events.set(event.run_id, list);
    },

    async getEvents(
      runId: string,
      opts?: {
        afterEventId?: string;
        nodeId?: string;
        types?: EventType[];
      },
    ): Promise<DAGEvent[]> {
      let list = events.get(runId) ?? [];
      if (opts?.afterEventId) {
        const idx = list.findIndex((e) => e.event_id === opts.afterEventId);
        if (idx !== -1) {
          list = list.slice(idx + 1);
        }
      }
      if (opts?.nodeId) {
        list = list.filter((e) => e.node_id === opts.nodeId);
      }
      if (opts?.types?.length) {
        const typeSet = new Set(opts.types);
        list = list.filter((e) => typeSet.has(e.type));
      }
      return list;
    },

    // ---------- 快照 ----------

    async getLatestSnapshot(runId: string): Promise<DAGSnapshot | null> {
      const list = snapshots.get(runId);
      if (!list?.length) return null;
      return list[list.length - 1];
    },

    async createSnapshot(snapshot: DAGSnapshot): Promise<void> {
      const list = snapshots.get(snapshot.run_id) ?? [];
      list.push(snapshot);
      snapshots.set(snapshot.run_id, list);
    },

    // ---------- 节点输出 ----------

    async getOutput(runId: string, nodeId: string): Promise<NodeOutput | null> {
      return outputs.get(runId)?.get(nodeId) ?? null;
    },

    async setOutput(runId: string, nodeId: string, output: NodeOutput): Promise<void> {
      const nodeMap = outputs.get(runId) ?? new Map<string, NodeOutput>();
      nodeMap.set(nodeId, output);
      outputs.set(runId, nodeMap);
    },

    // ---------- 运行查询 ----------

    async listRuns(projectId?: string): Promise<RunSummary[]> {
      const all = Array.from(runSummaries.values());
      if (projectId) {
        return all.filter((r) => r.project_id === projectId);
      }
      return all;
    },

    async getRunStatus(runId: string): Promise<DAGStatus | null> {
      return runStatuses.get(runId) ?? null;
    },

    // ---------- 原子操作 ----------

    async atomicNodeComplete(opts: { output: NodeOutput; snapshot: DAGSnapshot; event: DAGEvent }): Promise<void> {
      // 写入节点输出
      const { snapshot, event } = opts;
      const runId = snapshot.run_id;
      const nodeMap = outputs.get(runId) ?? new Map<string, NodeOutput>();
      // 从 snapshot.node_states 推断 nodeId
      // event.node_id 更直接
      if (event.node_id) {
        nodeMap.set(event.node_id, opts.output);
        outputs.set(runId, nodeMap);
      }

      // 写入快照
      const snapList = snapshots.get(runId) ?? [];
      snapList.push(snapshot);
      snapshots.set(runId, snapList);

      // 追加事件
      const evtList = events.get(runId) ?? [];
      evtList.push(event);
      events.set(runId, evtList);
    },

    // ---------- 清理 ----------

    async deleteRun(runId: string): Promise<void> {
      events.delete(runId);
      snapshots.delete(runId);
      outputs.delete(runId);
      runStatuses.delete(runId);
      runSummaries.delete(runId);
    },
  };
}
