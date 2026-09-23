import { Textarea } from "@fenix/ui-components/ui/textarea";
import { useTranslation } from "react-i18next";
import type { CustomToolItem } from "../../../api/workflow-defs";
import type { ExpandState } from "./expand-field-dialog";
import { InputsEditor } from "./InputsEditor";
import { BlockField, CollapsibleGroup, InlineField } from "./node-config-fields";
import { groupInputDefs, resolveToolOutputs } from "./node-config-model";
import { type OutputEntry, OutputsEditor } from "./OutputsEditor";

/**
 * custom 工具节点的配置分区（含 Slurm 专属字段）。
 *
 * 单独一份而不并入其它分区：只有它按「工具的 input 声明」分组渲染输入、按 `produces` 预填 outputs，
 * 并且是唯一把 `onKeyRename` / `onBeforeDelete` 接到 outputs 编辑器上的节点类型——那两个回调会触发
 * 下游引用的确认弹窗（见 `use-node-output-ref-guard.ts`）。其余节点类型的 outputs 是自由填写，
 * 不存在「改了会破坏下游」的问题。
 */
export interface CustomToolSectionProps {
  readOnly: boolean;
  sd: Record<string, unknown> | undefined;
  updateNodeData: (patch: Record<string, unknown>) => void;
  customTools: CustomToolItem[];
  /** 输出字段改名前的下游引用确认（返回 false 表示用户取消） */
  onOutputRename: (oldKey: string, newKey: string) => Promise<boolean>;
  /** 输出字段删除前的下游引用确认（返回 false 表示用户取消） */
  onOutputDelete: (key: string) => Promise<boolean>;
  /** 交给卡片顶层的展开编辑弹窗（一张卡片一个实例） */
  onExpand: (state: ExpandState) => void;
}

export function CustomToolNodeFields({
  readOnly,
  sd,
  updateNodeData,
  customTools,
  onOutputRename,
  onOutputDelete,
  onExpand,
}: CustomToolSectionProps) {
  const { t } = useTranslation("workflows");

  const customTool = customTools.find((tool) => tool.name === sd?.tool);
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
      <InlineField label={t("editor.custom_tool")}>
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
      </InlineField>

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
          <InlineField label={t("editor.slurm_partition")}>
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
            />
          </InlineField>
          <InlineField label={t("editor.slurm_cores")}>
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
            />
          </InlineField>
          <InlineField label={t("editor.slurm_walltime")}>
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
            />
          </InlineField>
          <BlockField
            label={t("editor.slurm_modules")}
            value={
              Array.isArray((sd?.slurm as Record<string, unknown>)?.modules)
                ? ((sd?.slurm as Record<string, unknown>).modules as string[]).join("\n")
                : ""
            }
            onChange={(v) =>
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
              })
            }
            readOnly={readOnly}
            onExpand={onExpand}
            placeholder={t("editor.slurm_modules_placeholder")}
            rows={2}
          />
          {/* 脚本内容 — 核心：大段 bash 脚本，带展开按钮 */}
          <BlockField
            label={t("editor.slurm_script_content")}
            value={String((sd?.script as Record<string, unknown>)?.content ?? "")}
            onChange={(v) =>
              updateNodeData({
                script: { ...((sd?.script as Record<string, unknown>) ?? {}), content: v },
              })
            }
            readOnly={readOnly}
            onExpand={onExpand}
            rows={6}
          />
          {/* 脚本环境变量 */}
          <div className="wf-prop-field-block">
            <label>{t("editor.slurm_script_env")}</label>
            <p className="text-3xs text-gray-400 mb-1.5 leading-tight">{t("editor.slurm_env_hint")}</p>
            <Textarea
              value={(() => {
                const env = (sd?.script as Record<string, unknown>)?.env as Record<string, string> | undefined;
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
          <p className="text-3xs text-gray-400 mb-1.5 leading-tight">{t("editor.slurm_inputs_hint")}</p>
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
          value={resolveToolOutputs(sd?.outputs as Record<string, OutputEntry> | undefined, customTool)}
          onChange={(val) => updateNodeData({ outputs: val })}
          onKeyRename={onOutputRename}
          onBeforeDelete={onOutputDelete}
          readOnly={readOnly}
          keyPlaceholder={t("editor.outputs_key_placeholder")}
          patternPlaceholder={t("editor.outputs_pattern_placeholder")}
          addLabel={t("editor.outputs_add")}
        />
      </div>
    </>
  );
}
