import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Cpu, Globe2, Info, Plug, Server, Sparkles } from "lucide-react";
import { lazy, Suspense, useId, useState } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { selectionToValue, valueToSelection } from "../../../lib/agent-node";
import { canManageAgentSharing } from "../../../lib/agent-resource-access";
import { AgentKnowledgeSection } from "./AgentKnowledgeSection";
import { AgentResourcePicker } from "./AgentResourcePicker";
import { SECTION } from "./agent-editor-classes";
import { EditorButton, EditorInput, EditorTextarea, Field, Intro, SinglePicker, Toggle } from "./agent-editor-controls";
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
        <Field label={t("form.name")} hint={mode === "edit" ? t("editor.nameImmutable") : undefined}>
          <EditorInput
            id="agent-editor-name"
            disabled={mode === "edit" || disabled}
            placeholder={t("form.namePlaceholder")}
            {...form.register("name")}
          />
        </Field>
        {mode === "edit" && data.agentId && (
          <Field
            className="[@media(max-width:759px)]:col-start-1"
            label={t("editor.agentId")}
            hint={t("editor.agentIdHint")}
          >
            <div className={AGENT_ID_ROW}>
              <EditorInput value={data.agentId} className={AGENT_ID_INPUT} disabled />
              <EditorButton type="button" className={AGENT_ID_BUTTON} onClick={onCopy}>
                {t("editor.copy")}
              </EditorButton>
            </div>
          </Field>
        )}
        <Field className="col-span-full" label={t("form.description")}>
          <EditorInput
            id="agent-editor-description"
            disabled={disabled}
            placeholder={t("form.descriptionPlaceholder")}
            {...form.register("description")}
          />
        </Field>
        <Field
          className="col-span-full"
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
        </Field>
      </div>
      <p className={GUIDANCE}>
        <Info />
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
              <Suspense fallback={<Cpu />}>
                <ModelIcon modelId={item.iconKey} size={20} variant="mono" />
              </Suspense>
            )}
            disabled={disabled}
          />
        )}
      />
      <div className={MODEL_SUMMARY}>
        <span>
          <Cpu />
        </span>
        <div>
          <small>{t("editor.activeModel")}</small>
          <strong>{data.models.find((item) => item.id === form.watch("modelId"))?.label}</strong>
          <p>{t("editor.modelRestartHint")}</p>
        </div>
      </div>
    </section>
  );
}
function Capabilities({ form, data, disabled }: { form: Props["form"]; data: Props["data"]; disabled: boolean }) {
  const { t } = useTranslation(NS.AGENTS);
  const [kind, setKind] = useState<keyof typeof capabilityIcons>("skills");
  const tabsId = useId();
  const config = {
    skills: ["skillIds", data.skills, t("skills.tabTitle"), "auto", Sparkles],
    mcp: ["mcpIds", data.mcps, t("mcps.tabTitle"), "auto", Plug],
    sites: ["siteAppIds", data.sites, t("sites.tabTitle"), "auto", Globe2],
  } as const;
  const tabs = Object.keys(config) as Array<keyof typeof config>;
  const [name, options, label, groupMode, ItemIcon] = config[kind];
  const tabId = (item: keyof typeof config) => `${tabsId}-tab-${item}`;
  const panelId = (item: keyof typeof config) => `${tabsId}-panel-${item}`;
  return (
    <section className={SECTION}>
      <Intro
        eyebrow="CAPABILITIES"
        title={t("editor.sections.capabilities")}
        description={t("editor.sectionDescriptions.capabilities")}
      />
      <div className={CAPABILITY_TABS} role="tablist">
        {tabs.map((item) => {
          const Icon = capabilityIcons[item];
          return (
            <button
              type="button"
              id={tabId(item)}
              role="tab"
              aria-selected={kind === item}
              aria-controls={panelId(item)}
              tabIndex={kind === item ? 0 : -1}
              data-active={kind === item ? "true" : undefined}
              key={item}
              onClick={() => setKind(item)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                const offset = event.key === "ArrowRight" ? 1 : -1;
                const next = tabs[(tabs.indexOf(item) + offset + tabs.length) % tabs.length];
                setKind(next);
                document.getElementById(tabId(next))?.focus();
              }}
            >
              <Icon />
              {config[item][2]}
              <span>{form.watch(config[item][0]).length}</span>
            </button>
          );
        })}
      </div>
      <div id={panelId(kind)} role="tabpanel" aria-labelledby={tabId(kind)}>
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
              renderIcon={() => <ItemIcon />}
            />
          )}
        />
      </div>
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
        <Server />
        <div>
          <strong>{t("editor.workspaceIsolationTitle")}</strong>
          <p>{t("editor.workspaceIsolationDescription")}</p>
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
        <span>{form.watch("name").slice(0, 1) || "A"}</span>
        <div>
          <small>{t("editor.resourceOwner")}</small>
          <strong>{data.organizationName ?? t("editor.currentOrganization")}</strong>
          <p>{manageable ? t("editor.sharingManageable") : t("editor.sharingNotManageable")}</p>
        </div>
        <em>{t("editor.owner")}</em>
      </div>
      <Controller
        name="publicReadable"
        control={form.control}
        render={({ field }) => (
          <Toggle
            checked={field.value}
            onChange={field.onChange}
            icon={<Globe2 />}
            title={t("resource.publicTitle")}
            description={manageable ? t("resource.publicDescription") : t("editor.sharingNotManageable")}
            disabled={disabled || !manageable}
          />
        )}
      />
      <div className={ACCESS_PREVIEW}>
        <strong>{t("editor.currentVisibility")}</strong>
        <div>
          <span>{t("editor.currentTeam")}</span>
          <i />
          <span>{form.watch("publicReadable") ? t("editor.organizationWide") : t("editor.currentTeamOnly")}</span>
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
