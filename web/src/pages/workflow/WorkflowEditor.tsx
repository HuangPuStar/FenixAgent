import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ReactFlow,
  ReactFlowProvider,
  Controls,
  MiniMap,
  Background,
  useNodesState,
  useEdgesState,
  useReactFlow,
  addEdge,
  type Node,
  type Edge,
  type Connection,
  type OnSelectionChangeFunc,
  BackgroundVariant,
  Panel,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import {
  FilePlus,
  Upload,
  Download,
  LayoutGrid,
  Code,
  X,
  Terminal,
  Bot,
  Globe,
  ShieldCheck,
  GitBranch,
  RefreshCw,
  Eye,
  Edit3,
  Lock,
  Play,
  CheckCircle,
  AlertTriangle,
  List,
  Save,
  Rocket,
  Square,
  Clock,
  Loader,
  XCircle,
  Copy,
  Check,
  ChevronRight,
  Inbox,
  MessageSquare,
} from "lucide-react";
import { nodeTypes } from "./nodes";
import { autoLayout } from "./layout";
import {
  yamlToFlow,
  flowToYaml,
  nextNodeId,
  resetNodeCounter,
  defaultMeta,
  createStartNode,
  START_NODE_ID,
  type WfMeta,
} from "./yaml-utils";
import { ChatPanel } from "../agent-panel/ChatPanel";
import { ensureMetaAgent } from "../../api/meta-agent";
import {
  workflowEngineApi,
  type DAGSnapshot,
  type DAGEvent,
  type NodeOutput,
  type PendingApproval,
  type DAGStatus,
  type RunSummary,
} from "../../api/workflow-engine";
import { workflowDefApi } from "../../api/workflow-defs";
import "./workflow.css";

const PALETTE_ITEMS = [
  { type: "shell", labelKey: "nodes.shell", icon: Terminal, color: "#3b82f6" },
  { type: "python", labelKey: "nodes.python", icon: Code, color: "#0ea5e9" },
  { type: "agent", labelKey: "nodes.agent", icon: Bot, color: "#22c55e" },
  { type: "api", labelKey: "nodes.api", icon: Globe, color: "#8b5cf6" },
  { type: "audit", labelKey: "editor.palette_audit", icon: ShieldCheck, color: "#f59e0b" },
  // { type: "workflow", labelKey: "editor.palette_subworkflow", icon: GitBranch, color: "#ec4899" },
  // { type: "loop", labelKey: "editor.palette_loop", icon: RefreshCw, color: "#06b6d4" },
] as const;

interface WorkflowEditorProps {
  workflowId?: string;
  runId?: string;
}

