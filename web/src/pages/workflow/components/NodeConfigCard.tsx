import type { Node } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { CustomToolInputDef, CustomToolItem } from "../../../api/workflow-defs";
import type { AgentNodeOption } from "../hooks/useWorkflowMetaAgent";
import { syncOutputOnRename } from "../preset-utils";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";
import { InputsEditor } from "./InputsEditor";
import { type OutputEntry, OutputsEditor, type OutputType } from "./OutputsEditor";
import { WorkflowMetaCard } from "./WorkflowMetaCard";

export interface NodeConfigCardProps {
  readOnly: boolean;
  selectedNode: Node;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: AgentNodeOption[];
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
  customTools: CustomToolItem[];
  /** 所有节点，用于检测输出字段改名时扫描下游引用 */
  nodes: Node[];
  /** 当前编辑的工作流 ID，用于 end 节点显示外部 API 调用方式 */
  workflowId?: string;
}

/** 展开编辑弹窗的状态 */
interface ExpandState {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}

/** 按 tool InputDef 的 group 分组，返回 { group, label, keys, collapsed }[]。
 *  未声明 group 的字段归入默认组（""）。advance 组排在最后。 */
function groupInputDefs(
  toolInputs: Record<string, CustomToolInputDef>,
): Array<{ group: string; keys: string[]; collapsed: boolean }> {
  const groups: Record<string, string[]> = {};
  const order: string[] = [];

  for (const [key, def] of Object.entries(toolInputs)) {
    const g = def.group ?? "";
    if (!groups[g]) {
      groups[g] = [];
      order.push(g);
    }
    groups[g].push(key);
  }

  // advance 组排到最后
  const advanceIdx = order.indexOf("advance");
  if (advanceIdx > -1) {
    order.splice(advanceIdx, 1);
    order.push("advance");
  }

  return order.map((g) => ({
    group: g,
    keys: groups[g],
    collapsed: g === "advance",
  }));
}

