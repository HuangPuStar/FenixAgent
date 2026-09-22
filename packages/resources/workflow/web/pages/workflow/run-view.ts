import type { DAGEvent, DAGSnapshot, NodeOutput, PendingApproval } from "../../api/workflow-engine";

/**
 * 「运行视图态」的整组复位。
 *
 * 这 5 个状态总是一起变：进入一次运行（手动运行 / 重跑 / SSE 通知的运行开始 / 运行记录里点一条）、
 * 回到编辑态、以及编辑器切换工作流、回放历史运行，都要先把它们清空再填其它值。此前这 5 行语句在包内
 * 逐字重复 8 处——`useWorkflowRun` 5 处（handleRun / handleRerunFrom / handleWorkflowEvent / handleBackToEdit /
 * handleBackToList）、`WorkflowEditor` 2 处（workflowId 切换、runId 回放）、`RunStatusPanel` 1 处
 * （运行记录点选），于是「运行视图态到底由哪几个字段组成」只能靠逐一读这些调用点拼出来。
 *
 * 为什么是纯函数而不是 hook：三种调用形态都要用它，且 setter 的来源各不相同（hook 参数 / 组件 useState /
 * 组件 props），只有「一次调用即整组归位」是共同的那件事。setter 打包留在调用方：`useWorkflowRun` 与
 * `WorkflowEditor` 各打包一次（`runViewSetters`，两处都是 5 个 setter 的固定集合），`RunStatusPanel` 只有
 * 一处调用，直接传对象字面量。于是新增第 6 个运行视图态时改动落在「本文件 + 两处打包点 + 一处字面量」，
 * 而不是 8 处语句块。纯函数也保证 `run-view.ts` 不依赖 React（只 import 类型），可被包内任意层调用。
 *
 * 刻意**不**并入的相邻状态（它们与运行视图态同处一个回调里，但取值和时机不同，留在调用点）：
 * `activeRunId`（进入运行时赋新值、退出时才置 null，两种语义都出现在调用点）、`running`、`dryRunResult`、
 * 以及画布节点 data 上的 `_runStatus` / `_exitCode` / `_onViewOutput` / `_onRerunFrom` 标记
 * （需要 setNodes + map，形状与整组 setter 不同）。
 */
export interface RunViewSetters {
  setRunSnapshot: (snapshot: DAGSnapshot | null) => void;
  setRunEvents: (events: DAGEvent[]) => void;
  setRunApprovals: (approvals: PendingApproval[]) => void;
  setSelectedRunNodeId: (nodeId: string | null) => void;
  setSelectedNodeOutput: (output: NodeOutput | null) => void;
}

/** 运行视图态整组归位：快照、事件流、待审批、选中节点及其输出各自回到空值。 */
export function resetRunView({
  setRunSnapshot,
  setRunEvents,
  setRunApprovals,
  setSelectedRunNodeId,
  setSelectedNodeOutput,
}: RunViewSetters): void {
  setRunSnapshot(null);
  setRunEvents([]);
  setRunApprovals([]);
  setSelectedRunNodeId(null);
  setSelectedNodeOutput(null);
}
