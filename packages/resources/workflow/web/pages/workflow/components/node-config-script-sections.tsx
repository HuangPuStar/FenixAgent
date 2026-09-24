import { useTranslation } from "react-i18next";
import type { ExpandState } from "./expand-field-dialog";
import { InputsEditor } from "./InputsEditor";
import { BlockField } from "./node-config-fields";
import { getDisplayOutputs } from "./node-config-model";
import { type OutputEntry, OutputsEditor } from "./OutputsEditor";

/**
 * 脚本类节点（shell / python）的配置分区。
 *
 * 两个类型的共同点是「一段被执行的文本 + inputs/outputs 编辑器」：shell 是命令与环境变量，
 * python 是代码、依赖与环境变量。它们都不依赖 agentList / customTools / workflowId 这些外部数据，
 * 只读写当前节点的 data，所以与其余分区（资源类 / 工具类 / 出口类）分开，改动时不必先看别处的取数。
 */
export interface ScriptSectionProps {
  readOnly: boolean;
  sd: Record<string, unknown> | undefined;
  updateNodeData: (patch: Record<string, unknown>) => void;
  /** 交给卡片顶层的展开编辑弹窗（一张卡片一个实例） */
  onExpand: (state: ExpandState) => void;
}

export function ShellNodeFields({ readOnly, sd, updateNodeData, onExpand }: ScriptSectionProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <BlockField
        label={t("editor.shell_command")}
        value={String(sd?.command ?? "")}
        onChange={(v) => updateNodeData({ command: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={'echo "Hello $name"'}
      />
      <div className="wf-prop-hint">{t("editor.shell_inputs_hint")}</div>
      <BlockField
        label={t("editor.shell_env")}
        value={String(sd?.env ?? "")}
        onChange={(v) => updateNodeData({ env: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={t("editor.shell_env_placeholder")}
        rows={2}
      />
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
  );
}

export function PythonNodeFields({ readOnly, sd, updateNodeData, onExpand }: ScriptSectionProps) {
  const { t } = useTranslation("workflows");

  return (
    <>
      <BlockField
        label={t("editor.python_code")}
        value={String(sd?.code ?? "")}
        onChange={(v) => updateNodeData({ code: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={
          'import os, json\nname = os.environ.get("name", "")\nprint(json.dumps({"result": f"Hello {name}"}))'
        }
        rows={6}
      />
      <div className="wf-prop-hint">{t("editor.python_inputs_hint")}</div>
      <BlockField
        label={t("editor.python_requirements")}
        value={
          Array.isArray(sd?.requirements) ? (sd.requirements as string[]).join("\n") : String(sd?.requirements ?? "")
        }
        onChange={(v) =>
          updateNodeData({
            requirements: v
              ? v
                  .split("\n")
                  .map((s: string) => s.trim())
                  .filter(Boolean)
              : undefined,
          })
        }
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={t("editor.python_requirements_placeholder")}
        rows={2}
      />
      <BlockField
        label={t("editor.shell_env")}
        value={String(sd?.env ?? "")}
        onChange={(v) => updateNodeData({ env: v })}
        readOnly={readOnly}
        onExpand={onExpand}
        placeholder={t("editor.shell_env_placeholder")}
        rows={2}
      />
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
  );
}
