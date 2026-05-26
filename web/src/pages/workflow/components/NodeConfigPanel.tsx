import type { Node } from "@xyflow/react";
import { ChevronRight, Lock } from "lucide-react";
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
  agentList: Array<{ name: string; model?: string | null; description?: string | null }>;
  agentOverrideOpen: boolean;
  setAgentOverrideOpen: (open: boolean) => void;
  meta: WfMeta;
  updateMeta: (updates: Partial<WfMeta>) => void;
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
  agentOverrideOpen,
  setAgentOverrideOpen,
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
                  {sd?.agent != null &&
                    (() => {
                      const found = agentList.find((a) => a.name === String(sd.agent));
                      if (!found) return null;
                      return (
                        <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2 }}>
                          {found.model && (
                            <span>
                              {t("editor.agent_model")}: {String(found.model)}
                            </span>
                          )}
                          {found.model && found.description && <span> · </span>}
                          {found.description && <span>{String(found.description)}</span>}
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
                          value={sd?.temperature != null ? String(sd.temperature) : ""}
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
                          value={sd?.steps != null ? String(sd.steps) : ""}
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
