import { useTranslation } from "react-i18next";
import type { AgentNodeOption } from "../hooks/useWorkflowAgentOptions";
import type { ExpandState } from "./expand-field-dialog";
import { BlockField, InlineField } from "./node-config-fields";
import { getDisplayOutputs } from "./node-config-model";
import { type OutputEntry, OutputsEditor } from "./OutputsEditor";

/**
 * 对接外部资源 / 调度语义的节点（agent / api / audit / workflow / loop）的配置分区。
 *
 * 与脚本类分区的分界：这五类都要么读外部数据（agent 的环境列表、子工作流的 ref），要么描述调度行为
 * （HTTP 方法、审批时长、循环条件与次数），字段以「单行行内字段 + 输出声明」为主。
 */
export interface ResourceSectionProps {
  readOnly: boolean;
  sd: Record<string, unknown> | undefined;
  updateNodeData: (patch: Record<string, unknown>) => void;
  /** 交给卡片顶层的展开编辑弹窗（一张卡片一个实例） */
  onExpand: (state: ExpandState) => void;
}

/**
 * outputs 声明块（标题 + 编辑器）。
 *
 * 五处逐字相同：同一个 `getDisplayOutputs` 兜底口径（无声明即预填 stdout）配同一组字典键与只读位，
 * 且都在同一张卡片里同屏出现——抽成一处是为了让「输出的默认值与文案」只有一份定义，
 * 与 §4.8 里被裁定的 `NodeConfigPopover` / `NodeConfigSheet` / `NodeConfigCard` 三容器不同：
 * 那三者服务不同交互场景，这里是同一场景的同一块。
 */
function OutputsBlock({
  readOnly,
  sd,
  updateNodeData,
}: Pick<ResourceSectionProps, "readOnly" | "sd" | "updateNodeData">) {
  const { t } = useTranslation("workflows");

  return (
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
  );
}

export function AgentNodeFields({
  readOnly,
  sd,
  updateNodeData,
  onExpand,
  agentList,
}: ResourceSectionProps & { agentList: AgentNodeOption[] }) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <InlineField label={t("editor.agent_env")}>
        <select
          value={String(sd?.agent ?? "")}
          onChange={(e) => updateNodeData({ agent: e.target.value || undefined })}
          disabled={readOnly}
        >
          <option value="">{t("editor.agent_select_env")}</option>
          {agentList.map((a) => (
            <option key={a.envId} value={a.envName}>
              {a.envName} — {a.agentName}
              {a.instancesCount > 0 ? ` (${a.instancesCount})` : ""}
            </option>
          ))}
        </select>
      </InlineField>
      <BlockField
        label={t("editor.agent_prompt")}
        value={String(sd?.prompt ?? "")}
        onChange={(v) => updateNodeData({ prompt: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={t("editor.agent_prompt_placeholder")}
        rows={4}
      />
      <InlineField label={t("editor.agent_output_messages")}>
        <input
          type="number"
          min="0"
          max="100"
          value={sd?.output_messages != null ? String(sd.output_messages) : ""}
          onChange={(e) => updateNodeData({ output_messages: e.target.value ? Number(e.target.value) : undefined })}
          placeholder="0"
          readOnly={readOnly}
        />
      </InlineField>
      <OutputsBlock readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} />
    </>
  );
}

export function ApiNodeFields({ readOnly, sd, updateNodeData, onExpand }: ResourceSectionProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <InlineField label="URL">
        <input
          value={String(sd?.url ?? "")}
          onChange={(e) => updateNodeData({ url: e.target.value })}
          placeholder="https://api.example.com/data"
          readOnly={readOnly}
        />
      </InlineField>
      <InlineField label={t("editor.api_method")}>
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
      </InlineField>
      <BlockField
        label={t("editor.api_headers")}
        value={String(sd?.headers ?? "")}
        onChange={(v) => updateNodeData({ headers: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        // biome-ignore lint/suspicious/noTemplateCurlyInString: 工作流模板语法 ${{ }}
        placeholder={'{"Authorization": "Bearer ${{ secrets.KEY }}"}'}
      />
      <BlockField
        label={t("editor.api_body")}
        value={String(sd?.body ?? "")}
        onChange={(v) => updateNodeData({ body: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={'{"key": "value"}'}
      />
      <OutputsBlock readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} />
    </>
  );
}

export function AuditNodeFields({ readOnly, sd, updateNodeData }: ResourceSectionProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <InlineField label={t("editor.audit_message")}>
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
      </InlineField>
      <InlineField label={t("editor.audit_expires")}>
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
      </InlineField>
      <OutputsBlock readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} />
    </>
  );
}

export function WorkflowNodeFields({ readOnly, sd, updateNodeData }: ResourceSectionProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <InlineField label={t("editor.workflow_ref")}>
        <input
          value={String(sd?.ref ?? "")}
          onChange={(e) => updateNodeData({ ref: e.target.value })}
          placeholder="./sub-workflow.yaml"
          readOnly={readOnly}
        />
      </InlineField>
      <OutputsBlock readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} />
    </>
  );
}

export function LoopNodeFields({ readOnly, sd, updateNodeData }: ResourceSectionProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <InlineField label={t("editor.loop_condition")}>
        <input
          value={String(sd?.condition ?? "")}
          onChange={(e) => updateNodeData({ condition: e.target.value })}
          placeholder="{{ counter < 10 }}"
          readOnly={readOnly}
        />
      </InlineField>
      <InlineField label={t("editor.loop_max_iterations")}>
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
      </InlineField>
      <div className="wf-prop-hint" style={{ marginTop: 4 }}>
        <p>{t("editor.loop_body_hint")}</p>
      </div>
      <OutputsBlock readOnly={readOnly} sd={sd} updateNodeData={updateNodeData} />
    </>
  );
}
