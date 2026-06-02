import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import { pushWorkflowError } from "../../../lib/use-workflow-events";
import { flowToYaml, type WfMeta, yamlToFlow } from "../yaml-utils";

const AUTO_SAVE_DELAY = 3000;

export interface UseWorkflowPersistenceParams {
  workflowId: string | undefined;
  meta: WfMeta;
  nodes: Node[];
  edges: Edge[];
  setNodes: ReturnType<typeof import("@xyflow/react").useNodesState<Node>>[1];
  setEdges: ReturnType<typeof import("@xyflow/react").useEdgesState<Edge>>[1];
  fitView: (opts?: { padding?: number; duration?: number }) => void;
  yamlOpen: boolean;
  yamlText: string;
  setYamlText: (text: string) => void;
  setSelectedNode: (node: Node | null) => void;
  setMeta: (fn: (prev: WfMeta) => WfMeta) => void;
  setDryRunResult: (
    result: {
      valid: boolean;
      issues: Array<{ type: string; message: string; field?: string }>;
    } | null,
  ) => void;
  setYamlOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  readOnly: boolean;
}

export interface UseWorkflowPersistenceReturn {
  syncYaml: () => string;
  handleImportYaml: () => void;
  handleExportYaml: () => void;
  handleFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSaveDraft: () => Promise<boolean>;
  handlePublish: () => Promise<void>;
  saveStatus: "idle" | "saving" | "saved" | "unsaved";
  publishing: boolean;
  lastSavedYaml: string;
  setLastSavedYaml: (yaml: string) => void;
  hasUnsavedChanges: boolean;
}

export function useWorkflowPersistence(params: UseWorkflowPersistenceParams): UseWorkflowPersistenceReturn {
  const {
    workflowId,
    meta,
    nodes,
    edges,
    setNodes,
    setEdges,
    fitView,
    yamlOpen,
    yamlText,
    setYamlText,
    setSelectedNode,
    setMeta,
    setDryRunResult,
    setYamlOpen,
    readOnly,
  } = params;

  const { t } = useTranslation("workflows");

  const [lastSavedYaml, setLastSavedYaml] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "unsaved">("idle");
  const [publishing, setPublishing] = useState(false);

  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);

  const syncYaml = useCallback(() => {
    const y = flowToYaml(nodes, edges, meta);
    setYamlText(y);
    return y;
  }, [nodes, edges, meta, setYamlText]);

  const currentYaml = useMemo(() => flowToYaml(nodes, edges, meta), [nodes, edges, meta]);
  const hasUnsavedChanges = lastSavedYaml !== "" && currentYaml !== lastSavedYaml;

  useEffect(() => {
    if (hasUnsavedChanges && saveStatus !== "unsaved" && saveStatus !== "saving") {
      setSaveStatus("unsaved");
    } else if (!hasUnsavedChanges && saveStatus === "unsaved") {
      setSaveStatus("idle");
    }
  }, [hasUnsavedChanges, saveStatus]);

  const handleSaveDraft = useCallback(async (): Promise<boolean> => {
    if (!workflowId) return false;
    if (isSavingRef.current) return false;
    isSavingRef.current = true;
    const y = syncYaml();
    setSaveStatus("saving");
    try {
      await workflowDefApi.save(workflowId, y);
      setLastSavedYaml(y);
      setSaveStatus("saved");
      setTimeout(() => setSaveStatus("idle"), 2000);
      return true;
    } catch (err) {
      console.error(err);
      pushWorkflowError("save", (err as Error).message);
      toast.error(`${t("editor.save_failed")}: ${(err as Error).message}`);
      setSaveStatus("unsaved");
      return false;
    } finally {
      isSavingRef.current = false;
    }
  }, [syncYaml, workflowId, t]);

  // 自动保存：nodes/edges/meta 变化后 debounce 3s 自动保存
  // biome-ignore lint/correctness/useExhaustiveDependencies: nodes/edges/meta 故意作为触发器
  useEffect(() => {
    if (!workflowId || readOnly || lastSavedYaml === "") return;
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => {
      handleSaveDraft();
    }, AUTO_SAVE_DELAY);
    return () => {
      if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    };
  }, [nodes, edges, meta, workflowId, readOnly, lastSavedYaml, handleSaveDraft]);

  // beforeunload：未保存时阻止浏览器关闭
  useEffect(() => {
    if (!hasUnsavedChanges) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasUnsavedChanges]);

  const handleImportYaml = useCallback(() => {
    if (yamlOpen) {
      const text = yamlText.trim();
      if (!text) return;
      try {
        const { nodes: newNodes, edges: newEdges, meta: newMeta } = yamlToFlow(text);
        setNodes(newNodes);
        setEdges(newEdges);
        setMeta(() => newMeta);
        setSelectedNode(null);
        setDryRunResult(null);
        setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.import_yaml_failed")}: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      syncYaml();
      setYamlOpen(true);
    }
  }, [
    yamlOpen,
    yamlText,
    setNodes,
    setEdges,
    setMeta,
    setSelectedNode,
    setDryRunResult,
    syncYaml,
    fitView,
    t,
    setYamlOpen,
  ]);

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
          setMeta(() => newMeta);
          setSelectedNode(null);
          setYamlText(text);
          setDryRunResult(null);
          setTimeout(() => fitView({ padding: 0.15, duration: 300 }), 50);
        } catch (err) {
          console.error(err);
          toast.error(`${t("editor.import_file_failed")}: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      reader.readAsText(file);
      e.target.value = "";
    },
    [setNodes, setEdges, setMeta, setSelectedNode, setYamlText, setDryRunResult, fitView, t],
  );

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
      toast.error(`${t("editor.save_failed")}: ${(err as Error).message}`);
      setSaveStatus("unsaved");
      return;
    }

    setPublishing(true);
    try {
      const result = await workflowDefApi.publish(workflowId);
      toast.success(t("editor.published_as", { version: result.version }));
    } catch (err) {
      console.error(err);
      pushWorkflowError("publish", (err as Error).message);
      toast.error(`${t("editor.publish_failed")}: ${(err as Error).message}`);
    } finally {
      setPublishing(false);
    }
  }, [syncYaml, workflowId, t]);

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

  return {
    syncYaml,
    handleImportYaml,
    handleExportYaml,
    handleFileImport,
    handleSaveDraft,
    handlePublish,
    saveStatus,
    publishing,
    lastSavedYaml,
    setLastSavedYaml,
    hasUnsavedChanges,
  };
}
