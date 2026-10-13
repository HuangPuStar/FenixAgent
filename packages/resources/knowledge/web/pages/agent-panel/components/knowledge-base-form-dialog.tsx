// web/pages/agent-panel/components/knowledge-base-form-dialog.tsx
// 知识库**创建 / 编辑**弹窗：名称、描述，以及创建时才可见的解析配置区（嵌入模型 / 解析方法 /
// 分块方法 / Pipeline）。纯受控——字段值、校验与提交都在 `use-knowledge-base-catalog` 里。
//
// 从 `AgentKnowledgeBasesPage.tsx` 拆出（§4.7，表单与对话框按同包 `task/pages/agent-panel/components/`
// 的落位惯例集中到 `components/`）。两处判据随原样保留：嵌入模型按「供应商 → 实例」两级分组展示；
// 表单元数据拉取失败且无选项时，解析配置区整区让位给可重试的失败块。

import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { FormDialog } from "@fenix/ui-components/config/FormDialog";
import { Input } from "@fenix/ui-components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@fenix/ui-components/ui/select";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import type { ReactNode } from "react";
import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import type { KnowledgeFormOptions, KnowledgeParseMethod } from "../../../types/knowledge";
import { KnowledgeLoadFailure } from "../pages/agent-knowledge-load-failure";
import { FIELD_LABEL_CLASS } from "../pages/knowledge-typography";

interface KnowledgeBaseFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 编辑模式：只展示名称 / 描述，解析配置区整体隐藏（配置字段创建时已锁定） */
  editing: boolean;
  saving: boolean;
  name: string;
  onNameChange: (value: string) => void;
  description: string;
  onDescriptionChange: (value: string) => void;
  embeddingModel: string;
  onEmbeddingModelChange: (value: string) => void;
  parseMethod: KnowledgeParseMethod;
  onParseMethodChange: (value: KnowledgeParseMethod) => void;
  chunkMethod: string;
  onChunkMethodChange: (value: string) => void;
  pipeline: string;
  onPipelineChange: (value: string) => void;
  /** 表单元数据（嵌入模型 / 分块方法 / Pipeline 三个选项列表） */
  options: KnowledgeFormOptions | null;
  /** 选项拉取失败且无选项：解析配置区整区让位给失败块 */
  optionsFailed: boolean;
  optionsError: unknown;
  onRetryOptions: () => void;
  onSubmit: () => void;
}