/** 可折叠的分组容器，使用 <details> 实现 */
function CollapsibleGroup({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  return (
    <details open={defaultOpen} style={{ marginTop: 8 }}>
      <summary style={{ fontWeight: 600, color: "#374151", cursor: "pointer", fontSize: 12 }}>{label}</summary>
      <div style={{ marginTop: 4 }}>{children}</div>
    </details>
  );
}

export function NodeConfigCard({
  readOnly,
  selectedNode,
  sd,
  nodeType,
  handleIdChange,
  setNodes,
  setSelectedNode,
  updateNodeData,
  agentList,
  meta,
  updateMeta,
  customTools,
  nodes,
  workflowId,
}: NodeConfigCardProps) {
  const { t } = useTranslation("workflows");
  const isStartNode = selectedNode.id === START_NODE_ID;
  const [expand, setExpand] = useState<ExpandState | null>(null);

  // 输出字段改名确认对话框
  const renameResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [renameDialog, setRenameDialog] = useState<{
    oldKey: string;
    newKey: string;
    affectedCount: number;
  } | null>(null);

  // 输出字段删除确认对话框
  const deleteResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    key: string;
    affectedCount: number;
  } | null>(null);

  /** 处理输出字段删除：扫描下游引用，有引用时弹确认框 */
  const handleOutputDelete = useCallback(
    async (key: string) => {
      let affectedCount = 0;
      const escapedId = selectedNode.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refPattern = new RegExp(`nodes\\.${escapedId}\\.output\\.${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      for (const node of nodes) {
        const inputs = node.data?.inputs as Record<string, string> | undefined;
        if (!inputs) continue;
        for (const val of Object.values(inputs)) {
          if (refPattern.test(val)) affectedCount++;
        }
      }
      if (affectedCount === 0) return true;
      return new Promise<boolean>((resolve) => {
        deleteResolveRef.current = resolve;
        setDeleteDialog({ key, affectedCount });
      });
    },
    [nodes, selectedNode.id],
  );

  /** 确认删除：清除下游引用中的该字段 */
  const confirmDeleteOutput = useCallback(() => {
    const dialog = deleteDialog;
    if (!dialog) return;
    const escapedId = selectedNode.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedKey = dialog.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const refPattern = new RegExp(`(nodes\\.${escapedId}\\.output\\.)${escapedKey}`, "g");
    setNodes((nds) =>
      nds.map((n) => {
        const inputs = n.data?.inputs as Record<string, string> | undefined;
        if (!inputs) return n;
        let changed = false;
        const updated: Record<string, string> = {};
        for (const [k, v] of Object.entries(inputs)) {
          if (refPattern.test(v)) {
            updated[k] = v.replace(refPattern, "$1<deleted>");
            changed = true;
          } else {
            updated[k] = v;
          }
        }
        return changed ? { ...n, data: { ...n.data, inputs: updated } } : n;
      }),
    );
    deleteResolveRef.current?.(true);
    deleteResolveRef.current = null;
    setDeleteDialog(null);
  }, [deleteDialog, selectedNode.id, setNodes]);

  const cancelDeleteOutput = useCallback(() => {
    deleteResolveRef.current?.(false);
    deleteResolveRef.current = null;
    setDeleteDialog(null);
  }, []);

  /** 处理输出字段改名：扫描下游引用，有引用时弹确认框 */
  const handleOutputRename = useCallback(
    async (oldKey: string, newKey: string) => {
      let affectedCount = 0;
      const escapedId = selectedNode.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const refPattern = new RegExp(`nodes\\.${escapedId}\\.output\\.${oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);
      for (const node of nodes) {
        const inputs = node.data?.inputs as Record<string, string> | undefined;
        if (!inputs) continue;
        for (const val of Object.values(inputs)) {
          if (refPattern.test(val)) affectedCount++;
        }
      }
      if (affectedCount === 0) return true; // 无下游引用，直接通过
      return new Promise<boolean>((resolve) => {
        renameResolveRef.current = resolve;
        setRenameDialog({ oldKey, newKey, affectedCount });
      });
    },
    [nodes, selectedNode.id],
  );

  /** 确认改名：扫描并同步下游引用 */
  const confirmRename = useCallback(() => {
    const dialog = renameDialog;
    if (!dialog) return;
    const escapedId = selectedNode.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const escapedOld = dialog.oldKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const refPattern = new RegExp(`(nodes\\.${escapedId}\\.output\\.)${escapedOld}`, "g");
    setNodes((nds) =>
      nds.map((n) => {
        const inputs = n.data?.inputs as Record<string, string> | undefined;
        if (!inputs) return n;
        let changed = false;
        const updated: Record<string, string> = {};
        for (const [k, v] of Object.entries(inputs)) {
          if (refPattern.test(v)) {
            updated[k] = v.replace(refPattern, `$1${dialog.newKey}`);
            changed = true;
          } else {
            updated[k] = v;
          }
        }
        return changed ? { ...n, data: { ...n.data, inputs: updated } } : n;
      }),
    );
    renameResolveRef.current?.(true);
    renameResolveRef.current = null;
    setRenameDialog(null);
  }, [renameDialog, selectedNode.id, setNodes]);

  const cancelRename = useCallback(() => {
    renameResolveRef.current?.(false);
    renameResolveRef.current = null;
    setRenameDialog(null);
  }, []);

  /** 获取输出的显示值，若无声明则自动预填 stdout 作为默认输出 */
  const getDisplayOutputs = useCallback(
    (existing: Record<string, OutputEntry> | undefined): Record<string, OutputEntry> => {
      if (existing && Object.keys(existing).length > 0) return existing;
      return { stdout: { pattern: "", type: "value" } };
    },
    [],
  );

  /** 渲染代码块字段（带展开按钮） */
  const renderBlockField = (
    label: string,
    value: string,
    onChange: (v: string) => void,
    opts?: { placeholder?: string; rows?: number },
  ) => (
    <div className="wf-prop-field-block">
      <div className="wf-prop-field-block-header">
        <label>{label}</label>
        <button
          type="button"
          className="wf-prop-expand-btn"
          title={t("editor.expand_edit")}
          onClick={() =>
            setExpand({
              label,
              value,
              onChange,
              placeholder: opts?.placeholder,
            })
          }
        >
          <Maximize2 size={12} />
        </button>
      </div>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={opts?.placeholder}
        rows={opts?.rows ?? 3}
        readOnly={readOnly}
        className="font-mono text-xs"
      />
    </div>
  );

  /** 渲染横向字段 */
  const renderInlineField = (label: string, children: React.ReactNode) => (
    <div className="wf-prop-field-inline">
      <label>{label}</label>
      {children}
    </div>
  );

  return (
    <div className="wf-popover-body">
      {/* 开始节点 */}
      {isStartNode ? (
        <WorkflowMetaCard readOnly={readOnly} meta={meta} updateMeta={updateMeta} />
      ) : (
        <>
          {/* 节点基本信息 */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.basic_info")}</div>
            {renderInlineField(
              t("editor.node_id"),
              <input value={selectedNode.id} onChange={(e) => handleIdChange(e.target.value)} readOnly={readOnly} />,
            )}
            {renderInlineField(
              t("editor.type"),
              <select
                value={nodeType}
                onChange={(e) => {
                  const newType = e.target.value;
                  setNodes((nds) => nds.map((n) => (n.id === selectedNode.id ? { ...n, type: newType } : n)));
                  setSelectedNode((prev) => (prev ? { ...prev, type: newType } : null));
                }}
                disabled={readOnly}
              >
                <option value="shell">{t("editor.type_shell")}</option>
                <option value="python">{t("editor.type_python")}</option>
                <option value="agent">{t("editor.type_agent")}</option>
                <option value="api">{t("editor.type_api")}</option>
                <option value="audit">{t("editor.type_audit")}</option>
                <option value="workflow">{t("editor.type_workflow")}</option>
                <option value="loop">{t("editor.type_loop")}</option>
                <option value="transform">{t("nodes.transform")}</option>
                <option value="custom">{t("editor.type_custom")}</option>
              </select>,
            )}
            {renderInlineField(
              t("editor.description"),
              <input
                value={String(sd?.description ?? "")}
                onChange={(e) => updateNodeData({ description: e.target.value || undefined })}
                placeholder={t("editor.description_placeholder")}
                readOnly={readOnly}
              />,
            )}
          </div>

          {/* 节点配置（按类型） */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.config")}</div>

            {nodeType === "shell" && (
              <>
                {renderBlockField(
                  t("editor.shell_command"),
                  String(sd?.command ?? ""),
                  (v) => updateNodeData({ command: v }),
                  { placeholder: 'echo "Hello $name"' },
                )}
                <div className="wf-prop-hint">{t("editor.shell_inputs_hint")}</div>
                {renderBlockField(t("editor.shell_env"), String(sd?.env ?? ""), (v) => updateNodeData({ env: v }), {
                  placeholder: t("editor.shell_env_placeholder"),
                  rows: 2,
                })}
                <div className="wf-prop-field-block">
                  <label>{t("editor.inputs_title")}</label>
                  <InputsEditor
                    value={sd?.inputs as Record<string, string> | undefined}
                    onChange={(val) => {
                      updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.inputs_key_placeholder")}
                    valuePlaceholder={t("editor.inputs_value_hint")}
                    addLabel={t("editor.inputs_add")}
                  />
                </div>
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "python" && (
              <>
                {renderBlockField(t("editor.python_code"), String(sd?.code ?? ""), (v) => updateNodeData({ code: v }), {
                  placeholder:
                    'import os, json\nname = os.environ.get("name", "")\nprint(json.dumps({"result": f"Hello {name}"}))',
                  rows: 6,
                })}
                <div className="wf-prop-hint">{t("editor.python_inputs_hint")}</div>
                {renderBlockField(
                  t("editor.python_requirements"),
                  Array.isArray(sd?.requirements)
                    ? (sd.requirements as string[]).join("\n")
                    : String(sd?.requirements ?? ""),
                  (v) =>
                    updateNodeData({
                      requirements: v
                        ? v
                            .split("\n")
                            .map((s: string) => s.trim())
                            .filter(Boolean)
                        : undefined,
                    }),
                  { placeholder: t("editor.python_requirements_placeholder"), rows: 2 },
                )}
                {renderBlockField(t("editor.shell_env"), String(sd?.env ?? ""), (v) => updateNodeData({ env: v }), {
                  placeholder: t("editor.shell_env_placeholder"),
                  rows: 2,
                })}
                <div className="wf-prop-field-block">
                  <label>{t("editor.inputs_title")}</label>
                  <InputsEditor
                    value={sd?.inputs as Record<string, string> | undefined}
                    onChange={(val) => {
                      updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.inputs_key_placeholder")}
                    valuePlaceholder={t("editor.inputs_value_hint")}
                    addLabel={t("editor.inputs_add")}
                  />
                </div>
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "agent" && (
              <>
                {renderInlineField(
                  t("editor.agent_env"),
                  <select
                    value={String(sd?.agent ?? "")}
                    onChange={(e) => updateNodeData({ agent: e.target.value || undefined })}
                    disabled={readOnly}
                  >
                    <option value="">{t("editor.agent_select_env")}</option>
                    {agentList.map((a) => (
                      <option key={a.name} value={a.envName ?? ""} disabled={!a.envName}>
                        {a.name}
                        {a.description ? ` - ${a.description}` : ""}
                        {!a.envName ? ` (${t("editor.agent_no_env")})` : ""}
                      </option>
                    ))}
                  </select>,
                )}
                {renderBlockField(
                  t("editor.agent_prompt"),
                  String(sd?.prompt ?? ""),
                  (v) => updateNodeData({ prompt: v }),
                  { placeholder: t("editor.agent_prompt_placeholder"), rows: 4 },
                )}
                {renderInlineField(
                  t("editor.agent_output_messages"),
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={sd?.output_messages != null ? String(sd.output_messages) : ""}
                    onChange={(e) =>
                      updateNodeData({ output_messages: e.target.value ? Number(e.target.value) : undefined })
                    }
                    placeholder="0"
                    readOnly={readOnly}
                  />,
                )}
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "api" && (
              <>
                {renderInlineField(
                  "URL",
                  <input
                    value={String(sd?.url ?? "")}
                    onChange={(e) => updateNodeData({ url: e.target.value })}
                    placeholder="https://api.example.com/data"
                    readOnly={readOnly}
                  />,
                )}
                {renderInlineField(
                  t("editor.api_method"),
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
                  </select>,
                )}
                {renderBlockField(
                  t("editor.api_headers"),
                  String(sd?.headers ?? ""),
                  (v) => updateNodeData({ headers: v }),
                  // biome-ignore lint/suspicious/noTemplateCurlyInString: 工作流模板语法 ${{ }}
                  { placeholder: '{"Authorization": "Bearer ${{ secrets.KEY }}"}' },
                )}
                {renderBlockField(t("editor.api_body"), String(sd?.body ?? ""), (v) => updateNodeData({ body: v }), {
                  placeholder: '{"key": "value"}',
                })}
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "audit" && (
              <>
                {renderInlineField(
                  t("editor.audit_message"),
                  <input
                    value={String(
                      (typeof sd?.display_data === "object" && sd?.display_data !== null
                        ? (sd.display_data as Record<string, string>).message
                        : sd?.display_data) ?? "",
                    )}
                    onChange={(e) => updateNodeData({ display_data: { message: e.target.value } })}
                    placeholder={t("editor.audit_message_placeholder")}
                    readOnly={readOnly}
                  />,
                )}
                {renderInlineField(
                  t("editor.audit_expires"),
                  <input
                    type="number"
                    value={sd?.expires_in != null ? String(sd.expires_in) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateNodeData({ expires_in: v ? Number(v) : undefined });
                    }}
                    placeholder="86400"
                    readOnly={readOnly}
                  />,
                )}
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "workflow" && (
              <>
                {renderInlineField(
                  t("editor.workflow_ref"),
                  <input
                    value={String(sd?.ref ?? "")}
                    onChange={(e) => updateNodeData({ ref: e.target.value })}
                    placeholder="./sub-workflow.yaml"
                    readOnly={readOnly}
                  />,
                )}
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "loop" && (
              <>
                {renderInlineField(
                  t("editor.loop_condition"),
                  <input
                    value={String(sd?.condition ?? "")}
                    onChange={(e) => updateNodeData({ condition: e.target.value })}
                    placeholder="{{ counter < 10 }}"
                    readOnly={readOnly}
                  />,
                )}
                {renderInlineField(
                  t("editor.loop_max_iterations"),
                  <input
                    type="number"
                    value={sd?.max_iterations != null ? String(sd.max_iterations) : ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      updateNodeData({ max_iterations: v ? Number(v) : undefined });
                    }}
                    placeholder="10"
                    readOnly={readOnly}
                  />,
                )}
                <div className="wf-prop-hint" style={{ marginTop: 4 }}>
                  <p>{t("editor.loop_body_hint")}</p>
                </div>
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={getDisplayOutputs(sd?.outputs as Record<string, OutputEntry> | undefined)}
                    onChange={(val) => updateNodeData({ outputs: val })}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.outputs_key_placeholder")}
                    patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                    addLabel={t("editor.outputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "transform" && (
              <>
                <div className="wf-prop-field-block">
                  <label>{t("editor.transform_inputs_title")}</label>
                  <InputsEditor
                    value={sd?.inputs as Record<string, string> | undefined}
                    onChange={(val) => {
                      updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.transform_inputs_key_placeholder")}
                    valuePlaceholder={t("editor.inputs_value_hint")}
                    addLabel={t("editor.transform_inputs_add")}
                  />
                </div>
                <div className="wf-prop-field-block">
                  <label>{t("editor.transform_output_title")}</label>
                  <InputsEditor
                    value={sd?.output as Record<string, string> | undefined}
                    onChange={(val) => {
                      if (!val || Object.keys(val).length === 0) {
                        updateNodeData({ output: undefined });
                        return;
                      }
                      const oldOutput = (sd?.output as Record<string, string>) ?? {};
                      const synced = syncOutputOnRename(oldOutput, val);
                      updateNodeData({ output: synced });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.transform_output_key_placeholder")}
                    valuePlaceholder={t("editor.output_value_hint")}
                    addLabel={t("editor.transform_output_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "custom" &&
              (() => {
                const customTool = customTools.find((t) => t.name === sd?.tool);
                const grouped = customTool ? groupInputDefs(customTool.inputs) : [];
                const declaredKeys = new Set(grouped.flatMap((g) => g.keys));
                const inputValues = sd?.inputs as Record<string, string> | undefined;

                // 分组渲染时保留其他组 key 的通用 onChange
                const makeGroupOnChange = (groupKeys: string[]) => (val: Record<string, string> | undefined) => {
                  const otherKeys = Object.keys(inputValues ?? {}).filter((k) => !groupKeys.includes(k));
                  const others: Record<string, string> = {};
                  for (const k of otherKeys) {
                    if (inputValues?.[k]) others[k] = inputValues[k];
                  }
                  const cleaned = val && Object.keys(val).length > 0 ? val : {};
                  updateNodeData({ inputs: { ...others, ...cleaned } });
                };

                return (
                  <>
                    {renderInlineField(
                      t("editor.custom_tool"),
                      <>
                        <input
                          list="custom-tools-list"
                          value={String(sd?.tool ?? "")}
                          onChange={(e) => updateNodeData({ tool: e.target.value || undefined })}
                          placeholder={t("editor.custom_tool_placeholder")}
                          readOnly={readOnly}
                        />
                        <datalist id="custom-tools-list">
                          {customTools.map((tool) => (
                            <option key={tool.name} value={tool.name}>
                              {tool.description}
                            </option>
                          ))}
                        </datalist>
                      </>,
                    )}

                    {/* 分组输入 — 仅当工具匹配且有超过 1 组时显示 */}
                    {grouped.length > 1 &&
                      grouped.map(({ group, keys, collapsed }) => {
                        // 工具声明的字段全部展示，未填值时预填空字符串，用户可直接填写 value 无需手动加 key
                        const merged: Record<string, string> = {};
                        for (const k of keys) {
                          merged[k] = inputValues?.[k] ?? "";
                        }
                        const label = group === "advance" ? t("editor.group_advance") : t("editor.group_default");
                        return (
                          <CollapsibleGroup key={group} label={label} defaultOpen={!collapsed}>
                            <InputsEditor
                              value={merged}
                              onChange={makeGroupOnChange(keys)}
                              readOnly={readOnly}
                              keyPlaceholder={t("editor.inputs_key_placeholder")}
                              valuePlaceholder={t("editor.inputs_value_hint")}
                              addLabel={t("editor.inputs_add")}
                            />
                          </CollapsibleGroup>
                        );
                      })}

                    {/* Slurm 专属配置 */}
                    {sd?.tool === "slurm" && (
                      <>
                        <div className="wf-prop-field-block" style={{ marginTop: 8 }}>
                          <label style={{ fontWeight: 600, color: "#374151" }}>{t("editor.slurm_section")}</label>
                        </div>
                        {renderInlineField(
                          t("editor.slurm_partition"),
                          <input
                            value={String((sd?.slurm as Record<string, unknown>)?.partition ?? "")}
                            onChange={(e) =>
                              updateNodeData({
                                slurm: {
                                  ...((sd?.slurm as Record<string, unknown>) ?? {}),
                                  partition: e.target.value,
                                },
                              })
                            }
                            placeholder="xahcnormal"
                            readOnly={readOnly}
                          />,
                        )}
                        {renderInlineField(
                          t("editor.slurm_cores"),
                          <input
                            type="number"
                            value={
                              (sd?.slurm as Record<string, unknown>)?.cores != null
                                ? String((sd?.slurm as Record<string, unknown>).cores)
                                : ""
                            }
                            onChange={(e) =>
                              updateNodeData({
                                slurm: {
                                  ...((sd?.slurm as Record<string, unknown>) ?? {}),
                                  cores: e.target.value ? Number(e.target.value) : undefined,
                                },
                              })
                            }
                            placeholder="4"
                            readOnly={readOnly}
                          />,
                        )}
                        {renderInlineField(
                          t("editor.slurm_walltime"),
                          <input
                            value={String((sd?.slurm as Record<string, unknown>)?.walltime ?? "")}
                            onChange={(e) =>
                              updateNodeData({
                                slurm: {
                                  ...((sd?.slurm as Record<string, unknown>) ?? {}),
                                  walltime: e.target.value,
                                },
                              })
                            }
                            placeholder="02:00:00"
                            readOnly={readOnly}
                          />,
                        )}
                        {renderBlockField(
                          t("editor.slurm_modules"),
                          Array.isArray((sd?.slurm as Record<string, unknown>)?.modules)
                            ? ((sd?.slurm as Record<string, unknown>).modules as string[]).join("\n")
                            : "",
                          (v) =>
                            updateNodeData({
                              slurm: {
                                ...((sd?.slurm as Record<string, unknown>) ?? {}),
                                modules: v
                                  ? v
                                      .split("\n")
                                      .map((s: string) => s.trim())
                                      .filter(Boolean)
                                  : undefined,
                              },
                            }),
                          { placeholder: t("editor.slurm_modules_placeholder"), rows: 2 },
                        )}
                        {/* 脚本内容 — 核心：大段 bash 脚本，带展开按钮 */}
                        {renderBlockField(
                          t("editor.slurm_script_content"),
                          String((sd?.script as Record<string, unknown>)?.content ?? ""),
                          (v) =>
                            updateNodeData({
                              script: { ...((sd?.script as Record<string, unknown>) ?? {}), content: v },
                            }),
                          { rows: 6 },
                        )}
                        {/* 脚本环境变量 */}
                        <div className="wf-prop-field-block">
                          <label>{t("editor.slurm_script_env")}</label>
                          <p className="text-[10px] text-gray-400 mb-1.5 leading-tight">{t("editor.slurm_env_hint")}</p>
                          <Textarea
                            value={(() => {
                              const env = (sd?.script as Record<string, unknown>)?.env as
                                | Record<string, string>
                                | undefined;
                              return env
                                ? Object.entries(env)
                                    .map(([k, v]) => `${k}=${v}`)
                                    .join("\n")
                                : "";
                            })()}
                            onChange={(e) => {
                              const pairs = e.target.value
                                ? e.target.value
                                    .split("\n")
                                    .map((s: string) => s.trim())
                                    .filter(Boolean)
                                : [];
                              const envObj: Record<string, string> = {};
                              for (const line of pairs) {
                                const eqIdx = line.indexOf("=");
                                if (eqIdx > 0) {
                                  envObj[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim();
                                }
                              }
                              updateNodeData({
                                script: {
                                  ...((sd?.script as Record<string, unknown>) ?? {}),
                                  env: Object.keys(envObj).length > 0 ? envObj : undefined,
                                },
                              });
                            }}
                            placeholder={t("editor.slurm_script_env_placeholder")}
                            rows={2}
                            readOnly={readOnly}
                            className="font-mono text-xs"
                          />
                        </div>
                      </>
                    )}

                    {/* InputsEditor — 分组模式下只显示未声明字段，反之显示全部 */}
                    <div className="wf-prop-field-block">
                      <label>{t("editor.inputs_title")}</label>
                      {sd?.tool === "slurm" && (
                        <p className="text-[10px] text-gray-400 mb-1.5 leading-tight">
                          {t("editor.slurm_inputs_hint")}
                        </p>
                      )}
                      <InputsEditor
                        value={
                          grouped.length > 1
                            ? Object.fromEntries(
                                Object.keys(inputValues ?? {})
                                  .filter((k) => !declaredKeys.has(k))
                                  .map((k) => [k, inputValues?.[k] ?? ""]),
                              )
                            : inputValues
                        }
                        onChange={(val) => {
                          if (grouped.length > 1) {
                            // 保留分组字段
                            const groupValues: Record<string, string> = {};
                            for (const k of declaredKeys) {
                              if (inputValues?.[k]) groupValues[k] = inputValues[k];
                            }
                            const extra = val && Object.keys(val).length > 0 ? val : {};
                            updateNodeData({ inputs: { ...groupValues, ...extra } });
                          } else {
                            updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                          }
                        }}
                        readOnly={readOnly}
                        keyPlaceholder={t("editor.inputs_key_placeholder")}
                        valuePlaceholder={t("editor.inputs_value_hint")}
                        addLabel={t("editor.inputs_add")}
                      />
                    </div>
                    <div className="wf-prop-field-block">
                      <label>{t("editor.outputs_title")}</label>
                      <OutputsEditor
                        value={(() => {
                          const existing = sd?.outputs as Record<string, OutputEntry> | undefined;
                          if (existing && Object.keys(existing).length > 0) return existing;
                          // 工具声明的 produces 不为通配符时，自动预填对应默认输出字段
                          // 通配符工具（如 slurm）或空 produces 也兜底预填 stdout
                          const tool = customTool;
                          if (!tool) return { stdout: { pattern: "", type: "value" as OutputType } };
                          if (tool.produces.includes("*") || tool.produces.length === 0) {
                            return { stdout: { pattern: "", type: "value" as OutputType } };
                          }
                          const defaults: Record<string, OutputEntry> = {};
                          for (const key of tool.produces) {
                            const entry = existing?.[key] as OutputEntry | undefined;
                            // 已有 entry 但 pattern 为空且类型为 file → 升为 value
                            const normalized =
                              entry?.pattern === "" && entry?.type === "file"
                                ? { ...entry, type: "value" as OutputType }
                                : entry;
                            defaults[key] = normalized ?? { pattern: "", type: "value" as OutputType };
                          }
                          return defaults;
                        })()}
                        onChange={(val) => updateNodeData({ outputs: val })}
                        onKeyRename={handleOutputRename}
                        onBeforeDelete={handleOutputDelete}
                        readOnly={readOnly}
                        keyPlaceholder={t("editor.outputs_key_placeholder")}
                        patternPlaceholder={t("editor.outputs_pattern_placeholder")}
                        addLabel={t("editor.outputs_add")}
                      />
                    </div>
                  </>
                );
              })()}
          </div>

          {/* ── end 节点：inputs 编辑器 + 外部 API 使用方式 ── */}
          {nodeType === "end" && (
            <div className="wf-prop-section">
              {/* Inputs 编辑器 */}
              <div className="wf-prop-field-block" style={{ marginBottom: 12 }}>
                <label>{t("editor.inputs_title")}</label>
                <InputsEditor
                  value={sd?.inputs as Record<string, string> | undefined}
                  onChange={(val) => {
                    updateNodeData({ inputs: val && Object.keys(val).length > 0 ? val : undefined });
                  }}
                  readOnly={readOnly}
                  keyPlaceholder={t("editor.inputs_key_placeholder")}
                  valuePlaceholder={t("editor.inputs_value_hint")}
                  addLabel={t("editor.inputs_add")}
                />
              </div>

              <div className="wf-prop-section-title">{t("end_node.api_title")}</div>
              <p className="wf-prop-hint" style={{ marginBottom: 12 }}>
                {t("end_node.api_desc")}
              </p>

              {/* API 端点 */}
              <div className="wf-prop-section-title" style={{ fontSize: 13, marginTop: 4 }}>
                {t("end_node.api_endpoint")}
              </div>
              <div
                className="wf-prop-section"
                style={{ padding: "8px 12px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}
              >
                <code style={{ fontSize: 12, wordBreak: "break-all" }}>
                  POST /api/workflows/{workflowId ? `{workflowId}` : "{workflowId}"}/execute
                </code>
              </div>

              {/* 请求示例 */}
              <div className="wf-prop-section-title" style={{ fontSize: 13, marginTop: 12 }}>
                {t("end_node.request_example")}
              </div>
              <div
                className="wf-prop-section"
                style={{ padding: "8px 12px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}
              >
                <pre
                  style={{ fontSize: 11, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {(() => {
                    const host = typeof window !== "undefined" ? window.location.origin : "";
                    const paramsEntries = meta.params ? Object.entries(meta.params as Record<string, unknown>) : [];
                    const inputKeys = sd?.inputs ? Object.keys(sd.inputs as Record<string, unknown>) : [];
                    // 构建 inputs 示例 JSON
                    const inputsExample: Record<string, string> = {};
                    for (const [k, v] of paramsEntries) {
                      const schema = v as { default?: unknown };
                      inputsExample[k] = schema.default != null ? String(schema.default) : k;
                    }
                    const body: Record<string, unknown> = { mode: "sync" };
                    if (Object.keys(inputsExample).length > 0) {
                      body.inputs = inputsExample;
                    }
                    return `curl -X POST \\
  "${host}/api/workflows/${workflowId || "{workflowId}"}/execute" \\
  -H "Authorization: Bearer rcs_your_api_key" \\
  -H "Content-Type: application/json" \\
  -d '${JSON.stringify(body, null, 2).replace(/'/g, "\\'")}'`;
                  })()}
                </pre>
              </div>

              {/* 响应示例 */}
              <div className="wf-prop-section-title" style={{ fontSize: 13, marginTop: 12 }}>
                {t("end_node.response_example")}
              </div>
              <div
                className="wf-prop-section"
                style={{ padding: "8px 12px", background: "#f8fafc", borderRadius: 8, border: "1px solid #e2e8f0" }}
              >
                <pre
                  style={{ fontSize: 11, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}
                >
                  {(() => {
                    const inputKeys = sd?.inputs ? Object.keys(sd.inputs as Record<string, unknown>) : [];
                    const outputFields: Record<string, string> = {};
                    if (inputKeys.length > 0) {
                      for (const k of inputKeys) {
                        outputFields[k] = "...";
                      }
                    } else {
                      outputFields.total_price = "99.5";
                      outputFields.is_valid = "true";
                    }
                    return JSON.stringify(
                      { runId: "run_abc123", status: "SUCCESS", output: outputFields, duration: 4.2 },
                      null,
                      2,
                    );
                  })()}
                </pre>
              </div>

              {/* 认证说明 */}
              <div className="wf-prop-section-title" style={{ fontSize: 13, marginTop: 12 }}>
                {t("end_node.auth_note")}
              </div>
              <p className="wf-prop-hint">{t("end_node.auth_desc")}</p>
            </div>
          )}

          {/* 高级配置 */}
          <div className="wf-prop-section">
            <div className="wf-prop-section-title">{t("editor.advanced")}</div>
            {renderInlineField(
              t("editor.timeout_seconds"),
              <input
                type="number"
                value={sd?.timeout != null ? String(sd.timeout) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  updateNodeData({ timeout: v ? Number(v) : undefined });
                }}
                placeholder="300"
                readOnly={readOnly}
              />,
            )}
            {renderInlineField(
              t("editor.retry_count"),
              <input
                type="number"
                value={sd?.retry != null ? String(sd.retry) : ""}
                onChange={(e) => {
                  const v = e.target.value;
                  updateNodeData({ retry: v ? Number(v) : undefined });
                }}
                placeholder="0"
                readOnly={readOnly}
              />,
            )}
          </div>
        </>
      )}

      {/* 代码展开编辑 Dialog */}
      <Dialog
        open={expand !== null}
        onOpenChange={(open) => {
          if (!open) setExpand(null);
        }}
      >
        <DialogContent className="wf-code-dialog" style={{ maxWidth: 640, width: "90vw" }}>
          <DialogHeader>
            <DialogTitle>{expand?.label}</DialogTitle>
          </DialogHeader>
          <Textarea
            value={expand?.value ?? ""}
            onChange={(e) => expand?.onChange(e.target.value)}
            placeholder={expand?.placeholder}
            rows={20}
            readOnly={readOnly}
            className="font-mono text-sm"
          />
        </DialogContent>
      </Dialog>

      {/* 输出字段改名确认 Dialog */}
      <Dialog
        open={renameDialog !== null}
        onOpenChange={(open) => {
          if (!open) cancelRename();
        }}
      >
        <DialogContent style={{ maxWidth: 400 }}>
          <DialogHeader>
            <DialogTitle>{t("editor.rename_output_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {t("editor.rename_output_desc", {
              oldKey: renameDialog?.oldKey ?? "",
              newKey: renameDialog?.newKey ?? "",
              count: renameDialog?.affectedCount ?? 0,
            })}
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={cancelRename}>
              {t("common:cancel")}
            </Button>
            <Button size="sm" onClick={confirmRename}>
              {t("common:confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* 输出字段删除确认 Dialog */}
      <Dialog
        open={deleteDialog !== null}
        onOpenChange={(open) => {
          if (!open) cancelDeleteOutput();
        }}
      >
        <DialogContent style={{ maxWidth: 400 }}>
          <DialogHeader>
            <DialogTitle>{t("editor.delete_output_title")}</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-gray-600">
            {t("editor.delete_output_desc", {
              key: deleteDialog?.key ?? "",
              count: deleteDialog?.affectedCount ?? 0,
            })}
          </p>
          <div className="flex justify-end gap-2 mt-4">
            <Button variant="outline" size="sm" onClick={cancelDeleteOutput}>
              {t("common:cancel")}
            </Button>
            <Button size="sm" variant="destructive" onClick={confirmDeleteOutput}>
              {t("editor.delete_output_confirm")}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
