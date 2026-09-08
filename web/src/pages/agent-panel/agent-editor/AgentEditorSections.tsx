import { Cpu, Globe2, Info, Plug, Server, Sparkles } from "lucide-react";
import { lazy, Suspense, useId, useState } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { selectionToValue, valueToSelection } from "../../../lib/agent-node";
import { canManageAgentSharing } from "../../../lib/agent-resource-access";
import { AgentKnowledgeSection } from "./AgentKnowledgeSection";
import { AgentResourcePicker } from "./AgentResourcePicker";
import { EditorButton, EditorInput, EditorTextarea, Field, Intro, SinglePicker, Toggle } from "./agent-editor-controls";
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
const ModelIcon = lazy(() =>
  import("@/components/model-icon/ModelIcon").then((module) => ({ default: module.ModelIcon })),
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
    <section className="agent-editor-section">
      <Intro
        eyebrow="IDENTITY"
        title={t("editor.sections.identity")}
        description={t("editor.sectionDescriptions.identity")}
      />
      <div className="agent-editor-form-grid agent-editor-identity-fields">
        <Field
          className="agent-editor-field--name"
          label={t("form.name")}
          hint={mode === "edit" ? t("editor.nameImmutable") : undefined}
        >
          <EditorInput
            id="agent-editor-name"
            disabled={mode === "edit" || disabled}
            placeholder={t("form.namePlaceholder")}
            {...form.register("name")}
          />
        </Field>
        {mode === "edit" && data.agentId && (
          <Field className="agent-editor-field--agent-id" label={t("editor.agentId")} hint={t("editor.agentIdHint")}>
            <div className="agent-editor-agent-id-row">
              <EditorInput value={data.agentId} disabled />
              <EditorButton type="button" onClick={onCopy}>
                {t("editor.copy")}
              </EditorButton>
            </div>
          </Field>
        )}
        <Field className="agent-editor-field--description" label={t("form.description")}>
          <EditorInput
            id="agent-editor-description"
            disabled={disabled}
            placeholder={t("form.descriptionPlaceholder")}
            {...form.register("description")}
          />
        </Field>
        <Field
          className="agent-editor-field--prompt"
          label={t("form.prompt")}
          hint={t("editor.characterCount", { count: form.watch("prompt").length })}
        >
          <EditorTextarea
            id="agent-editor-prompt"
            className="agent-editor-prompt-editor"
            disabled={disabled}
            placeholder={t("form.promptPlaceholder")}
            {...form.register("prompt")}
          />
        </Field>
      </div>
      <p className="agent-editor-guidance">
        <Info />
        {t("editor.promptGuidance")}
      </p>
    </section>
  );
}
function Model({ form, data, disabled }: { form: Props["form"]; data: Props["data"]; disabled: boolean }) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <section className="agent-editor-section">
      <Intro eyebrow="MODEL" title={t("editor.sections.model")} description={t("editor.sectionDescriptions.model")} />
      <Controller
        name="modelId"
        control={form.control}
        render={({ field }) => (
          <SinglePicker
            options={data.models}
            value={field.value}
            onChange={field.onChange}
            label={t("form.model")}
            icon={Cpu}
            requireGroup
            renderIcon={(item) => (
              <Suspense fallback={<Cpu />}>
                <ModelIcon
                  modelId={item.iconKey}
                  size={20}
                  variant="mono"
                  className="agent-model-options__brand-icon"
                />
              </Suspense>
            )}
            disabled={disabled}
          />
        )}
      />
      <div className="agent-model-summary">
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
    <section className="agent-editor-section">
      <Intro
        eyebrow="CAPABILITIES"
        title={t("editor.sections.capabilities")}
        description={t("editor.sectionDescriptions.capabilities")}
      />
      <div className="agent-capability-tabs" role="tablist">
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
              className={kind === item ? "is-active" : ""}
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
    <section className="agent-editor-section">
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
      <div className="agent-runtime-note">
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
    mode === "create" || canManageAgentSharing({ name: form.watch("name"), resourceAccess: data.resourceAccess });
  return (
    <section className="agent-editor-section">
      <Intro
        eyebrow="ACCESS"
        title={t("editor.sections.sharing")}
        description={t("editor.sectionDescriptions.sharing")}
      />
      <div className="agent-owner-card">
        <span>{form.watch("name").slice(0, 1) || "A"}</span>
        <div>
          <small>{t("editor.resourceOwner")}</small>
          <strong>{data.resourceAccess?.sourceOrganizationName ?? t("editor.currentOrganization")}</strong>
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
      <div className="agent-access-preview">
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
