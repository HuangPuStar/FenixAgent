import { LabeledField } from "@fenix/ui-components/config/LabeledField";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fenix/ui-components/ui/tabs";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Cpu, Globe2, Info, Plug, Server, Sparkles } from "lucide-react";
import { lazy, Suspense, useState } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { selectionToValue, valueToSelection } from "../../../lib/agent-node";
import { canManageAgentSharing } from "../../../lib/agent-resource-access";
import { AgentKnowledgeSection } from "./AgentKnowledgeSection";
import { AgentResourcePicker } from "./AgentResourcePicker";
import { SECTION } from "./agent-editor-classes";
import { EditorButton, EditorInput, EditorTextarea, Intro, SinglePicker, Toggle } from "./agent-editor-controls";
import {
  ACCESS_PREVIEW,
  AGENT_ID_BUTTON,
  AGENT_ID_INPUT,
  AGENT_ID_ROW,
  CAPABILITY_TABS,
  FORM_GRID,
  GUIDANCE,
  MODEL_SUMMARY,
  OWNER_CARD,
  PROMPT_EDITOR,
  RUNTIME_NOTE,
} from "./agent-editor-form-classes";
import type { AgentEditorValues } from "./agent-editor-model";
import type { AgentEditorData } from "./use-agent-editor";
export type AgentEditorSection = "identity" | "model" | "capabilities" | "knowledge" | "runtime" | "sharing";
type Props = {
  section: AgentEditorSection;
  form: UseFormReturn<AgentEditorValues>;
  data: AgentEditorData;
  mode: "create" | "edit";
  readOnly: boolean;
  onCopyAgentId: () => void;
};
// 模型品牌图标由 model-management 拥有：跨包相对路径会把对方内部目录变成事实契约
// （§2.3「不许穿透到另一个包的 src/**」），因此改走对方的包根 web 出口；懒加载保证
// `@lobehub/icons` 不进首屏，纯逻辑模块也不会间接加载它（CLAUDE.md 前端边界）。
const ModelIcon = lazy(() =>
  import("@fenix/model-management/web").then((module) => ({
    default: module.ModelIcon,
  })),
);

