import { useTranslation } from "react-i18next";
import type { WfMeta } from "../yaml-utils";
import { InputsEditor } from "./InputsEditor";

/**
 * end 节点（工作流出口）的配置分区。
 *
 * 它不渲染在「节点配置」区块里，而是自带 `<div className="wf-prop-section">` 外壳——因为除了 inputs
 * 编辑器之外，它整块都在展示**对外契约**：外部调用方该怎么调这个工作流（端点、请求示例、响应示例、
 * 认证方式），示例里的 host / workflowId / 参数默认值都由当前编辑上下文拼出。这也是它唯一需要
 * `meta` 与 `workflowId` 的原因。
 */
export interface EndNodeSectionProps {
  readOnly: boolean;
  sd: Record<string, unknown> | undefined;
  updateNodeData: (patch: Record<string, unknown>) => void;
  meta: WfMeta;
  /** 当前编辑的工作流 ID，用于请求示例里的路径与调用方式展示 */
  workflowId?: string;
}

export function EndNodeSection({ readOnly, sd, updateNodeData, meta, workflowId }: EndNodeSectionProps) {
  const { t } = useTranslation("workflows");

  return (
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
        <pre style={{ fontSize: 11, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
          {(() => {
            const host = typeof window !== "undefined" ? window.location.origin : "";
            const paramsEntries = meta.params ? Object.entries(meta.params as Record<string, unknown>) : [];
            const _inputKeys = sd?.inputs ? Object.keys(sd.inputs as Record<string, unknown>) : [];
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
        <pre style={{ fontSize: 11, margin: 0, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
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
  );
}
