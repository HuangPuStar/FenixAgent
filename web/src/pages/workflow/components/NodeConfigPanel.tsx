import type { Node } from "@xyflow/react";
import { Lock, Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";
import { START_NODE_ID } from "../yaml-utils";

export interface NodeConfigPanelProps {
  readOnly: boolean;
  selectedNode: Node | null;
  sd: Record<string, unknown> | undefined;
  nodeType: string;
  handleIdChange: (newId: string) => void;
  setNodes: React.Dispatch<React.SetStateAction<Node[]>>;
  setSelectedNode: React.Dispatch<React.SetStateAction<Node | null>>;
  updateNodeData: (patch: Record<string, unknown>) => void;
  agentList: Array<{ name: string; description: string | null }>;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
}

function InputsEditor({
  value,
  onChange,
  readOnly,
  keyPlaceholder,
  valuePlaceholder,
  addLabel,
}: {
  value: Record<string, string> | undefined;
  onChange: (val: Record<string, string> | undefined) => void;
  readOnly: boolean;
  keyPlaceholder: string;
  valuePlaceholder: string;
  addLabel: string;
}) {
  const entries = Object.entries(value ?? {});

  const updateEntry = (index: number, field: "key" | "value", newValue: string) => {
    const updated = { ...value };
    const oldKey = entries[index][0];
    if (field === "key") {
      delete updated[oldKey];
      updated[newValue] = entries[index][1];
    } else {
      updated[oldKey] = newValue;
    }
    onChange(updated);
  };

  const removeEntry = (index: number) => {
    const updated = { ...value };
    delete updated[entries[index][0]];
    if (Object.keys(updated).length === 0) {
      onChange(undefined);
    } else {
      onChange(updated);
    }
  };

  const addEntry = () => {
    const updated = { ...value, "": "" };
    onChange(updated);
  };

  return (
    <div>
      {entries.map(([k, v], i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: index needed to keep input focus stable when key is being edited
        <div key={`${k}-${i}`} style={{ display: "flex", gap: 4, marginBottom: 4, alignItems: "center" }}>
          <input
            value={k}
            onChange={(e) => updateEntry(i, "key", e.target.value)}
            placeholder={keyPlaceholder}
            readOnly={readOnly}
            style={{ width: "30%" }}
          />
          <input
            value={v}
            onChange={(e) => updateEntry(i, "value", e.target.value)}
            placeholder={valuePlaceholder}
            readOnly={readOnly}
            style={{ flex: 1 }}
          />
          {!readOnly && (
            <button
              type="button"
              onClick={() => removeEntry(i)}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                border: "none",
                background: "none",
                color: "#9ca3af",
                cursor: "pointer",
                borderRadius: 4,
                padding: 0,
                flexShrink: 0,
              }}
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      {!readOnly && (
        <button
          type="button"
          onClick={addEntry}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            border: "none",
            background: "none",
            color: "#6b7280",
            cursor: "pointer",
            fontSize: 11,
            padding: 0,
          }}
        >
          <Plus size={12} /> {addLabel}
        </button>
      )}
    </div>
  );
}

export function NodeConfigPanel({
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
}: NodeConfigPanelProps) {
  const { t } = useTranslation("workflows");
  const isStartNode = selectedNode?.id === START_NODE_ID;

  return (
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
              <input value={selectedNode.id} onChange={(e) => handleIdChange(e.target.value)} readOnly={readOnly} />
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
                <option value="shell">{t("editor.type_shell")}</option>
                <option value="python">{t("editor.type_python")}</option>
                <option value="agent">{t("editor.type_agent")}</option>
                <option value="api">{t("editor.type_api")}</option>
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
                <div className="wf-prop-field">
                  <label>{t("editor.inputs_title")}</label>
                  <InputsEditor
                    value={sd?.inputs as Record<string, string> | undefined}
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.inputs_key_placeholder")}
                    valuePlaceholder={t("editor.inputs_value_placeholder")}
                    addLabel={t("editor.inputs_add")}
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
                <div className="wf-prop-field">
                  <label>{t("editor.inputs_title")}</label>
                  <InputsEditor
                    value={sd?.inputs as Record<string, string> | undefined}
                    onChange={(val) => {
                      const cleaned: Record<string, string> = {};
                      if (val) {
                        for (const [k, v] of Object.entries(val)) {
                          if (k.trim()) cleaned[k.trim()] = v;
                        }
                      }
                      updateNodeData({ inputs: Object.keys(cleaned).length ? cleaned : undefined });
                    }}
                    readOnly={readOnly}
                    keyPlaceholder={t("editor.inputs_key_placeholder")}
                    valuePlaceholder={t("editor.inputs_value_placeholder")}
                    addLabel={t("editor.inputs_add")}
                  />
                </div>
              </>
            )}

            {nodeType === "agent" && (
              <>
                <div className="wf-prop-field">
                  <label>{t("editor.agent_env")}</label>
                  <select
                    value={String(sd?.agent ?? "")}
                    onChange={(e) => updateNodeData({ agent: e.target.value || undefined })}
                    disabled={readOnly}
                  >
                    <option value="">{t("editor.agent_select_env")}</option>
                    {agentList.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                        {a.description ? ` - ${a.description}` : ""}
                      </option>
                    ))}
                  </select>
                </div>
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
                  <label>{t("editor.agent_output_messages")}</label>
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
                  />
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
              <input value={meta.name} onChange={(e) => updateMeta({ name: e.target.value })} readOnly={readOnly} />
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
  );
}