const capabilityIcons = { skills: Sparkles, mcp: Plug, sites: Globe2 } as const;
function Identity({
  form,
  data,
  mode,
  disabled,
  onCopy,
}: {
  form: Props["form"];
  data: Props["data"];
  mode: Props["mode"];
  disabled: boolean;
  onCopy: () => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <section className={SECTION}>
      <Intro
        eyebrow="IDENTITY"
        title={t("editor.sections.identity")}
        description={t("editor.sectionDescriptions.identity")}
      />
      <div className={FORM_GRID}>
        {/* 字段包装统一走 `config/LabeledField`：字段名刻度、6px 字段名/控件间距、提示的位置与配色
            都归库内，本处只留给 grid 定位用的 `min-w-0` + 列位类。 */}
        <LabeledField
          className="md:max-lg:col-start-1 min-w-0"
          label={t("form.name")}
          hint={mode === "edit" ? t("editor.nameImmutable") : undefined}
        >
          <EditorInput
            id="agent-editor-name"
            disabled={mode === "edit" || disabled}
            placeholder={t("form.namePlaceholder")}
            {...form.register("name")}
          />
        </LabeledField>
        {mode === "edit" && data.agentId && (
          // 这一行是复合控件（只读输入框 + 复制按钮）：`<label>` 里出现第二个可聚焦元素会污染控件的
          // 可访问名且是非法标记，故改走 `LabeledField` 的显式关联模式，由 `htmlFor` 指向主控件。
          <LabeledField
            className="md:max-lg:col-start-1 min-w-0 max-md:col-start-1"
            label={t("editor.agentId")}
            hint={t("editor.agentIdHint")}
            htmlFor="agent-editor-agent-id"
          >
            <div className={AGENT_ID_ROW}>
              <EditorInput id="agent-editor-agent-id" value={data.agentId} className={AGENT_ID_INPUT} disabled />
              <EditorButton type="button" className={AGENT_ID_BUTTON} onClick={onCopy}>
                {t("editor.copy")}
              </EditorButton>
            </div>
          </LabeledField>
        )}
        <LabeledField className="md:max-lg:col-start-1 min-w-0 col-span-full" label={t("form.description")}>
          <EditorInput
            id="agent-editor-description"
            disabled={disabled}
            placeholder={t("form.descriptionPlaceholder")}
            {...form.register("description")}
          />
        </LabeledField>
        <LabeledField
          className="md:max-lg:col-start-1 min-w-0 col-span-full"
          label={t("form.prompt")}
          hint={t("editor.characterCount", { count: form.watch("prompt").length })}
        >
          <EditorTextarea
            id="agent-editor-prompt"
            className={PROMPT_EDITOR}
            disabled={disabled}
            placeholder={t("form.promptPlaceholder")}
            {...form.register("prompt")}
          />
        </LabeledField>
      </div>
      <p className={GUIDANCE}>
        {/* 尺寸与色原本在 `.agent-editor-guidance > svg`（15px / `flex: none` / `basis` 15px / blue-500），
            第四波随该规则的删除搬到调用点。 */}
        <Info className="w-3.75 shrink-0 basis-3.75 text-blue-500" />
        {t("editor.promptGuidance")}
      </p>
    </section>
  );
}
function Model({ form, data, disabled }: { form: Props["form"]; data: Props["data"]; disabled: boolean }) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <section className={SECTION}>
      <Intro eyebrow="MODEL" title={t("editor.sections.model")} description={t("editor.sectionDescriptions.model")} />
      <Controller
        name="modelId"
        control={form.control}
        render={({ field, fieldState }) => (
          <SinglePicker
            options={data.models}
            value={field.value}
            onChange={field.onChange}
            label={t("form.model")}
            icon={Cpu}
            invalid={!!fieldState.error}
            errorMessage={t("form.modelValidationError")}
            requireGroup
            renderIcon={(item) => (
              // 18px 方形与 `shrink-0` 原在 `.agent-editor-option-icon > svg`（第四波随规则删除搬来）。
              <Suspense fallback={<Cpu className="size-4.5 shrink-0" />}>
                <ModelIcon modelId={item.iconKey} size={20} variant="mono" className="size-4.5 shrink-0" />
              </Suspense>
            )}
            disabled={disabled}
          />
        )}
      />
      <div className={MODEL_SUMMARY}>
        <span className="grid size-10 place-items-center rounded-lg bg-indigo-50 text-sky-600">
          <Cpu className="w-3.75" />
        </span>
        <div className="flex flex-col gap-0.5">
          <small className="text-3xs text-gray-400">{t("editor.activeModel")}</small>
          <strong className="text-sm text-slate-700">
            {data.models.find((item) => item.id === form.watch("modelId"))?.label}
          </strong>
          <p className="m-0 text-3xs leading-normal text-gray-400">{t("editor.modelRestartHint")}</p>
        </div>
      </div>
    </section>
  );
}
function Capabilities({ form, data, disabled }: { form: Props["form"]; data: Props["data"]; disabled: boolean }) {
  const { t } = useTranslation(NS.AGENTS);
  const [kind, setKind] = useState<keyof typeof capabilityIcons>("skills");
  const config = {
    skills: ["skillIds", data.skills, t("skills.tabTitle"), "auto", Sparkles],
    mcp: ["mcpIds", data.mcps, t("mcps.tabTitle"), "auto", Plug],
    sites: ["siteAppIds", data.sites, t("sites.tabTitle"), "auto", Globe2],
  } as const;
  const tabs = Object.keys(config) as Array<keyof typeof config>;
  const [name, options, label, groupMode, ItemIcon] = config[kind];
  return (
    <section className={SECTION}>
      <Intro
        eyebrow="CAPABILITIES"
        title={t("editor.sections.capabilities")}
        description={t("editor.sectionDescriptions.capabilities")}
      />
      {/* 三个能力页签改走 `ui/tabs`：`id` / `aria-controls` / `aria-labelledby` / `aria-selected`、
          左右方向键与 roving tabindex 原来都由本处手写维护，现在全部由 Radix 生成——语义与键盘行为
          逐条等价（原实现就是照这套契约手写的），少掉的只是自绘的 `data-active` 与下划线伪元素。

          注意本组件是**嵌套**在 `AgentFormDialog` 的 workspace `Tabs`（桌面为 `vertical`）里的：
          朝向相关的尺寸由库内 `TabsList` / `TabsTrigger` 自己的 `data-orientation` 锚定（见
          `ui/tabs.tsx` 的 `TabsOrientationContext`），否则外层的 vertical 变体会被 group 选择器
          穿透进来、把这里撑成竖排（实测高度 32.7px → 94.3px，下划线变成左侧竖条）。 */}
      <Tabs value={kind} onValueChange={(value) => setKind(value as keyof typeof capabilityIcons)}>
        <TabsList variant="line" className={CAPABILITY_TABS}>
          {tabs.map((item) => {
            const Icon = capabilityIcons[item];
            return (
              <TabsTrigger key={item} value={item}>
                <Icon />
                {config[item][2]}
                <Badge variant="secondary">{form.watch(config[item][0]).length}</Badge>
              </TabsTrigger>
            );
          })}
        </TabsList>
        <TabsContent value={kind}>
          <Controller
            name={name}
            control={form.control}
            render={({ field }) => (
              <AgentResourcePicker
                label={label}
                options={options}
                value={field.value}
                onChange={field.onChange}
                readOnly={disabled}
                groupMode={groupMode}
                renderIcon={() => (
                  // 14px 原在 `.agent-resource-picker-icon > svg`（第四波随规则删除搬到调用点）。
                  <ItemIcon className="w-3.5" />
                )}
              />
            )}
          />
        </TabsContent>
      </Tabs>
    </section>
  );
}
function Runtime({ form, data, disabled }: { form: Props["form"]; data: Props["data"]; disabled: boolean }) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <section className={SECTION}>
      <Intro
        eyebrow="RUNTIME"
        title={t("editor.sections.runtime")}
        description={t("editor.sectionDescriptions.runtime")}
      />
      <Controller
        name="agentNode"
        control={form.control}
        render={({ field }) => (
          <SinglePicker
            options={data.nodes}
            value={selectionToValue(field.value)}
            onChange={(value) => field.onChange(valueToSelection(value))}
            label={t("form.executionNode")}
            icon={Server}
            disabled={disabled}
          />
        )}
      />
      <div className={RUNTIME_NOTE}>
        <Server className="w-3.75 shrink-0 basis-3.75" />
        <div>
          <strong className="text-xs text-gray-600">{t("editor.workspaceIsolationTitle")}</strong>
          <p className="m-0 mt-1 text-3xs leading-normal">{t("editor.workspaceIsolationDescription")}</p>
        </div>
      </div>
    </section>
  );
}
function Sharing({
  form,
  data,
  mode,
  disabled,
}: {
  form: Props["form"];
  data: Props["data"];
  mode: Props["mode"];
  disabled: boolean;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const manageable =
    mode === "create" || canManageAgentSharing({ name: form.watch("name"), scope: data.scope, access: data.access });
  return (
    <section className={SECTION}>
      <Intro
        eyebrow="ACCESS"
        title={t("editor.sections.sharing")}
        description={t("editor.sectionDescriptions.sharing")}
      />
      <div className={OWNER_CARD}>
        <span className="grid size-10.5 place-items-center rounded-xl text-xs text-white">
          {form.watch("name").slice(0, 1) || "A"}
        </span>
        <div className="flex min-w-0 flex-col gap-0.75">
          <small className="text-3xs text-gray-400">{t("editor.resourceOwner")}</small>
          <strong className="text-xs text-slate-700">{data.organizationName ?? t("editor.currentOrganization")}</strong>
          <p className="m-0 text-3xs text-gray-400">
            {manageable ? t("editor.sharingManageable") : t("editor.sharingNotManageable")}
          </p>
        </div>
        <Badge variant="secondary">{t("editor.owner")}</Badge>
      </div>
      <Controller
        name="publicReadable"
        control={form.control}
        render={({ field }) => (
          <Toggle
            checked={field.value}
            onChange={field.onChange}
            icon={<Globe2 className="w-3.75" />}
            title={t("resource.publicTitle")}
            description={manageable ? t("resource.publicDescription") : t("editor.sharingNotManageable")}
            disabled={disabled || !manageable}
          />
        )}
      />
      <div className={ACCESS_PREVIEW}>
        <strong className="text-3xs text-gray-500">{t("editor.currentVisibility")}</strong>
        <div className="my-2 mx-0 flex items-center gap-2.25">
          <span className="rounded-md bg-white px-2.25 py-1.5 text-xs text-slate-600">{t("editor.currentTeam")}</span>
          <i className="h-0.25 w-6 bg-slate-300" />
          <span className="rounded-md bg-white px-2.25 py-1.5 text-xs text-slate-600">
            {form.watch("publicReadable") ? t("editor.organizationWide") : t("editor.currentTeamOnly")}
          </span>
        </div>
      </div>
    </section>
  );
}
export function AgentEditorSections(props: Props) {
  const disabled = props.readOnly;
  switch (props.section) {
    case "identity":
      return (
        <Identity
          form={props.form}
          data={props.data}
          mode={props.mode}
          disabled={disabled}
          onCopy={props.onCopyAgentId}
        />
      );
    case "model":
      return <Model form={props.form} data={props.data} disabled={disabled} />;
    case "capabilities":
      return <Capabilities form={props.form} data={props.data} disabled={disabled} />;
    case "knowledge":
      return <AgentKnowledgeSection form={props.form} data={props.data} disabled={disabled} />;
    case "runtime":
      return <Runtime form={props.form} data={props.data} disabled={disabled} />;
    case "sharing":
      return <Sharing form={props.form} data={props.data} mode={props.mode} disabled={disabled} />;
  }
}