function WorkflowEditorInner({ workflowId, runId }: WorkflowEditorProps) {
  const { t } = useTranslation("workflows");
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([createStartNode()]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const { fitView, screenToFlowPosition } = useReactFlow();

  const [meta, setMeta] = useState<WfMeta>({ ...defaultMeta });
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [yamlOpen, setYamlOpen] = useState(false);
  const [yamlText, setYamlText] = useState("");
  const [readOnly, setReadOnly] = useState(false);

  // dryRun / run 状态
  const [dryRunResult, setDryRunResult] = useState<{
    valid: boolean;
    issues: Array<{ type: string; message: string; field?: string }>;
  } | null>(null);
  const [running, setRunning] = useState(false);

  // ── 运行模式状态 ──
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [runSnapshot, setRunSnapshot] = useState<DAGSnapshot | null>(null);
  const [runEvents, setRunEvents] = useState<DAGEvent[]>([]);
  const [runApprovals, setRunApprovals] = useState<PendingApproval[]>([]);
  const [selectedRunNodeId, setSelectedRunNodeId] = useState<string | null>(null);
  const [selectedNodeOutput, setSelectedNodeOutput] = useState<NodeOutput | null>(null);
  const [nodeOutputLoading, setNodeOutputLoading] = useState(false);
  const [runRightTab, setRunRightTab] = useState<"events" | "output">("events");
  const [rightTab, setRightTab] = useState<"config" | "run" | "versions">("config");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Meta Agent Chat ──
  const [chatOpen, setChatOpen] = useState(() => {
    const saved = localStorage.getItem("wf-editor:chat-open");
    return saved === "true";
  });
  const [metaAgentId, setMetaAgentId] = useState<string | null>(null);

  const scenePrompt = useMemo(() => {
    if (!workflowId) return undefined;
    const lines = [
      t("editor.workflow_context"),
      `- ${t("editor.workflow_id")}: ${workflowId}`,
      `- ${t("editor.workflow_name")}: ${meta.name || t("editor.workflow_unnamed")}`,
      `- ${t("editor.workflow_desc_label")}: ${meta.description || t("editor.workflow_no_desc")}`,
      `- ${t("editor.workflow_draft_path")}: .agents/workflows/${workflowId}/draft.yaml`,
      t("editor.workflow_read_prompt"),
    ];
    return lines.join("\n");
  }, [workflowId, meta.name, meta.description, t]);

  useEffect(() => {
    localStorage.setItem("wf-editor:chat-open", String(chatOpen));
    if (chatOpen && !metaAgentId) {
      ensureMetaAgent()
        .then((res) => setMetaAgentId(res.environmentId))
        .catch((err) => console.error("Meta Agent failed:", err));
    }
  }, [chatOpen]);

  // ── Agent 配置联动 ──
  const [agentList, setAgentList] = useState<Array<{ name: string; model: string | null; description: string | null }>>(
    [],
  );
  const [agentOverrideOpen, setAgentOverrideOpen] = useState(false);

  useEffect(() => {
    fetch("/web/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ action: "list" }),
    })
      .then((res) => res.json())
      .then((json) => {
        const agents = json?.data?.agents;
        if (Array.isArray(agents)) {
          setAgentList(
            agents.map((a: any) => ({
              name: a.name,
              model: a.model ?? null,
              description: a.description ?? null,
            })),
          );
        }
      })
      .catch((err) => console.error("Failed to load agent list:", err));
  }, []);

  const isRunMode = activeRunId !== null;
  const dagStatus = runSnapshot?.dag_status;
  const isRunDone = dagStatus ? ["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(dagStatus) : false;

  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingConnectSource = useRef<string | null>(null);
  const nodeCallbacksRef = useRef<{
    onViewOutput: (nodeId: string) => void;
    onRerunFrom: (fromNodeId: string) => void;
  }>({ onViewOutput: () => {}, onRerunFrom: () => {} });
  const didConnect = useRef(false);

  // 保存/发布状态
  const [lastSavedYaml, setLastSavedYaml] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [publishing, setPublishing] = useState(false);

  // 加载已保存的工作流草稿
  useEffect(() => {
    if (!workflowId) return;
    (async () => {
      try {
        const wf = await workflowDefApi.get(workflowId);
        if (wf.draftYaml) {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
          const laid = autoLayout(newNodes, newEdges);
          setNodes(laid);
          setEdges(newEdges);
          setMeta(newMeta);
          setLastSavedYaml(wf.draftYaml);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        }
        if (wf.name) setMeta((m) => ({ ...m, name: wf.name }));
        if (wf.description) setMeta((m) => ({ ...m, description: wf.description }));
      } catch (err) {
        console.error("Failed to load workflow:", err);
      }
    })();
  }, [workflowId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load historical run data (point-in-time replay)
  useEffect(() => {
    if (!runId) return;
    let abort = false;
    (async () => {
      try {
        setActiveRunId(runId);
        setRunSnapshot(null);
        setRunEvents([]);
        setRunApprovals([]);
        setSelectedRunNodeId(null);
        setSelectedNodeOutput(null);
        setRightTab("run");

        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (abort) return;
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(t("editor.load_run_failed") + ":", err);
      }
    })();
    return () => {
      abort = true;
    };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Selection ──
  const onSelectionChange: OnSelectionChangeFunc = useCallback(
    ({ nodes: selNodes }) => {
      setSelectedNode(selNodes[0] ?? null);
      if (activeRunId && selNodes[0] && selNodes[0].id !== START_NODE_ID) {
        setSelectedRunNodeId(selNodes[0].id);
      }
    },
    [activeRunId],
  );

  // ── Connection ──
  const onConnect = useCallback(
    (connection: Connection) => {
      didConnect.current = true;
      setEdges((eds) =>
        addEdge(
          {
            ...connection,
            type: "smoothstep",
            animated: connection.source !== START_NODE_ID,
            id: `e-${connection.source}-${connection.target}`,
          },
          eds,
        ),
      );
    },
    [setEdges],
  );

  // ── Drag-to-create ──
  const onConnectStart = useCallback(({ nodeId }: { nodeId: string | null }) => {
    pendingConnectSource.current = nodeId;
    didConnect.current = false;
  }, []);

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent) => {
      const sourceId = pendingConnectSource.current;
      pendingConnectSource.current = null;

      if (!sourceId || readOnly || didConnect.current) return;
      didConnect.current = false;

      const sourceNode = nodes.find((n) => n.id === sourceId);
      if (!sourceNode) return;

      const newType = sourceId === START_NODE_ID ? "shell" : (sourceNode.type ?? "shell");
      const newId = nextNodeId(newType);
      const position = screenToFlowPosition({
        x: (event as MouseEvent).clientX,
        y: (event as MouseEvent).clientY,
      });

      const newNode: Node = { id: newId, type: newType, position, data: {} };
      setNodes((nds) => [...nds, newNode]);
      setEdges((eds) => [
        ...eds,
        {
          id: `e-${sourceId}-${newId}`,
          source: sourceId,
          target: newId,
          type: "smoothstep",
          animated: sourceId !== START_NODE_ID,
        },
      ]);
    },
    [nodes, readOnly, screenToFlowPosition, setNodes, setEdges],
  );

  // ── Prevent deleting start node ──
  const handleNodesDelete = useCallback(
    (deleted: Node[]) => {
      const filtered = deleted.filter((n) => n.id !== START_NODE_ID);
      if (filtered.length === 0) return;
      setNodes((nds) => nds.filter((n) => !filtered.some((d) => d.id === n.id)));
    },
    [setNodes],
  );

  // ── Sync YAML ──
  const syncYaml = useCallback(() => {
    const y = flowToYaml(nodes, edges, meta);
    setYamlText(y);
    return y;
  }, [nodes, edges, meta]);

  // ── Add node at position ──
  const addNode = useCallback(
    (type: string, position?: { x: number; y: number }) => {
      const id = nextNodeId(type);
      const newNode: Node = {
        id,
        type,
        position: position ?? { x: 300 + Math.random() * 200, y: 100 + Math.random() * 200 },
        data: {},
      };
      setNodes((nds) => [...nds, newNode]);
    },
    [setNodes],
  );

  // ── DnD: drag from palette ──
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      const type = event.dataTransfer.getData("application/workflow-node");
      if (!type) return;
      const position = screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      addNode(type, position);
    },
    [screenToFlowPosition, addNode],
  );

  // ── Auto layout ──
  const handleAutoLayout = useCallback(() => {
    const laid = autoLayout(nodes, edges);
    setNodes(laid);
    setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
  }, [nodes, edges, setNodes, fitView]);

  // ── New workflow ──
  const handleNew = useCallback(() => {
    setNodes([createStartNode()]);
    setEdges([]);
    setSelectedNode(null);
    setMeta({ ...defaultMeta });
    setYamlText("");
    setDryRunResult(null);
    resetNodeCounter();
  }, [setNodes, setEdges]);

  // ── Import YAML ──
  const handleImportYaml = useCallback(() => {
    if (yamlOpen) {
      const text = yamlText.trim();
      if (!text) return;
      try {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(newMeta);
        setSelectedNode(null);
        setDryRunResult(null);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      } catch (err) {
        console.error(err);
        alert(t("editor.import_yaml_failed") + ": " + (err instanceof Error ? err.message : String(err)));
      }
    } else {
      syncYaml();
      setYamlOpen(true);
    }
  }, [yamlOpen, yamlText, setNodes, setEdges, syncYaml, fitView]);

  // ── Export YAML ──
  const handleExportYaml = useCallback(() => {
    const y = syncYaml();
    const blob = new Blob([y], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${meta.name || "workflow"}.yaml`;
    a.click();
    URL.revokeObjectURL(url);
  }, [syncYaml, meta.name]);

  // ── Import from file ──
  const handleFileImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        try {
          const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
          setNodes(newNodes);
          setEdges(newEdges);
          setMeta(newMeta);
          setSelectedNode(null);
          setYamlText(text);
          setDryRunResult(null);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        } catch (err) {
          console.error(err);
          alert(t("editor.import_file_failed") + ": " + (err instanceof Error ? err.message : String(err)));
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [setNodes, setEdges, fitView],
  );

  // ── Save Draft ──
  const handleSaveDraft = useCallback(async () => {
    if (!workflowId) return;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
    } catch (err) {
      console.error(err);
      alert(t("editor.save_failed") + ": " + (err as Error).message);
      setSaveStatus("idle");
    }
  }, [syncYaml, workflowId]);

  // ── Publish ──
  const handlePublish = useCallback(async () => {
    if (!workflowId) return;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("idle");
    } catch (err) {
      console.error(err);
      alert(t("editor.save_failed") + ": " + (err as Error).message);
      setSaveStatus("idle");
      return;
    }

    setPublishing(true);
    try {
      const result = await workflowDefApi.publish(workflowId);
      alert(t("editor.published_as", { version: result.version }));
    } catch (err) {
      console.error(err);
      alert(t("editor.publish_failed") + ": " + (err as Error).message);
    } finally {
      setPublishing(false);
    }
  }, [syncYaml, workflowId]);

  // ── Cmd+S shortcut ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        handleSaveDraft();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleSaveDraft]);

  // ── Dry Run ──
  const handleDryRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);
    try {
      const result = await workflowEngineApi.dryRun(y);
      setDryRunResult(result);
    } catch (err) {
      console.error(err);
      setDryRunResult({ valid: false, issues: [{ type: "error", message: (err as Error).message }] });
    } finally {
      setRunning(false);
    }
  }, [syncYaml]);

  // ── Run mode helpers ──

  /** 将 snapshot 的节点状态同步到编辑器节点（同时注入节点操作回调） */
  const updateNodesFromSnapshot = useCallback(
    (snap: DAGSnapshot) => {
      setNodes((nds) =>
        nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const state = snap.node_states[n.id];
          if (!state)
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
          return {
            ...n,
            data: {
              ...n.data,
              _runStatus: state.status,
              _exitCode: state.exit_code,
              _onViewOutput: nodeCallbacksRef.current.onViewOutput,
              _onRerunFrom: nodeCallbacksRef.current.onRerunFrom,
            },
          };
        }),
      );
    },
    [setNodes],
  );

  // ── Refresh draft from server ──
  const handleRefreshDraft = useCallback(async () => {
    if (!workflowId) return;
    if (isRunMode && !isRunDone) return;
    try {
      const wf = await workflowDefApi.get(workflowId);
      if (wf.draftYaml) {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(wf.draftYaml);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(newMeta);
        setLastSavedYaml(wf.draftYaml);
        if (activeRunId) {
          try {
            const snap = await workflowEngineApi.getRunStatus(activeRunId);
            if (snap) updateNodesFromSnapshot(snap);
          } catch (err) {
            console.error(t("editor.restore_run_failed") + ":", err);
          }
        }
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      }
    } catch (err) {
      console.error(t("editor.refresh_failed") + ":", err);
    }
  }, [workflowId, isRunMode, isRunDone, activeRunId, setNodes, setEdges, fitView, updateNodesFromSnapshot]);

  /** 加载运行快照和事件 */
  const loadRunData = useCallback(
    async (runId: string) => {
      try {
        const [snap, evts] = await Promise.all([
          workflowEngineApi.getRunStatus(runId),
          workflowEngineApi.getEvents(runId),
        ]);
        if (snap) {
          setRunSnapshot(snap);
          updateNodesFromSnapshot(snap);
        }
        if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
      } catch (err) {
        console.error(err);
      }
    },
    [updateNodesFromSnapshot],
  );

  // 轮询运行中的工作流（setTimeout 链式，防止请求重叠导致数据闪烁）
  useEffect(() => {
    if (!activeRunId || !runSnapshot) return;
    const status = runSnapshot.dag_status;
    if (["SUCCESS", "FAILED", "CANCELLED", "ERROR"].includes(status)) return;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      await loadRunData(activeRunId);
      if (!cancelled) pollRef.current = setTimeout(poll, 2000);
    };
    pollRef.current = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [activeRunId, runSnapshot, loadRunData]);

  // SUSPENDED 时加载审批列表
  useEffect(() => {
    if (!activeRunId || !runSnapshot || runSnapshot.dag_status !== "SUSPENDED") {
      setRunApprovals([]);
      return;
    }
    workflowEngineApi
      .getPendingApprovals(activeRunId)
      .then((list) => setRunApprovals(Array.isArray(list) ? list : []))
      .catch((err) => console.error(err));
  }, [activeRunId, runSnapshot]);

  // 选中节点 → 加载输出
  useEffect(() => {
    if (!activeRunId || !selectedRunNodeId) return;
    setNodeOutputLoading(true);
    setSelectedNodeOutput(null);
    setRunRightTab("output");
    workflowEngineApi
      .getOutput(activeRunId, selectedRunNodeId)
      .then((out) => setSelectedNodeOutput(out ?? null))
      .catch((err) => console.error(err))
      .finally(() => setNodeOutputLoading(false));
  }, [activeRunId, selectedRunNodeId]);

  // ── Run workflow（自动保存再执行，结果内联显示） ──
  const handleRun = useCallback(async () => {
    const y = syncYaml();
    setRunning(true);
    setDryRunResult(null);

    if (workflowId) {
      try {
        await workflowDefApi.save(workflowId, y);
      } catch (err) {
        console.error(t("editor.auto_save_failed") + ":", err);
      }
    }

    // 所有节点标记为 RUNNING（等待 API 返回）
    setNodes((nds) =>
      nds.map((n) =>
        n.id === START_NODE_ID ? n : { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } },
      ),
    );

    try {
      const result = await workflowEngineApi.run(y, undefined, workflowId);
      setActiveRunId(result.runId);
      setRunSnapshot(null);
      setRunEvents([]);
      setRunApprovals([]);
      setSelectedRunNodeId(null);
      setSelectedNodeOutput(null);
      setRightTab("run");
      await loadRunData(result.runId);
    } finally {
      setRunning(false);
    }
  }, [syncYaml, workflowId, setNodes, loadRunData]);

  // ── Cancel run ──
  const handleCancelRun = useCallback(async () => {
    if (!activeRunId) return;
    try {
      await workflowEngineApi.cancel(activeRunId);
      await loadRunData(activeRunId);
    } catch (err) {
      console.error(err);
      alert((err as Error).message);
    }
  }, [activeRunId, loadRunData]);

  // ── Approve ──
  const handleApprove = useCallback(
    async (approval: PendingApproval) => {
      if (!activeRunId) return;
      try {
        await workflowEngineApi.approve(activeRunId, approval.nodeId, approval.approvalToken);
        await loadRunData(activeRunId);
        const list = await workflowEngineApi.getPendingApprovals(activeRunId);
        setRunApprovals(Array.isArray(list) ? list : []);
      } catch (err) {
        console.error(err);
        alert((err as Error).message);
      }
    },
    [activeRunId, loadRunData],
  );

  // ── Back to edit ──
  const handleBackToEdit = useCallback(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    setActiveRunId(null);
    setRunSnapshot(null);
    setRunEvents([]);
    setRunApprovals([]);
    setSelectedRunNodeId(null);
    setSelectedNodeOutput(null);
    setRightTab("config");
    setNodes((nds) => nds.map((n) => ({ ...n, data: { ...n.data, _runStatus: undefined, _exitCode: undefined } })));
  }, [setNodes]);

  // ── Rerun from selected node ──
  const handleRerunFrom = useCallback(
    async (fromNodeId: string) => {
      if (!activeRunId) return;
      const y = syncYaml();
      setRunning(true);
      // 目标节点及下游标记为 RUNNING（等待 API 返回）
      setNodes((nds) => {
        // BFS 找下游
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
        return nds.map((n) => {
          if (n.id === START_NODE_ID) return n;
          const isTarget = n.id === fromNodeId || downstream.has(n.id);
          if (isTarget) return { ...n, data: { ...n.data, _runStatus: "RUNNING", _exitCode: undefined } };
          return n;
        });
      });

      try {
        const result = await workflowEngineApi.rerunFrom(activeRunId, y, fromNodeId, workflowId);
        setActiveRunId(result.runId);
        setRunSnapshot(null);
        setRunEvents([]);
        setRunApprovals([]);
        setSelectedRunNodeId(null);
        setSelectedNodeOutput(null);
        setRightTab("run");
        await loadRunData(result.runId);
      } catch (err) {
        console.error(err);
        alert(t("editor.rerun_failed") + ": " + (err as Error).message);
      } finally {
        setRunning(false);
      }
    },
    [activeRunId, syncYaml, workflowId, edges, setNodes, loadRunData],
  );

  // ── View node output (from node button click) ──
  const handleViewNodeOutput = useCallback(
    async (nodeId: string) => {
      if (!activeRunId) return;
      setSelectedRunNodeId(nodeId);
      setRunRightTab("output");
      setNodeOutputLoading(true);
      setSelectedNodeOutput(null);
      // 确保运行面板打开
      setRightTab("run");
      try {
        const out = await workflowEngineApi.getOutput(activeRunId, nodeId);
        setSelectedNodeOutput(out ?? null);
      } catch (err) {
        console.error(err);
        setSelectedNodeOutput(null);
      } finally {
        setNodeOutputLoading(false);
      }
    },
    [activeRunId],
  );

  // 保持 ref 同步
  nodeCallbacksRef.current.onViewOutput = handleViewNodeOutput;
  nodeCallbacksRef.current.onRerunFrom = handleRerunFrom;

  // ── Update selected node data ──
  const updateNodeData = useCallback(
    (updates: Record<string, unknown>) => {
      if (!selectedNode) return;
      setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, data: { ...n.data, ...updates } } : n)));
      setSelectedNode((prev) => (prev ? { ...prev, data: { ...prev.data, ...updates } } : null));
    },
    [selectedNode, setNodes],
  );

  // ── Change node ID ──
  const handleIdChange = useCallback(
    (newId: string) => {
      if (!selectedNode || newId === selectedNode.id || !newId.trim()) return;
      if (newId === START_NODE_ID) return;
      if (nodes.some((n) => n.id === newId)) {
        alert(t("editor.node_id_exists"));
        return;
      }
      const oldId = selectedNode.id;
      const newNode: Node = { ...selectedNode, id: newId };
      const newEdges = edges.map((e) => ({
        ...e,
        source: e.source === oldId ? newId : e.source,
        target: e.target === oldId ? newId : e.target,
        id:
          e.source === oldId || e.target === oldId
            ? `e-${e.source === oldId ? newId : e.source}-${e.target === oldId ? newId : e.target}`
            : e.id,
      }));
      setNodes((nds) => [...nds.filter((n) => n.id !== oldId), newNode]);
      setEdges(newEdges);
      setSelectedNode(newNode);
    },
    [selectedNode, nodes, edges, setNodes, setEdges],
  );

  // ── Update meta ──
  const updateMeta = useCallback((updates: Partial<WfMeta>) => {
    setMeta((prev) => ({ ...prev, ...updates }));
  }, []);

  const sd = selectedNode?.data as Record<string, unknown> | undefined;
  const nodeType = selectedNode?.type ?? "shell";
  const isStartNode = selectedNode?.id === START_NODE_ID;

  return (
    <div className="wf-editor-container">
      <input
        ref={fileInputRef}
        type="file"
        accept=".yaml,.yml"
        onChange={handleFileImport}
        style={{ display: "none" }}
      />

      {readOnly && (
        <div className="wf-readonly-badge">
          <Lock size={12} /> {t("editor.readonly_mode")}
        </div>
      )}

      <div className="wf-canvas-wrapper">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={readOnly ? undefined : onNodesChange}
          onEdgesChange={readOnly ? undefined : onEdgesChange}
          onNodesDelete={handleNodesDelete}
          onSelectionChange={onSelectionChange}
          onConnect={readOnly ? undefined : onConnect}
          onConnectStart={readOnly ? undefined : onConnectStart}
          onConnectEnd={readOnly ? undefined : onConnectEnd}
          onDragOver={onDragOver}
          onDrop={onDrop}
          nodeTypes={nodeTypes}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={readOnly ? null : "Delete"}
          fitView
          fitViewOptions={{ padding: 0.15 }}
          defaultEdgeOptions={{ type: "smoothstep", animated: true }}
          minZoom={0.2}
          maxZoom={2}
          proOptions={{ hideAttribution: true }}
          className={readOnly ? "wf-canvas-readonly" : ""}
        >
          <Controls position="bottom-left" showInteractive={!readOnly} />
          <MiniMap
            position="bottom-right"
            nodeColor={(n) => {
              const colorMap: Record<string, string> = {
                start: "#6366f1",
                agent: "#22c55e",
                api: "#8b5cf6",
                audit: "#f59e0b",
                workflow: "#ec4899",
                loop: "#06b6d4",
              };
              return colorMap[n.type ?? ""] ?? "#3b82f6";
            }}
            maskColor="rgba(0,0,0,0.08)"
            style={{ borderRadius: 8 }}
          />
          <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="#d1d5db" />

          {/* 节点面板 */}
          {!readOnly && (
            <Panel position="top-left" className="wf-panel-palette">
              <div className="wf-palette">
                <div className="wf-palette-title">{t("editor.palette_drag_hint")}</div>
                {PALETTE_ITEMS.map(({ type, labelKey, icon: Icon, color }) => (
                  <button
                    key={type}
                    type="button"
                    className="wf-palette-btn"
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.setData("application/workflow-node", type);
                      e.dataTransfer.effectAllowed = "move";
                    }}
                    onClick={() => addNode(type)}
                  >
                    <span className="wf-palette-icon" style={{ background: color }}>
                      <Icon size={14} />
                    </span>
                    {t(labelKey)}
                  </button>
                ))}
              </div>
            </Panel>
          )}

          {/* 工具栏 */}
          <Panel position="top-center" className="wf-panel-toolbar">
            <div className="wf-toolbar">
              {!readOnly && (
                <button
                  type="button"
                  className="wf-toolbar-btn"
                  onClick={handleNew}
                  data-tooltip={t("editor.tooltip_new")}
                >
                  <FilePlus size={15} />
                </button>
              )}
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={() => fileInputRef.current?.click()}
                data-tooltip={t("editor.tooltip_import")}
              >
                <Upload size={15} />
              </button>
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleExportYaml}
                data-tooltip={t("editor.tooltip_export")}
              >
                <Download size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleAutoLayout}
                data-tooltip={t("editor.tooltip_layout")}
              >
                <LayoutGrid size={15} />
              </button>
              {workflowId && (
                <button
                  type="button"
                  className="wf-toolbar-btn"
                  onClick={handleRefreshDraft}
                  disabled={isRunMode && !isRunDone}
                  data-tooltip={t("editor.tooltip_refresh")}
                >
                  <RefreshCw size={15} />
                </button>
              )}
              {workflowId && (
                <>
                  <div className="wf-toolbar-divider" />
                  <button
                    type="button"
                    className="wf-toolbar-btn"
                    onClick={handleSaveDraft}
                    disabled={saveStatus === "saving"}
                    data-tooltip={t("editor.tooltip_save")}
                  >
                    <Save size={15} />
                  </button>
                  <button
                    type="button"
                    className={`wf-toolbar-btn ${rightTab === "versions" ? "active" : ""}`}
                    onClick={() => setRightTab(rightTab === "versions" ? "config" : "versions")}
                    data-tooltip={t("editor.tooltip_versions")}
                  >
                    <Rocket size={15} />
                  </button>
                </>
              )}
              <button
                type="button"
                className={`wf-toolbar-btn ${yamlOpen ? "active" : ""}`}
                onClick={() => {
                  if (!yamlOpen) syncYaml();
                  setYamlOpen(!yamlOpen);
                }}
                data-tooltip={t("editor.tooltip_yaml")}
              >
                <Code size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleDryRun}
                disabled={running}
                data-tooltip={t("editor.tooltip_validate")}
              >
                <CheckCircle size={15} />
              </button>
              <button
                type="button"
                className="wf-toolbar-btn"
                onClick={handleRun}
                disabled={running}
                data-tooltip={t("editor.tooltip_run")}
                style={running ? { opacity: 0.5 } : undefined}
              >
                <Play size={15} />
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className={`wf-toolbar-btn ${readOnly ? "active" : ""}`}
                onClick={() => setReadOnly(!readOnly)}
                data-tooltip={readOnly ? t("editor.tooltip_readonly_off") : t("editor.tooltip_readonly_on")}
              >
                {readOnly ? <Eye size={15} /> : <Edit3 size={15} />}
              </button>
              <div className="wf-toolbar-divider" />
              <button
                type="button"
                className={`wf-toolbar-btn ${chatOpen ? "active" : ""}`}
                onClick={() => setChatOpen(!chatOpen)}
                data-tooltip={t("editor.tooltip_chat")}
              >
                <MessageSquare size={15} />
              </button>
              <button
                type="button"
                className={`wf-toolbar-btn ${rightTab === "run" ? "active" : ""}`}
                onClick={() => setRightTab(rightTab === "run" ? "config" : "run")}
                data-tooltip={t("editor.tooltip_run_history")}
              >
                <List size={15} />
              </button>
            </div>
          </Panel>
        </ReactFlow>

        {/* 保存状态指示器 */}
        {saveStatus === "saving" && (
          <div
            style={{
              position: "absolute",
              top: 52,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#eff6ff",
              border: "1px solid #93c5fd",
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 11,
              color: "#1d4ed8",
              zIndex: 10,
            }}
          >
            {t("editor.saving")}
          </div>
        )}
        {saveStatus === "saved" && (
          <div
            style={{
              position: "absolute",
              top: 52,
              left: "50%",
              transform: "translateX(-50%)",
              background: "#f0fdf4",
              border: "1px solid #86efac",
              borderRadius: 8,
              padding: "6px 12px",
              fontSize: 11,
              color: "#166534",
              zIndex: 10,
            }}
          >
            {t("editor.saved")}
          </div>
        )}

        {/* DryRun 结果提示 */}
        {dryRunResult && (
          <div
            style={{
              position: "absolute",
              top: 52,
              left: "50%",
              transform: "translateX(-50%)",
              zIndex: 10,
              background: dryRunResult.valid ? "#f0fdf4" : "#fef2f2",
              border: `1px solid ${dryRunResult.valid ? "#86efac" : "#fca5a5"}`,
              borderRadius: 8,
              padding: "8px 14px",
              fontSize: 12,
              color: dryRunResult.valid ? "#166534" : "#991b1b",
              maxWidth: 480,
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                fontWeight: 600,
                marginBottom: dryRunResult.issues.length ? 4 : 0,
              }}
            >
              {dryRunResult.valid ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}
              {dryRunResult.valid
                ? t("editor.validate_pass")
                : t("editor.validate_fail", { count: dryRunResult.issues.length })}
              <button
                type="button"
                onClick={() => setDryRunResult(null)}
                style={{
                  marginLeft: "auto",
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  color: "inherit",
                }}
              >
                <X size={12} />
              </button>
            </div>
            {dryRunResult.issues.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {dryRunResult.issues.map((issue, i) => (
                  <li key={i}>
                    {issue.type === "error" ? "❌" : "⚠️"} {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* YAML 滑出面板 */}
        <div className={`wf-yaml-slide ${yamlOpen ? "open" : ""}`}>
          <div className="wf-yaml-slide-header">
            <span className="wf-yaml-slide-title">{t("editor.yaml_title")}</span>
            <div style={{ display: "flex", gap: 4 }}>
              {!readOnly && (
                <button
                  type="button"
                  className="wf-toolbar-btn"
                  onClick={handleImportYaml}
                  data-tooltip={t("editor.yaml_tooltip_apply")}
                >
                  <Upload size={14} />
                </button>
              )}
              <button type="button" className="wf-toolbar-btn" onClick={() => setYamlOpen(false)}>
                <X size={14} />
              </button>
            </div>
          </div>
          <textarea
            className="wf-yaml-textarea"
            value={yamlText}
            onChange={(e) => setYamlText(e.target.value)}
            spellCheck={false}
            placeholder={t("editor.yaml_placeholder")}
            readOnly={readOnly}
          />
        </div>
      </div>

      {/* 右侧统一面板（配置 / 运行 / 版本 tabs） */}
      <aside className="wf-prop-panel" style={{ width: 300, minWidth: 300 }}>
        {/* Tab 头 */}
        <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb" }}>
          {[
            { key: "config" as const, label: t("editor.tab_config") },
            { key: "run" as const, label: t("editor.tab_run") },
            { key: "versions" as const, label: t("editor.tab_versions") },
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setRightTab(tab.key)}
              style={{
                flex: 1,
                padding: "8px 0",
                border: "none",
                background: "none",
                fontSize: 11,
                fontWeight: rightTab === tab.key ? 600 : 400,
                color: rightTab === tab.key ? "#111827" : "#9ca3af",
                borderBottom: rightTab === tab.key ? "2px solid #3b82f6" : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* ── 配置 Tab ── */}
        {rightTab === "config" && (
          <div className="wf-prop-body">
            {readOnly && (
              <div
                style={{
                  padding: "4px 12px",
                  background: "#fefce8",
                  borderBottom: "1px solid #fde68a",
                  fontSize: 10,
                  color: "#92400e",
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                }}
              >
                <Lock size={10} /> {t("editor.readonly")}
              </div>
            )}
            {/* 开始节点 */}
            {isStartNode ? (
              <div className="wf-prop-section">
                <div className="wf-prop-section-title">{t("editor.start_node_title")}</div>
                <div className="wf-prop-hint">
                  <p>{t("editor.start_node_hint_1")}</p>
                  <p>{t("editor.start_node_hint_2")}</p>
                </div>
              </div>
            ) : selectedNode ? (
              <>
                {/* 节点基本信息 */}
                <div className="wf-prop-section">
                  <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
                  <div className="wf-prop-field">
                    <label>{t("editor.node_id")}</label>
                    <input
                      value={selectedNode.id}
                      onChange={(e) => handleIdChange(e.target.value)}
                      readOnly={readOnly}
                    />
                  </div>
                  <div className="wf-prop-field">
                    <label>{t("editor.type")}</label>
                    <select
                      value={nodeType}
                      onChange={(e) => {
                        const newType = e.target.value;
                        setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, type: newType } : n)));
                        setSelectedNode((prev) => (prev ? { ...prev, type: newType } : null));
                      }}
                      disabled={readOnly}
                    >
                      <option value="shell">Shell</option>
                      <option value="python">Python</option>
                      <option value="agent">Agent</option>
                      <option value="api">API</option>
                      <option value="audit">{t("editor.type_audit")}</option>
                      <option value="workflow">{t("editor.type_workflow")}</option>
                      <option value="loop">{t("editor.type_loop")}</option>
                    </select>
                  </div>
                  <div className="wf-prop-field">
                    <label>{t("editor.description")}</label>
                    <input
                      value={String(sd?.description ?? "")}
                      onChange={(e) => updateNodeData({ description: e.target.value || undefined })}
                      placeholder={t("editor.description_placeholder")}
                      readOnly={readOnly}
                    />
                  </div>
                </div>

                {/* 节点配置（按类型） */}
                <div className="wf-prop-section">
                  <div className="wf-prop-section-title">{t("editor.config")}</div>

                  {nodeType === "shell" && (
                    <>
                      <div className="wf-prop-field">
                        <label>{t("editor.shell_command")}</label>
                        <textarea
                          value={String(sd?.command ?? "")}
                          onChange={(e) => updateNodeData({ command: e.target.value })}
                          placeholder='echo "Hello ${{ params.name }}"'
                          rows={3}
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.shell_env")}</label>
                        <textarea
                          value={String(sd?.env ?? "")}
                          onChange={(e) => updateNodeData({ env: e.target.value })}
                          placeholder={t("editor.shell_env_placeholder")}
                          rows={2}
                          readOnly={readOnly}
                        />
                      </div>
                    </>
                  )}

                  {nodeType === "python" && (
                    <>
                      <div className="wf-prop-field">
                        <label>{t("editor.python_code")}</label>
                        <textarea
                          value={String(sd?.code ?? "")}
                          onChange={(e) => updateNodeData({ code: e.target.value })}
                          placeholder={'import json\nprint(json.dumps({"result": "hello"}))'}
                          rows={6}
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.python_requirements")}</label>
                        <textarea
                          value={
                            Array.isArray(sd?.requirements)
                              ? (sd.requirements as string[]).join("\n")
                              : String(sd?.requirements ?? "")
                          }
                          onChange={(e) =>
                            updateNodeData({
                              requirements: e.target.value
                                ? e.target.value
                                    .split("\n")
                                    .map((s: string) => s.trim())
                                    .filter(Boolean)
                                : undefined,
                            })
                          }
                          placeholder={t("editor.python_requirements_placeholder")}
                          rows={2}
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.shell_env")}</label>
                        <textarea
                          value={String(sd?.env ?? "")}
                          onChange={(e) => updateNodeData({ env: e.target.value })}
                          placeholder={t("editor.shell_env_placeholder")}
                          rows={2}
                          readOnly={readOnly}
                        />
                      </div>
                    </>
                  )}

                  {nodeType === "agent" && (
                    <>
                      <div className="wf-prop-field">
                        <label>{t("editor.agent_prompt")}</label>
                        <textarea
                          value={String(sd?.prompt ?? "")}
                          onChange={(e) => updateNodeData({ prompt: e.target.value })}
                          placeholder={t("editor.agent_prompt_placeholder")}
                          rows={4}
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.agent_name")}</label>
                        <select
                          value={String(sd?.agent ?? "")}
                          onChange={(e) => updateNodeData({ agent: e.target.value })}
                          disabled={readOnly}
                        >
                          <option value="">{t("editor.agent_default")}</option>
                          {agentList.map((a) => (
                            <option key={a.name} value={a.name}>
                              {a.name}
                            </option>
                          ))}
                        </select>
                        {sd?.agent &&
                          (() => {
                            const found = agentList.find((a) => a.name === sd.agent);
                            if (!found) return null;
                            return (
                              <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                                {found.model && (
                                  <span>
                                    {t("editor.agent_model")}: {found.model}
                                  </span>
                                )}
                                {found.model && found.description && <span> · </span>}
                                {found.description && <span>{found.description}</span>}
                              </div>
                            );
                          })()}
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.agent_skill")}</label>
                        <input
                          value={String(sd?.skill ?? "")}
                          onChange={(e) => updateNodeData({ skill: e.target.value })}
                          placeholder="skill-name"
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <button
                          type="button"
                          onClick={() => setAgentOverrideOpen(!agentOverrideOpen)}
                          style={{
                            background: "none",
                            border: "none",
                            cursor: "pointer",
                            fontSize: 11,
                            color: "#6b7280",
                            padding: 0,
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <ChevronRight
                            size={11}
                            style={{
                              transform: agentOverrideOpen ? "rotate(90deg)" : "rotate(0deg)",
                              transition: "transform 0.15s",
                            }}
                          />
                          {t("editor.agent_override")}
                        </button>
                        {agentOverrideOpen && (
                          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 6 }}>
                            <div>
                              <label style={{ fontSize: 10, color: "#9ca3af" }}>{t("editor.agent_model_label")}</label>
                              <input
                                value={String(sd?.model ?? "")}
                                onChange={(e) => updateNodeData({ model: e.target.value || undefined })}
                                placeholder={t("editor.agent_fallback_hint")}
                                readOnly={readOnly}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 10, color: "#9ca3af" }}>{t("editor.agent_temperature")}</label>
                              <input
                                type="number"
                                step="0.1"
                                min="0"
                                max="2"
                                value={sd?.temperature ?? ""}
                                onChange={(e) =>
                                  updateNodeData({
                                    temperature: e.target.value ? Number(e.target.value) : undefined,
                                  })
                                }
                                placeholder={t("editor.agent_fallback_hint")}
                                readOnly={readOnly}
                              />
                            </div>
                            <div>
                              <label style={{ fontSize: 10, color: "#9ca3af" }}>{t("editor.agent_max_steps")}</label>
                              <input
                                type="number"
                                min="1"
                                max="200"
                                value={sd?.steps ?? ""}
                                onChange={(e) =>
                                  updateNodeData({
                                    steps: e.target.value ? Number(e.target.value) : undefined,
                                  })
                                }
                                placeholder={t("editor.agent_fallback_hint")}
                                readOnly={readOnly}
                              />
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  )}

                  {nodeType === "api" && (
                    <>
                      <div className="wf-prop-field">
                        <label>URL</label>
                        <input
                          value={String(sd?.url ?? "")}
                          onChange={(e) => updateNodeData({ url: e.target.value })}
                          placeholder="https://api.example.com/data"
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.api_method")}</label>
                        <select
                          value={String(sd?.method ?? "GET")}
                          onChange={(e) => updateNodeData({ method: e.target.value })}
                          disabled={readOnly}
                        >
                          <option value="GET">GET</option>
                          <option value="POST">POST</option>
                          <option value="PUT">PUT</option>
                          <option value="PATCH">PATCH</option>
                          <option value="DELETE">DELETE</option>
                        </select>
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.api_headers")}</label>
                        <textarea
                          value={String(sd?.headers ?? "")}
                          onChange={(e) => updateNodeData({ headers: e.target.value })}
                          placeholder='{"Authorization": "Bearer ${{ secrets.KEY }}"}'
                          rows={2}
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.api_body")}</label>
                        <textarea
                          value={String(sd?.body ?? "")}
                          onChange={(e) => updateNodeData({ body: e.target.value })}
                          placeholder='{"key": "value"}'
                          rows={2}
                          readOnly={readOnly}
                        />
                      </div>
                    </>
                  )}

                  {nodeType === "audit" && (
                    <>
                      <div className="wf-prop-field">
                        <label>{t("editor.audit_message")}</label>
                        <input
                          value={String(
                            (typeof sd?.display_data === "object" && sd?.display_data !== null
                              ? (sd.display_data as Record<string, string>).message
                              : sd?.display_data) ?? "",
                          )}
                          onChange={(e) => updateNodeData({ display_data: { message: e.target.value } })}
                          placeholder={t("editor.audit_message_placeholder")}
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.audit_expires")}</label>
                        <input
                          type="number"
                          value={sd?.expires_in != null ? String(sd.expires_in) : ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            updateNodeData({ expires_in: v ? Number(v) : undefined });
                          }}
                          placeholder="86400"
                          readOnly={readOnly}
                        />
                      </div>
                    </>
                  )}

                  {nodeType === "workflow" && (
                    <div className="wf-prop-field">
                      <label>{t("editor.workflow_ref")}</label>
                      <input
                        value={String(sd?.ref ?? "")}
                        onChange={(e) => updateNodeData({ ref: e.target.value })}
                        placeholder="./sub-workflow.yaml"
                        readOnly={readOnly}
                      />
                    </div>
                  )}

                  {nodeType === "loop" && (
                    <>
                      <div className="wf-prop-field">
                        <label>{t("editor.loop_condition")}</label>
                        <input
                          value={String(sd?.condition ?? "")}
                          onChange={(e) => updateNodeData({ condition: e.target.value })}
                          placeholder="{{ counter < 10 }}"
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-field">
                        <label>{t("editor.loop_max_iterations")}</label>
                        <input
                          type="number"
                          value={sd?.max_iterations != null ? String(sd.max_iterations) : ""}
                          onChange={(e) => {
                            const v = e.target.value;
                            updateNodeData({ max_iterations: v ? Number(v) : undefined });
                          }}
                          placeholder="10"
                          readOnly={readOnly}
                        />
                      </div>
                      <div className="wf-prop-hint" style={{ marginTop: 4 }}>
                        <p>{t("editor.loop_body_hint")}</p>
                      </div>
                    </>
                  )}
                </div>

                {/* 高级配置 */}
                <div className="wf-prop-section">
                  <div className="wf-prop-section-title">{t("editor.advanced")}</div>
                  <div className="wf-prop-field">
                    <label>{t("editor.timeout_seconds")}</label>
                    <input
                      type="number"
                      value={sd?.timeout != null ? String(sd.timeout) : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateNodeData({ timeout: v ? Number(v) : undefined });
                      }}
                      placeholder="300"
                      readOnly={readOnly}
                    />
                  </div>
                  <div className="wf-prop-field">
                    <label>{t("editor.retry_count")}</label>
                    <input
                      type="number"
                      value={sd?.retry != null ? String(sd.retry) : ""}
                      onChange={(e) => {
                        const v = e.target.value;
                        updateNodeData({ retry: v ? Number(v) : undefined });
                      }}
                      placeholder="0"
                      readOnly={readOnly}
                    />
                  </div>
                </div>
              </>
            ) : (
              <>
                {/* 工作流元数据 */}
                <div className="wf-prop-section">
                  <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
                  <div className="wf-prop-field">
                    <label>{t("editor.schema_version")}</label>
                    <input value={meta.schema_version} readOnly />
                  </div>
                  <div className="wf-prop-field">
                    <label>{t("editor.name")}</label>
                    <input
                      value={meta.name}
                      onChange={(e) => updateMeta({ name: e.target.value })}
                      readOnly={readOnly}
                    />
                  </div>
                  <div className="wf-prop-field">
                    <label>{t("editor.meta_description")}</label>
                    <textarea
                      value={meta.description}
                      onChange={(e) => updateMeta({ description: e.target.value })}
                      placeholder={t("editor.meta_desc_placeholder")}
                      rows={2}
                      readOnly={readOnly}
                    />
                  </div>
                  <div className="wf-prop-field">
                    <label>{t("editor.timeout_seconds")}</label>
                    <input
                      type="number"
                      value={meta.timeout}
                      onChange={(e) => updateMeta({ timeout: e.target.value ? Number(e.target.value) : 300 })}
                      placeholder="300"
                      readOnly={readOnly}
                    />
                  </div>
                </div>

                <div className="wf-prop-section">
                  <div className="wf-prop-section-title">{t("editor.params")}</div>
                  <div className="wf-prop-field">
                    <label>{t("editor.params_json")}</label>
                    <textarea
                      value={Object.keys(meta.params).length ? JSON.stringify(meta.params, null, 2) : ""}
                      onChange={(e) => {
                        try {
                          const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                          updateMeta({ params: parsed });
                        } catch {
                          // 用户还在编辑，暂不更新
                        }
                      }}
                      placeholder='{"name": {"type": "string", "default": "World"}}'
                      rows={3}
                      readOnly={readOnly}
                    />
                  </div>
                </div>

                <div className="wf-prop-section">
                  <div className="wf-prop-section-title">{t("editor.secrets")}</div>
                  <div className="wf-prop-field">
                    <label>{t("editor.secrets_env_names")}</label>
                    <textarea
                      value={meta.secrets.join("\n")}
                      onChange={(e) =>
                        updateMeta({
                          secrets: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                      placeholder="API_KEY&#10;DATABASE_URL"
                      rows={2}
                      readOnly={readOnly}
                    />
                  </div>
                </div>

                <div className="wf-prop-hint">
                  <p>{t("editor.hint_click_node")}</p>
                  {!readOnly && (
                    <>
                      <p>{t("editor.hint_drag_add")}</p>
                      <p>{t("editor.hint_connect")}</p>
                      <p>{t("editor.hint_delete")}</p>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* ── 运行 Tab ── */}
        {rightTab === "run" && (
          <>
            {isRunMode ? (
              <>
                {/* 运行状态头 */}
                <div
                  style={{
                    padding: "8px 12px",
                    borderBottom: "1px solid #e5e7eb",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  <span style={{ fontSize: 12, fontWeight: 600, color: "#111827" }}>{t("editor.run_result")}</span>
                  {runSnapshot && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "1px 7px",
                        borderRadius: 99,
                        fontSize: 10,
                        fontWeight: 500,
                        color: DAG_STATUS_CFG[dagStatus!]?.color ?? "#6b7280",
                        background: DAG_STATUS_CFG[dagStatus!]?.bg ?? "#f3f4f6",
                      }}
                    >
                      {dagStatus === "RUNNING" && (
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: "50%",
                            background: "#3b82f6",
                            animation: "wf-pulse 1.5s ease-in-out infinite",
                          }}
                        />
                      )}
                      {DAG_STATUS_CFG[dagStatus!] ? t(DAG_STATUS_CFG[dagStatus!].labelKey) : dagStatus}
                    </span>
                  )}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
                    {!isRunDone && (
                      <button
                        type="button"
                        onClick={handleCancelRun}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 24,
                          height: 24,
                          border: "none",
                          background: "#fef2f2",
                          borderRadius: 4,
                          color: "#ef4444",
                          cursor: "pointer",
                        }}
                      >
                        <Square size={11} />
                      </button>
                    )}
                    {isRunDone && (
                      <button
                        type="button"
                        onClick={handleBackToEdit}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: 24,
                          height: 24,
                          border: "none",
                          background: "#f3f4f6",
                          borderRadius: 4,
                          color: "#6b7280",
                          cursor: "pointer",
                        }}
                      >
                        <Edit3 size={11} />
                      </button>
                    )}
                  </div>
                </div>

                {/* 审批卡片 */}
                {dagStatus === "SUSPENDED" && runApprovals.length > 0 && (
                  <div style={{ padding: 10, borderBottom: "1px solid #fbbf24", background: "#fffbeb" }}>
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: "#92400e",
                        marginBottom: 6,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                      }}
                    >
                      <ShieldCheck size={12} /> {t("editor.waiting_approval")}
                    </div>
                    {runApprovals.map((a) => (
                      <div key={a.nodeId} style={{ fontSize: 10, color: "#78350f", marginBottom: 6 }}>
                        <div style={{ fontWeight: 500, marginBottom: 2 }}>
                          {t("editor.approval_node", { nodeId: a.nodeId })}
                        </div>
                        {a.displayData && typeof a.displayData === "object" && (
                          <div style={{ color: "#92400e", marginBottom: 3 }}>
                            {(a.displayData as Record<string, string>).message ?? ""}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => handleApprove(a)}
                          style={{
                            padding: "2px 8px",
                            border: "1px solid #f59e0b",
                            borderRadius: 4,
                            background: "#f59e0b",
                            color: "#fff",
                            fontSize: 10,
                            fontWeight: 500,
                            cursor: "pointer",
                          }}
                        >
                          {t("editor.approve")}
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* 进度条 */}
                {runSnapshot && (
                  <div
                    style={{
                      padding: "4px 12px",
                      borderBottom: "1px solid #f3f4f6",
                      fontSize: 10,
                      color: "#9ca3af",
                      display: "flex",
                      justifyContent: "space-between",
                    }}
                  >
                    <span>
                      {t("editor.progress_nodes", {
                        completed: Object.values(runSnapshot.node_states).filter((s) => s.status === "COMPLETED")
                          .length,
                        total: Object.keys(runSnapshot.node_states).length,
                      })}
                    </span>
                    <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 9 }}>
                      {activeRunId?.substring(0, 16)}...
                    </span>
                  </div>
                )}

                {/* 事件/输出子 Tab */}
                <div style={{ display: "flex", borderBottom: "1px solid #e5e7eb" }}>
                  <button
                    type="button"
                    onClick={() => setRunRightTab("events")}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      border: "none",
                      background: "none",
                      fontSize: 11,
                      fontWeight: runRightTab === "events" ? 600 : 400,
                      color: runRightTab === "events" ? "#111827" : "#9ca3af",
                      borderBottom: runRightTab === "events" ? "2px solid #3b82f6" : "2px solid transparent",
                      cursor: "pointer",
                    }}
                  >
                    {t("editor.events_tab", {
                      count: selectedRunNodeId
                        ? runEvents.filter((e) => e.node_id === selectedRunNodeId).length
                        : runEvents.length,
                    })}
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunRightTab("output")}
                    style={{
                      flex: 1,
                      padding: "7px 0",
                      border: "none",
                      background: "none",
                      fontSize: 11,
                      fontWeight: runRightTab === "output" ? 600 : 400,
                      color: runRightTab === "output" ? "#111827" : "#9ca3af",
                      borderBottom: runRightTab === "output" ? "2px solid #3b82f6" : "2px solid transparent",
                      cursor: "pointer",
                    }}
                  >
                    {selectedRunNodeId
                      ? t("editor.output_tab_selected", { nodeId: selectedRunNodeId })
                      : t("editor.output_tab")}
                  </button>
                </div>

                {/* 事件列表 */}
                {runRightTab === "events" && (
                  <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
                    {(() => {
                      const filtered = selectedRunNodeId
                        ? runEvents.filter((e) => e.node_id === selectedRunNodeId)
                        : runEvents;
                      return filtered.length === 0 ? (
                        <div style={{ padding: 20, textAlign: "center", color: "#d1d5db" }}>
                          {selectedRunNodeId ? t("editor.no_events_for_node") : t("editor.no_events")}
                        </div>
                      ) : (
                        filtered.map((evt) => (
                          <div
                            key={evt.event_id}
                            style={{
                              padding: "5px 12px",
                              borderBottom: "1px solid #f3f4f6",
                              display: "flex",
                              gap: 5,
                              alignItems: "flex-start",
                              cursor: evt.node_id ? "pointer" : "default",
                            }}
                            onClick={() => {
                              if (evt.node_id) setSelectedRunNodeId(evt.node_id);
                            }}
                          >
                            <EventIcon type={evt.type} />
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 1 }}>
                                <span style={{ fontWeight: 500, color: "#374151" }}>
                                  {formatEventType(t, evt.type)}
                                </span>
                                <span style={{ color: "#d1d5db", fontSize: 9, flexShrink: 0 }}>
                                  {new Date(evt.timestamp).toLocaleTimeString("zh-CN", {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                    second: "2-digit",
                                  })}
                                </span>
                              </div>
                              {evt.node_id && (
                                <span style={{ color: "#9ca3af", fontFamily: "ui-monospace, monospace", fontSize: 9 }}>
                                  {evt.node_id}
                                </span>
                              )}
                              {evt.metadata && Object.keys(evt.metadata).length > 0 && (
                                <div
                                  style={{
                                    color: "#9ca3af",
                                    fontSize: 9,
                                    marginTop: 1,
                                    fontFamily: "ui-monospace, monospace",
                                  }}
                                >
                                  {formatMeta(t, evt.type, evt.metadata)}
                                </div>
                              )}
                            </div>
                          </div>
                        ))
                      );
                    })()}
                  </div>
                )}

                {/* 节点输出 */}
                {runRightTab === "output" && (
                  <div style={{ flex: 1, overflowY: "auto", fontSize: 11 }}>
                    {!selectedRunNodeId ? (
                      <div style={{ padding: 20, textAlign: "center", color: "#d1d5db" }}>
                        {t("editor.click_node_output")}
                      </div>
                    ) : nodeOutputLoading ? (
                      <div style={{ padding: 20, textAlign: "center", color: "#9ca3af" }}>
                        <Loader
                          size={14}
                          style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }}
                        />
                      </div>
                    ) : !selectedNodeOutput ? (
                      <div style={{ padding: 20, textAlign: "center", color: "#d1d5db" }}>{t("editor.no_output")}</div>
                    ) : (
                      <>
                        <div
                          style={{
                            padding: "6px 12px",
                            borderBottom: "1px solid #f3f4f6",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 6,
                          }}
                        >
                          <span style={{ fontSize: 10, color: "#6b7280", fontFamily: "ui-monospace, monospace" }}>
                            {selectedRunNodeId}
                          </span>
                          <button
                            type="button"
                            onClick={() => handleRerunFrom(selectedRunNodeId)}
                            disabled={running}
                            style={{
                              display: "flex",
                              alignItems: "center",
                              gap: 3,
                              padding: "2px 8px",
                              border: "1px solid #3b82f6",
                              borderRadius: 4,
                              background: "#eff6ff",
                              color: "#3b82f6",
                              fontSize: 10,
                              fontWeight: 500,
                              cursor: running ? "not-allowed" : "pointer",
                              opacity: running ? 0.5 : 1,
                            }}
                          >
                            <RefreshCw size={10} /> {t("editor.rerun_from_here")}
                          </button>
                        </div>
                        <NodeOutputView output={selectedNodeOutput} />
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              /* 历史运行列表 */
              <RunListPanel
                onSelect={async (runId) => {
                  setActiveRunId(runId);
                  setRunSnapshot(null);
                  setRunEvents([]);
                  setRunApprovals([]);
                  setSelectedRunNodeId(null);
                  setSelectedNodeOutput(null);
                  try {
                    const [snap, evts] = await Promise.all([
                      workflowEngineApi.getRunStatus(runId),
                      workflowEngineApi.getEvents(runId),
                    ]);
                    if (snap) {
                      setRunSnapshot(snap);
                      updateNodesFromSnapshot(snap);
                    }
                    if (Array.isArray(evts)) setRunEvents(dedupEvents(evts));
                  } catch (err) {
                    console.error(t("editor.load_run_data_failed") + ":", err);
                  }
                }}
                onClose={() => setRightTab("config")}
              />
            )}
          </>
        )}

        {/* ── 版本 Tab ── */}
        {rightTab === "versions" && (
          <VersionPanel
            workflowId={workflowId}
            onClose={() => setRightTab("config")}
            onPublish={handlePublish}
            publishing={publishing}
          />
        )}
      </aside>

      {/* Meta Agent Chat 侧边栏 */}
      {chatOpen && (
        <div
          style={{
            width: 400,
            minWidth: 400,
            display: "flex",
            flexDirection: "column",
            background: "#fff",
            borderLeft: "1px solid #e5e7eb",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 12px",
              borderBottom: "1px solid #e5e7eb",
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 600, display: "flex", alignItems: "center", gap: 6 }}>
              <Bot size={14} />
              Meta Agent
            </span>
            <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
              <button
                type="button"
                style={{
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: 4,
                  borderRadius: 4,
                  color: "#6b7280",
                  display: "flex",
                  alignItems: "center",
                }}
                onClick={() => setChatOpen(false)}
                title={t("editor.chat_collapse")}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          </div>
          <div style={{ flex: 1, overflow: "hidden" }}>
            <ChatPanel agentId={metaAgentId} hideSidebar scenePrompt={scenePrompt} />
          </div>
        </div>
      )}
    </div>
  );
}

// ── 事件去重 ──
function dedupEvents(events: DAGEvent[]): DAGEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (seen.has(e.event_id)) return false;
    seen.add(e.event_id);
    return true;
  });
}

// ── 版本管理面板 ──

function VersionPanel({
  workflowId,
  onClose,
  onPublish,
  publishing,
}: {
  workflowId?: string;
  onClose: () => void;
  onPublish: () => Promise<void>;
  publishing: boolean;
}) {
  const [wf, setWf] = useState<import("../../api/workflow-defs").WorkflowDefItem | null>(null);
  const [versions, setVersions] = useState<import("../../api/workflow-defs").WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);
  const [publishingLocal, setPublishingLocal] = useState(false);

  const loadData = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const [wfData, versionList] = await Promise.all([
        workflowDefApi.get(workflowId),
        workflowDefApi.getVersions(workflowId),
      ]);
      setWf(wfData);
      setVersions(Array.isArray(versionList) ? versionList : []);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handlePublishClick = useCallback(async () => {
    setPublishingLocal(true);
    try {
      await onPublish();
      loadData();
    } catch (err) {
      console.error(err);
    } finally {
      setPublishingLocal(false);
    }
  }, [onPublish, loadData]);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        await workflowDefApi.setLatest(workflowId, version);
        loadData();
      } catch (err) {
        console.error(err);
        alert(t("versions.operation_failed") + ": " + (err as Error).message);
      }
    },
    [workflowId, loadData],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        alert(t("versions.restore_success"));
      } catch (err) {
        console.error(err);
        alert(t("versions.restore_failed") + ": " + (err as Error).message);
      }
    },
    [workflowId],
  );

  const handleViewYaml = useCallback(
    async (version: number) => {
      if (!workflowId) return;
      if (viewingVersion === version) {
        setViewingVersion(null);
        setViewingYaml(null);
        return;
      }
      try {
        const result = await workflowDefApi.getVersion(workflowId, version);
        setViewingVersion(version);
        setViewingYaml(result.yaml);
      } catch (err) {
        console.error(err);
      }
    },
    [workflowId, viewingVersion],
  );

  const isBusy = publishing || publishingLocal;

  return (
    <>
      <div
        className="wf-prop-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span className="wf-prop-title">{t("editor.version_management")}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: "none",
            background: "#f3f4f6",
            borderRadius: 4,
            color: "#6b7280",
            cursor: "pointer",
          }}
        >
          <X size={11} />
        </button>
      </div>

      {/* 发布按钮 */}
      {workflowId && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #f3f4f6" }}>
          <button
            type="button"
            onClick={handlePublishClick}
            disabled={isBusy}
            style={{
              width: "100%",
              padding: "7px 0",
              border: "none",
              borderRadius: 6,
              background: isBusy ? "#d1d5db" : "#22c55e",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: isBusy ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            <Rocket size={13} />
            {isBusy
              ? t("editor.publishing")
              : t("editor.publish_new", {
                  current: wf?.latestVersion ? t("editor.publish_current", { version: wf.latestVersion }) : "",
                })}
          </button>
        </div>
      )}

      {/* 状态摘要 */}
      {wf && (
        <div
          style={{
            padding: "6px 12px",
            borderBottom: "1px solid #f3f4f6",
            fontSize: 10,
            color: "#9ca3af",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <span>
            latest:{" "}
            <strong style={{ color: wf.latestVersion ? "#22c55e" : "#d1d5db" }}>
              {wf.latestVersion ? `v${wf.latestVersion}` : t("editor.no_published")}
            </strong>
          </span>
          <span>{t("editor.version_total", { count: versions.length })}</span>
        </div>
      )}

      {/* 版本列表 */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 11 }}>
            <Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
            <p style={{ marginTop: 4 }}>{t("editor.load_failed")}</p>
          </div>
        ) : versions.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24, color: "#d1d5db", fontSize: 11 }}>
            <Inbox size={24} style={{ margin: "0 auto 4px" }} />
            <p>{t("editor.no_published")}</p>
            <p style={{ fontSize: 9, marginTop: 2 }}>{t("versions.no_versions_hint")}</p>
          </div>
        ) : (
          versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;
            const cfg = DAG_STATUS_CFG[v.status === "active" ? "SUCCESS" : "CANCELLED"] ?? DAG_STATUS_CFG.PENDING;
            return (
              <div key={v.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <div
                  style={{
                    padding: "8px 12px",
                    cursor: "pointer",
                    transition: "background 0.1s",
                  }}
                  onClick={() => handleViewYaml(v.version)}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                    <span
                      style={{ fontFamily: "ui-monospace, monospace", fontWeight: 600, color: "#111827", fontSize: 12 }}
                    >
                      v{v.version}
                    </span>
                    {isLatest && (
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 2,
                          fontSize: 9,
                          fontWeight: 500,
                          color: "#22c55e",
                          background: "#f0fdf4",
                          padding: "1px 5px",
                          borderRadius: 99,
                        }}
                      >
                        latest
                      </span>
                    )}
                    <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
                      {new Date(v.createdAt).toLocaleString("zh-CN", {
                        month: "numeric",
                        day: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 3 }} onClick={(e) => e.stopPropagation()}>
                    {!isLatest && (
                      <button
                        type="button"
                        onClick={() => handleSetLatest(v.version)}
                        style={{
                          padding: "2px 6px",
                          border: "1px solid #e5e7eb",
                          borderRadius: 3,
                          background: "#fff",
                          color: "#6b7280",
                          fontSize: 9,
                          cursor: "pointer",
                        }}
                      >
                        {t("versions.set_latest")}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => handleRestoreToDraft(v.version)}
                      style={{
                        padding: "2px 6px",
                        border: "1px solid #e5e7eb",
                        borderRadius: 3,
                        background: "#fff",
                        color: "#6b7280",
                        fontSize: 9,
                        cursor: "pointer",
                      }}
                    >
                      {t("versions.restore_to_draft")}
                    </button>
                  </div>
                </div>
                {isViewing && viewingYaml !== null && (
                  <div style={{ padding: "0 12px 8px" }}>
                    <pre
                      style={{
                        background: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: 4,
                        padding: 8,
                        fontSize: 9,
                        fontFamily: "ui-monospace, monospace",
                        color: "#374151",
                        maxHeight: 200,
                        overflow: "auto",
                        margin: 0,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {viewingYaml}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

// ── 历史运行记录面板 ──

function RunListPanel({ onClose, onSelect }: { onClose: () => void; onSelect: (runId: string) => void }) {
  const { t } = useTranslation("workflows");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");

  useEffect(() => {
    setLoading(true);
    setError(null);
    workflowEngineApi
      .listRuns()
      .then((data) => setRuns(Array.isArray(data) ? data : []))
      .catch((err) => {
        console.error(err);
        setError(err.message);
      })
      .finally(() => setLoading(false));
  }, []);

  const filtered = runs.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    return true;
  });

  return (
    <>
      <div
        className="wf-prop-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span className="wf-prop-title">{t("editor.run_history")}</span>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: "none",
            background: "#f3f4f6",
            borderRadius: 4,
            color: "#6b7280",
            cursor: "pointer",
          }}
        >
          <X size={11} />
        </button>
      </div>

      {/* 筛选 */}
      <div
        style={{ display: "flex", gap: 3, padding: "6px 12px", borderBottom: "1px solid #f3f4f6", flexWrap: "wrap" }}
      >
        {["all", "RUNNING", "SUSPENDED", "SUCCESS", "FAILED"].map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setStatusFilter(s)}
            style={{
              padding: "2px 6px",
              border: "1px solid",
              borderColor: statusFilter === s ? "#3b82f6" : "#e5e7eb",
              borderRadius: 4,
              background: statusFilter === s ? "#eff6ff" : "#fff",
              color: statusFilter === s ? "#3b82f6" : "#6b7280",
              fontSize: 10,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {s === "all" ? t("runs.filter_all") : DAG_STATUS_CFG[s] ? t(DAG_STATUS_CFG[s].labelKey) : s}
          </button>
        ))}
      </div>

      {/* 列表 */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 11 }}>
            <Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
            <p style={{ marginTop: 4 }}>{t("editor.load_failed")}</p>
          </div>
        ) : error ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <AlertTriangle size={20} style={{ color: "#ef4444", margin: "0 auto 4px" }} />
            <p style={{ fontSize: 11, color: "#6b7280" }}>{t("editor.load_failed_short")}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24, color: "#d1d5db", fontSize: 11 }}>
            <Inbox size={24} style={{ margin: "0 auto 4px" }} />
            <p>{statusFilter !== "all" ? t("editor.no_match") : t("runs.no_runs")}</p>
          </div>
        ) : (
          filtered.map((r) => {
            const cfg = DAG_STATUS_CFG[r.status] ?? DAG_STATUS_CFG.PENDING;
            const isRunning = r.status === "RUNNING";
            return (
              <div
                key={r.run_id}
                onClick={() => onSelect(r.run_id)}
                style={{
                  padding: "8px 12px",
                  borderBottom: "1px solid #f3f4f6",
                  cursor: "pointer",
                  transition: "background 0.1s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "")}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 2 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 3,
                      padding: "1px 6px",
                      borderRadius: 99,
                      fontSize: 9,
                      fontWeight: 500,
                      color: cfg.color,
                      background: cfg.bg,
                    }}
                  >
                    {isRunning && (
                      <span
                        style={{
                          width: 4,
                          height: 4,
                          borderRadius: "50%",
                          background: cfg.color,
                          animation: "wf-pulse 1.5s ease-in-out infinite",
                        }}
                      />
                    )}
                    {t(cfg.labelKey)}
                  </span>
                  <span style={{ fontSize: 10, color: "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
                    {r.node_summary.completed}/{r.node_summary.total}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 9, color: "#d1d5db" }}>
                    {relativeTime(t, r.started_at)}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 500,
                    color: "#111827",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {r.workflow_name}
                </div>
                <div style={{ fontSize: 9, color: "#d1d5db", fontFamily: "ui-monospace, monospace" }}>
                  {r.run_id.substring(0, 20)}...
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* 底部统计 */}
      {runs.length > 0 && (
        <div
          style={{
            padding: "6px 12px",
            borderTop: "1px solid #f3f4f6",
            fontSize: 10,
            color: "#d1d5db",
            textAlign: "center",
          }}
        >
          {t("runs.total_records", { count: runs.length })}
        </div>
      )}
    </>
  );
}

function relativeTime(t: (key: string, opts?: Record<string, unknown>) => string, iso?: string | null): string {
  if (!iso) return "--";
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 0) return t("runs.relative_now");
  if (diff < 60) return t("runs.relative_now");
  if (diff < 3600) return t("runs.relative_minutes", { count: Math.floor(diff / 60) });
  if (diff < 86400) return t("runs.relative_hours", { count: Math.floor(diff / 3600) });
  if (diff < 604800) return t("runs.relative_days", { count: Math.floor(diff / 86400) });
  return new Date(iso).toLocaleDateString();
}

// ── DAG 状态样式 ──
const DAG_STATUS_CFG: Record<string, { color: string; bg: string; labelKey: string }> = {
  PENDING: { color: "#94a3b8", bg: "#f1f5f9", labelKey: "editor.dag_status_pending" },
  RUNNING: { color: "#3b82f6", bg: "#eff6ff", labelKey: "editor.dag_status_running" },
  SUSPENDED: { color: "#f59e0b", bg: "#fffbeb", labelKey: "editor.dag_status_suspended" },
  SUCCESS: { color: "#22c55e", bg: "#f0fdf4", labelKey: "editor.dag_status_success" },
  FAILED: { color: "#ef4444", bg: "#fef2f2", labelKey: "editor.dag_status_failed" },
  CANCELLED: { color: "#94a3b8", bg: "#f8fafc", labelKey: "editor.dag_status_cancelled" },
  ERROR: { color: "#ef4444", bg: "#fef2f2", labelKey: "editor.dag_status_error" },
};

// ── 事件渲染辅助 ──

function EventIcon({ type }: { type: string }) {
  if (type.startsWith("dag.")) {
    const isOk = type === "dag.completed";
    return isOk ? (
      <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />
    ) : type === "dag.cancelled" ? (
      <XCircle size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />
    ) : (
      <Play size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />
    );
  }
  if (type.includes("failed")) return <XCircle size={11} style={{ color: "#ef4444", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("completed"))
    return <CheckCircle size={11} style={{ color: "#22c55e", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("started")) return <Loader size={11} style={{ color: "#3b82f6", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("retrying"))
    return <RefreshCw size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  if (type.includes("audit"))
    return <ShieldCheck size={11} style={{ color: "#f59e0b", flexShrink: 0, marginTop: 1 }} />;
  return <Clock size={11} style={{ color: "#94a3b8", flexShrink: 0, marginTop: 1 }} />;
}

function formatEventType(t: (key: string) => string, type: string): string {
  const map: Record<string, string> = {
    "dag.started": t("editor.dag_started"),
    "dag.completed": t("editor.dag_completed"),
    "dag.cancelled": t("editor.dag_cancelled"),
    "node.started": t("editor.node_started"),
    "node.completed": t("editor.node_completed"),
    "node.failed": t("editor.node_failed"),
    "node.cancelled": t("editor.node_cancelled"),
    "node.retrying": t("editor.node_retrying"),
    "node.skipped": t("editor.node_skipped"),
    "sub_workflow.started": t("editor.sub_workflow_started"),
    "sub_workflow.completed": t("editor.sub_workflow_completed"),
    "loop.iteration_started": t("editor.loop_iteration_started"),
    "loop.iteration_completed": t("editor.loop_iteration_completed"),
    "audit.requested": t("editor.audit_requested"),
    "audit.approved": t("editor.audit_approved"),
  };
  return map[type] ?? type;
}

function formatMeta(
  t: (key: string, opts?: Record<string, unknown>) => string,
  type: string,
  meta: Record<string, unknown>,
): string {
  if (type === "node.completed") {
    const parts: string[] = [];
    if (meta.exit_code != null) parts.push(`exit=${meta.exit_code}`);
    if (meta.output_size != null) parts.push(`${meta.output_size}B`);
    if (meta.latency_ms != null) parts.push(`${Math.round(Number(meta.latency_ms))}ms`);
    return parts.join(" · ");
  }
  if (type === "node.failed") return String(meta.error ?? "");
  if (type === "node.retrying") return t("editor.retry_meta", { attempt: meta.attempt, delay: meta.next_delay_ms });
  if (type === "node.started") {
    if (meta.pid) return `pid=${meta.pid}`;
    return "";
  }
  if (type === "dag.completed") {
    if (meta.duration_ms != null) return `${Math.round(Number(meta.duration_ms) / 1000)}s`;
    return "";
  }
  return "";
}

function NodeOutputView({ output }: { output: NodeOutput }) {
  const { t } = useTranslation("workflows");
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(output.stdout).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div>
      <div
        style={{
          padding: "5px 10px",
          borderBottom: "1px solid #f3f4f6",
          display: "flex",
          alignItems: "center",
          gap: 5,
          fontSize: 9,
          color: "#6b7280",
        }}
      >
        <span>exit_code: {output.exit_code}</span>
        {output.size != null && <span>· {output.size}B</span>}
        {output.ref && <span style={{ color: "#f59e0b" }}>· {t("editor.large_output_ref")}</span>}
        <button
          type="button"
          onClick={handleCopy}
          style={{
            marginLeft: "auto",
            display: "flex",
            alignItems: "center",
            gap: 2,
            background: "none",
            border: "none",
            cursor: "pointer",
            color: "#6b7280",
            fontSize: 9,
          }}
        >
          {copied ? <Check size={10} /> : <Copy size={10} />} {copied ? t("editor.copied") : t("editor.copy")}
        </button>
      </div>
      {output.stdout ? (
        <pre
          style={{
            padding: 10,
            margin: 0,
            fontSize: 10,
            lineHeight: 1.5,
            fontFamily: "ui-monospace, monospace",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            color: "#1f2937",
            background: "#fafafa",
          }}
        >
          {output.stdout}
        </pre>
      ) : (
        <div style={{ padding: 14, textAlign: "center", color: "#d1d5db" }}>{t("editor.no_stdout")}</div>
      )}
      {output.json !== undefined && output.json !== null && (
        <div style={{ borderTop: "1px solid #f3f4f6" }}>
          <div style={{ padding: "5px 10px", fontSize: 9, color: "#6b7280", fontWeight: 500 }}>
            {t("editor.json_output")}
          </div>
          <pre
            style={{
              padding: 10,
              margin: 0,
              fontSize: 10,
              lineHeight: 1.5,
              fontFamily: "ui-monospace, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              color: "#6b7280",
            }}
          >
            {JSON.stringify(output.json, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}

export function WorkflowEditor(props: WorkflowEditorProps) {
  return (
    <ReactFlowProvider>
      <WorkflowEditorInner {...props} />
    </ReactFlowProvider>
  );
}
