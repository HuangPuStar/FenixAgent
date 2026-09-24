import type { Edge, Node } from "@xyflow/react";
import type { DAGSnapshot } from "../../api/workflow-engine";
import { START_NODE_ID } from "./yaml-utils";

/**
 * 画布节点上的「运行标记」模型（纯函数，§3.5）。
 *
 * 运行视图会给每个节点打四个标记：`_runStatus` / `_exitCode`（来自引擎快照）与
 * `_onViewOutput` / `_onRerunFrom`（节点上「看输出 / 从这里重跑」按钮的回调）。这四样总是整组一起
 * 写入或清除，而触发的时机有四种：快照到达、发起运行时的乐观置位、重跑时对目标及其下游置位、
 * 退出运行视图时整组清除。拆分前这四段 `setNodes((nds) => nds.map(...))` 内联在 `useWorkflowRun`
 * 的回调里，与请求编排混在一处；现在「标记长什么样、怎么落」只在本文件定义。
 *
 * 与 `run-view.ts` 的分工：那边是**运行视图态**（快照 / 事件 / 待审批 / 选中节点 / 输出）的整组复位，
 * 这边只碰画布节点 data 上的标记。
 */
export interface RunNodeCallbacks {
  onViewOutput: (nodeId: string) => void;
  onRerunFrom: (fromNodeId: string) => void;
}

/** DAG 是否已到终态：不再需要轮询，画布可退出只读。 */
export function isTerminalDagStatus(status: string | undefined): boolean {
  return status ? ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(status) : false;
}

/**
 * 把引擎快照落到节点上。
 *
 * 两条「不要覆盖乐观状态」的规则保留原样：① DAG 正在运行但快照尚无该节点状态时（引擎尚未开始调度），
 * 保留现有的 RUNNING；② 前端已乐观设为 RUNNING、而 snapshot 返回 PENDING 时也保持 RUNNING
 * （快照可能在引擎调度该节点之前创建）。开始节点不参与运行标记。
 */
export function applySnapshotToNodes(nodes: Node[], snap: DAGSnapshot, callbacks: RunNodeCallbacks): Node[] {
  const dagRunning = snap.dag_status === "RUNNING";
  return nodes.map((n) => {
    if (n.id === START_NODE_ID) return n;
    const state = snap.node_states?.[n.id];
    if (!state) {
      if (dagRunning && n.data._runStatus === "RUNNING") return n;
      return {
        ...n,
        data: {
          ...n.data,
          _runStatus: undefined,
          _exitCode: undefined,
          _onViewOutput: undefined,
          _onRerunFrom: undefined,
        },
      };
    }
    const prevStatus = n.data._runStatus as string | undefined;
    if (dagRunning && state.status === "PENDING" && prevStatus === "RUNNING") {
      return n;
    }
    return {
      ...n,
      data: {
        ...n.data,
        _runStatus: state.status,
        _exitCode: state.exit_code,
        _onViewOutput: callbacks.onViewOutput,
        _onRerunFrom: callbacks.onRerunFrom,
      },
    };
  });
}

/** 发起运行时的乐观状态：除开始节点外全部标为 RUNNING。 */
export function markAllNodesRunning(nodes: Node[]): Node[] {
  return nodes.map((n) =>
    n.id === START_NODE_ID ? n : { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } },
  );
}

/**
 * 重跑时的乐观状态：目标节点及其**下游**标为 RUNNING，上游保持不变。
 * 下游按边方向做一次广度遍历，开始节点发出的边不参与（它不是可重跑的节点）。
 */
export function markDownstreamRunning(nodes: Node[], edges: Edge[], fromNodeId: string): Node[] {
  const downstream = new Set<string>();
  const adjMap = new Map<string, string[]>();
  for (const e of edges) {
    if (e.source === START_NODE_ID) continue;
    const list = adjMap.get(e.source) ?? [];
    list.push(e.target);
    adjMap.set(e.source, list);
  }
  const q = [fromNodeId];
  while (q.length > 0) {
    const cur = q.shift()!;
    for (const next of adjMap.get(cur) ?? []) {
      if (!downstream.has(next)) {
        downstream.add(next);
        q.push(next);
      }
    }
  }
  return nodes.map((n) => {
    if (n.id === START_NODE_ID) return n;
    const isTarget = n.id === fromNodeId || downstream.has(n.id);
    if (isTarget) return { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } };
    return n;
  });
}

/** 退出运行视图：清掉**所有**节点的运行标记（含开始节点，与快照路径的跳过规则不同）。 */
export function clearRunMarkers(nodes: Node[]): Node[] {
  return nodes.map((n) => ({
    ...n,
    data: {
      ...n.data,
      _runStatus: undefined,
      _exitCode: undefined,
      _onViewOutput: undefined,
      _onRerunFrom: undefined,
    },
  }));
}
