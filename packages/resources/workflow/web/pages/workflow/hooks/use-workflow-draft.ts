import { unwrap } from "@fenix/web-runtime/api/request";
import type { Edge, Node } from "@xyflow/react";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type WorkflowDefItem, workflowDefApi } from "../../../api/workflow-defs";
import { autoLayout } from "../layout";
import { syncEdgeCounter, syncNodeCounter, type WfMeta, yamlToFlow } from "../yaml-utils";

/**
 * 工作流**定义域的命令面**：草稿加载与版本预览的切换。
 *
 * 三个入口都改「当前画布上的这份定义」，区别只在来源与附带动作：
 * ① `loadDraft`——工作流切换（编辑器在同一个时机还要复位自己的浮层与运行视图态，那些留在编辑器）；
 * ② `handlePreviewVersion`——从版本指示器切到某个历史版本（只读预览，不写 `lastSavedYaml`）；
 * ③ `handleBackToDraft`——从预览切回当前草稿。
 *
 * 状态按本包的既有口径留在编辑器顶层（与运行视图态一致）：`wfData` / `previewVersion` 由编辑器持有、
 * 经 setter 注入，与 `useWorkflowRun` 接收运行视图态的方式相同——这样 `useWorkflowPersistence` 的
 * `readOnly`（依赖 `previewVersion`）与 `setLastSavedYaml`（本 hook 要写）不会形成循环依赖。
 *
 * **为什么仍手写取数（§3.6 留给本轮的问题之一）**：三者都要写同一份 `wfData`（`loadDraft` 与
 * `handleBackToDraft` 各写一次），换成 `useRequest` 会让请求内部再持一份同样的数据，同一份状态出现两个
 * 所有者；要让三处只用一份数据就得引入 `mutate` 之类的机制，而那在本仓零先例（§3.4 要求先确认语义再
 * 使用）。版本预览与 `useWorkflowRun` 的 `handleRefreshDraft` 落画布逻辑同样刻意不合并——差异
 * （是否 setWfData、是否同步计数器、是否重贴运行快照）逐条写在各自的调用点上。
 */
export interface UseWorkflowDraftParams {
  workflowId: string | undefined;
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setEdges: ReturnType<typeof import("@xyflow/react").useEdgesState<Edge>>[1];
  setMeta: React.Dispatch<React.SetStateAction<WfMeta>>;
  setLastSavedYaml: (yaml: string) => void;
  fitView: (opts?: { padding?: number; duration?: number }) => void;
  /** 换了一份定义之后，面板里编辑的节点对象已经不存在，必须收起节点配置面板 */
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  setNodeConfigSheetOpen: (open: boolean) => void;
  /** 版本预览时把 YAML 面板的文本也换成该版本（草稿态与预览态的文本各自成套） */
  setYamlText: (text: string) => void;
  setYamlBaseText: (text: string) => void;
  setWfData: React.Dispatch<React.SetStateAction<WorkflowDefItem | null>>;
  setPreviewVersion: React.Dispatch<React.SetStateAction<number | null>>;
}

export interface UseWorkflowDraftReturn {
  loadDraft: () => Promise<void>;
  handlePreviewVersion: (version: number) => Promise<void>;
  handleBackToDraft: () => Promise<void>;
}

export function useWorkflowDraft({
  workflowId,
  setNodes,
  setEdges,
  setMeta,
  setLastSavedYaml,
  fitView,
  setSelectedNode,
  setNodeConfigSheetOpen,
  setYamlText,
  setYamlBaseText,
  setWfData,
  setPreviewVersion,
}: UseWorkflowDraftParams): UseWorkflowDraftReturn {
  const { t } = useTranslation("workflows");

  /** 加载已保存的工作流草稿（工作流切换时由编辑器调用） */
  const loadDraft = useCallback(async () => {
    if (!workflowId) return;
    // 预览态属于上一份定义，随切换一起清掉
    setPreviewVersion(null);
    try {
      const wf = await unwrap(workflowDefApi.get(workflowId));
      setWfData(wf);
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        // 同步 node/edge 计数器，防止后续新增节点/边时 ID 与已有节点冲突
        syncNodeCounter(newNodes.map((n) => n.id));
        syncEdgeCounter(newEdges.map((e) => e.id));
        const laid = autoLayout(newNodes, newEdges);
        setNodes(laid);
        setEdges(newEdges);
        setMeta(newMeta);
        setLastSavedYaml(wf.draftYaml);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      }
      if (wf.name) setMeta((m) => ({ ...m, name: wf.name }));
      if (wf.description) setMeta((m) => ({ ...m, description: String(wf.description ?? "") }));
    } catch (err) {
      console.error("Failed to load workflow:", err);
      // 加载失败给用户明确反馈：否则用户面对空白画布会以为是新建状态。
      // 文案只取字典（§9.3）：`err.message` 是后端错误信封原文，只进上面的日志。
      toast.error(t("editor.load_failed"));
    }
  }, [workflowId, setNodes, setEdges, setMeta, setLastSavedYaml, fitView, t, setWfData, setPreviewVersion]);

  /** 版本预览：切换到指定版本（只读，不写 lastSavedYaml——它仍代表当前草稿） */
  const handlePreviewVersion = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        const result = await unwrap(workflowDefApi.getVersion(workflowId, version));
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(result.yaml);
        const laid = autoLayout(newNodes, newEdges);
        setNodes(laid);
        setEdges(newEdges);
        setMeta(newMeta);
        setYamlText(result.yaml);
        setYamlBaseText(result.yaml);
        setPreviewVersion(version);
        setSelectedNode(null);
        setNodeConfigSheetOpen(false);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      } catch (err) {
        console.error("Failed to preview version:", err);
        toast.error(t("editor.load_failed"));
      }
    },
    [
      workflowId,
      setNodes,
      setEdges,
      setMeta,
      fitView,
      t,
      setYamlText,
      setYamlBaseText,
      setPreviewVersion,
      setSelectedNode,
      setNodeConfigSheetOpen,
    ],
  );

  /** 版本预览：切回草稿（重新读定义并把预览态清掉） */
  const handleBackToDraft = useCallback(async () => {
    if (!workflowId) return;
    try {
      const wf = await unwrap(workflowDefApi.get(workflowId));
      setWfData(wf);
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        syncNodeCounter(newNodes.map((n) => n.id));
        syncEdgeCounter(newEdges.map((e) => e.id));
        const laid = autoLayout(newNodes, newEdges);
        setNodes(laid);
        setEdges(newEdges);
        setMeta(newMeta);
        setLastSavedYaml(wf.draftYaml);
      }
      setPreviewVersion(null);
      setSelectedNode(null);
      setNodeConfigSheetOpen(false);
      setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
    } catch (err) {
      console.error("Failed to load draft:", err);
      toast.error(t("editor.load_failed"));
    }
  }, [
    workflowId,
    setNodes,
    setEdges,
    setMeta,
    setLastSavedYaml,
    fitView,
    t,
    setWfData,
    setPreviewVersion,
    setSelectedNode,
    setNodeConfigSheetOpen,
  ]);

  return { loadDraft, handlePreviewVersion, handleBackToDraft };
}