export function KnowledgeBaseFormDialog(props: KnowledgeBaseFormDialogProps) {
  const { t } = useTranslation(NS.KNOWLEDGE);
  const { editing, options } = props;

  return (
    <FormDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={editing ? t("dialog.editTitle") : t("dialog.createTitle")}
      onSubmit={props.onSubmit}
      loading={props.saving}
    >
      <div className="space-y-4">
        {/* 名称 */}
        <FieldGroup required label={t("form.name")} hint={t("form.nameHint")}>
          <Input
            value={props.name}
            onChange={(e) => props.onNameChange(e.target.value)}
            placeholder={t("form.namePlaceholder")}
            autoFocus
            className="h-10"
          />
        </FieldGroup>

        {/* 描述 */}
        <FieldGroup label={t("form.description")} hint={t("form.descriptionHint")}>
          <Textarea
            value={props.description}
            onChange={(e) => props.onDescriptionChange(e.target.value)}
            placeholder={t("form.descriptionPlaceholder")}
            className="min-h-18 resize-none"
          />
        </FieldGroup>

        {/* 解析配置（仅创建模式） */}
        {!editing &&
          (props.optionsFailed ? (
            <KnowledgeLoadFailure
              error={props.optionsError}
              title={t("loadFailure.formOptions")}
              onRetry={props.onRetryOptions}
            />
          ) : (
            <>
              <p className="text-xs text-slate-400">{t("form.configLockedAfterCreate")}</p>

              {/* 嵌入模型 */}
              <FieldGroup label={t("form.embeddingModel")} hint={t("form.embeddingModelHint")} required>
                <Select
                  value={props.embeddingModel}
                  onValueChange={props.onEmbeddingModelChange}
                  disabled={(options?.embeddingModels?.length ?? 0) === 0}
                >
                  <SelectTrigger className="h-10 w-full">
                    <SelectValue placeholder={t("form.embeddingModelPlaceholder")} />
                  </SelectTrigger>
                  <SelectContent className="max-h-80">
                    {(() => {
                      const models = options?.embeddingModels ?? [];
                      const grouped = new Map<string, Map<string, typeof models>>();
                      for (const m of models) {
                        const prov = m.provider || "Unknown";
                        const inst = m.instance || "default";
                        if (!grouped.has(prov)) grouped.set(prov, new Map());
                        const instMap = grouped.get(prov)!;
                        if (!instMap.has(inst)) instMap.set(inst, []);
                        instMap.get(inst)!.push(m);
                      }
                      const providers = Array.from(grouped.entries());
                      return providers.length === 0 ? (
                        <EmptyState className="px-2 py-4" title={t("form.noEmbeddingModels")} />
                      ) : (
                        providers.map(([provider, instMap], providerIdx) => (
                          <SelectGroup key={provider}>
                            <SelectLabel
                              className={
                                "px-2 text-3xs font-semibold uppercase tracking-wider text-slate-500" +
                                (providerIdx > 0 ? " mt-1 border-t border-slate-100 pt-2.5" : "")
                              }
                            >
                              {provider}
                            </SelectLabel>
                            {Array.from(instMap.entries()).map(([instance, items]) => (
                              <Fragment key={instance}>
                                <SelectLabel className="pl-5 text-3xs font-medium text-slate-400">
                                  {instance}
                                </SelectLabel>
                                {items.map((m) => (
                                  <SelectItem key={m.name} value={m.name} className="pl-8 text-xs">
                                    {m.name.split("@")[0] || m.name}
                                  </SelectItem>
                                ))}
                              </Fragment>
                            ))}
                          </SelectGroup>
                        ))
                      );
                    })()}
                  </SelectContent>
                </Select>
              </FieldGroup>

              {/* 解析方法 */}
              <FieldGroup label={t("form.parseMethod")} hint={t("form.parseMethodHint")}>
                <div className="flex gap-6">
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md text-xs text-foreground select-none">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="builtin"
                      checked={props.parseMethod === "builtin"}
                      onChange={() => props.onParseMethodChange("builtin")}
                      className="h-4 w-4 accent-blue-500"
                    />
                    {t("form.parseMethodBuiltin")}
                  </label>
                  <label className="inline-flex cursor-pointer items-center gap-2 rounded-md text-xs text-foreground select-none">
                    <input
                      type="radio"
                      name="parseMethod"
                      value="pipeline"
                      checked={props.parseMethod === "pipeline"}
                      onChange={() => props.onParseMethodChange("pipeline")}
                      className="h-4 w-4 accent-blue-500"
                    />
                    {t("form.parseMethodPipeline")}
                  </label>
                </div>
              </FieldGroup>

              {/* 内置分块方法 */}
              {props.parseMethod === "builtin" && (
                <FieldGroup required label={t("form.chunkMethod")} hint={t("form.chunkMethodHint")}>
                  <Select value={props.chunkMethod} onValueChange={props.onChunkMethodChange}>
                    <SelectTrigger className="h-10 w-full">
                      <SelectValue placeholder={t("form.chunkMethodPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(options?.chunkMethods ?? []).map((c) => (
                        <SelectItem key={c.value} value={c.value}>
                          {c.label ?? t(c.labelKey ?? "")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </FieldGroup>
              )}

              {/* Pipeline 选择 */}
              {props.parseMethod === "pipeline" && (
                <FieldGroup label={t("form.pipeline")} hint={t("form.pipelineHint")}>
                  {(options?.pipelines?.length ?? 0) === 0 ? (
                    <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-5 shadow-sm">
                      <EmptyState
                        className="py-0"
                        title={t("form.noPipelines")}
                        description={t("form.noPipelinesHint")}
                      />
                    </div>
                  ) : (
                    <Select value={props.pipeline} onValueChange={props.onPipelineChange}>
                      <SelectTrigger className="h-10 w-full">
                        <SelectValue placeholder={t("form.pipelinePlaceholder")} />
                      </SelectTrigger>
                      <SelectContent>
                        {(options?.pipelines ?? []).map((p) => (
                          <SelectItem key={p.id} value={p.id}>
                            {p.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </FieldGroup>
              )}
            </>
          ))}
      </div>
    </FormDialog>
  );
}

/** 字段组：label + hint + children */
function FieldGroup({
  label,
  hint,
  required,
  icon,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  icon?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5">
        {icon && <span className="shrink-0 text-blue-500">{icon}</span>}
        <span className={FIELD_LABEL_CLASS}>{label}</span>
        {required && <span className="text-xs text-red-500">*</span>}
      </div>
      {hint && <p className="mb-2 text-xs leading-relaxed text-slate-400">{hint}</p>}
      {children}
    </div>
  );
}
