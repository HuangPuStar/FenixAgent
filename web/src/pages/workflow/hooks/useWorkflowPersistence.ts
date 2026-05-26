import type { Edge, Node } from "@xyflow/react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { workflowDefApi } from "../../../api/workflow-defs";
import { pushWorkflowError } from "../../../lib/use-workflow-events";
import { flowToYaml, type WfMeta, yamlToFlow } from "../yaml-utils";

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
}

export interface UseWorkflowPersistenceReturn {
  syncYaml: () => string;
  handleImportYaml: () => void;
  handleExportYaml: () => void;
  handleFileImport: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleSaveDraft: () => Promise<void>;
  handlePublish: () => Promise<void>;
  saveStatus: "idle" | "saving" | "saved";
  publishing: boolean;
  lastSavedYaml: string;
  setLastSavedYaml: (yaml: string) => void;
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
  } = params;

  const { t } = useTranslation("workflows");

  const [lastSavedYaml, setLastSavedYaml] = useState("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [publishing, setPublishing] = useState(false);

  const syncYaml = useCallback(() => {
    const y = flowToYaml(nodes, edges, meta);
    setYamlText(y);
    return y;
  }, [nodes, edges, meta, setYamlText]);

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
      pushWorkflowError("save", (err as Error).message);
      toast.error(`${t("editor.save_failed")}: ${(err as Error).message}`);
      setSaveStatus("idle");
    }
  }, [syncYaml, workflowId, t]);

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
      setSaveStatus("idle");
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
  };
}
