import type { Node } from "@xyflow/react";
import { Maximize2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type { CustomToolInputDef, CustomToolItem } from "../../../api/workflow-defs";
import type { AgentNodeOption } from "../hooks/useWorkflowMetaAgent";
import { syncOutputOnRename } from "../preset-utils";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";
import { InputsEditor } from "./InputsEditor";
import { type OutputEntry, OutputsEditor } from "./OutputsEditor";
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
}: NodeConfigCardProps) {
  const { t } = useTranslation("workflows");
  const isStartNode = selectedNode.id === START_NODE_ID;
  const [expand, setExpand] = useState<ExpandState | null>(null);

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
                  { placeholder: 'echo "Hello ${{ params.name }}"' },
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
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                  placeholder: 'import json\nprint(json.dumps({"result": "hello"}))',
                  rows: 6,
                })}
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
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                  { placeholder: '{"Authorization": "Bearer ${{ secrets.KEY }}"}' },
                )}
                {renderBlockField(t("editor.api_body"), String(sd?.body ?? ""), (v) => updateNodeData({ body: v }), {
                  placeholder: '{"key": "value"}',
                })}
                <div className="wf-prop-field-block">
                  <label>{t("editor.outputs_title")}</label>
                  <OutputsEditor
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                    value={sd?.outputs as Record<string, OutputEntry> | undefined}
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
                        const filtered = keys.reduce<Record<string, string>>((acc, k) => {
                          if (inputValues?.[k]) acc[k] = inputValues[k];
                          return acc;
                        }, {});
                        const label = group === "advance" ? t("editor.group_advance") : t("editor.group_default");
                        return (
                          <CollapsibleGroup key={group} label={label} defaultOpen={!collapsed}>
                            <InputsEditor
                              value={filtered}
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
                        value={sd?.outputs as Record<string, OutputEntry> | undefined}
                        onChange={(val) => updateNodeData({ outputs: val })}
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
    </div>
  );
}
