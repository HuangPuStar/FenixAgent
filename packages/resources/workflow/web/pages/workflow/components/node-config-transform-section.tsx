import { useTranslation } from "react-i18next";
import { syncOutputOnRename } from "../preset-utils";
import { InputsEditor } from "./InputsEditor";

/**
 * transform 节点（数据变换）的配置分区。
 *
 * 与 shell / python 的 inputs+outputs 编辑器形似，但语义不同：transform 的 inputs 是取值表达式、
 * output 是产出字段名，且输出改名时要**同步下游对旧字段名的引用**（`syncOutputOnRename`），
 * 而脚本类节点的 outputs 改名走的是 `NodeConfigCard` 的下游引用确认弹窗。两处改名口径不同，
 * 所以这里单独一份，不与脚本类分区合并。
 */
export function TransformNodeFields({
  readOnly,
  sd,
  updateNodeData,
}: {
  readOnly: boolean;
  sd: Record<string, unknown> | undefined;
  updateNodeData: (patch: Record<string, unknown>) => void;
}) {
  const { t } = useTranslation("workflows");

  return (
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
  );
}
