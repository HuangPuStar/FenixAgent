import { cn } from "@fenix/ui-components/lib/cn";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Brain, Database, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { AgentResourcePicker } from "./AgentResourcePicker";
import { SECTION } from "./agent-editor-classes";
import { EditorStepperField, EditorTextarea, Field, Intro } from "./agent-editor-controls";
import { DEFAULT_NAMESPACES_TEXTAREA, RETRIEVAL_OPTIONS_FIELDS } from "./agent-editor-form-classes";
import {
  DEFAULT_NAMESPACES,
  KNOWLEDGE_BASES_PICKER,
  KNOWLEDGE_BLOCK,
  KNOWLEDGE_BODY,
  KNOWLEDGE_BODY_BASES,
  KNOWLEDGE_HEADING,
  KNOWLEDGE_LAYOUT,
  KNOWLEDGE_SWITCH,
  KNOWLEDGE_SWITCH_KNOB,
  KNOWLEDGE_SWITCH_KNOB_ON,
  KNOWLEDGE_SWITCH_ON,
  KNOWLEDGE_SWITCH_TRACK,
  KNOWLEDGE_SWITCH_TRACK_ON,
  RETRIEVAL_FIELDS,
  RETRIEVAL_OPTIONS,
} from "./agent-editor-library-classes";
import type { AgentEditorValues } from "./agent-editor-model";
import type { AgentEditorData } from "./use-agent-editor";

interface AgentKnowledgeSectionProps {
  form: UseFormReturn<AgentEditorValues>;
  data: AgentEditorData;
  disabled: boolean;
}

function KnowledgeBlock({
  icon,
  title,
  description,
  className,
  bodyClassName,
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(KNOWLEDGE_BLOCK, className)}>
      <header className={KNOWLEDGE_HEADING} data-slot="editor-knowledge-heading">
        <span>{icon}</span>
        <div>
          <strong>{title}</strong>
          <small>{description}</small>
        </div>
      </header>
      <div className={cn(KNOWLEDGE_BODY, bodyClassName)}>{children}</div>
    </div>
  );
}

function CompactSwitch({
  checked,
  onChange,
  title,
  description,
  badge,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  title: string;
  description: string;
  badge?: string;
  disabled: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(KNOWLEDGE_SWITCH, checked && KNOWLEDGE_SWITCH_ON)}
      data-on={checked ? "true" : undefined}
      onClick={() => onChange(!checked)}
    >
      <span>
        <strong>
          {title}
          {badge && <em>{badge}</em>}
        </strong>
        <small>{description}</small>
      </span>
      <i className={cn(KNOWLEDGE_SWITCH_TRACK, checked && KNOWLEDGE_SWITCH_TRACK_ON)} aria-hidden="true">
        <b className={cn(KNOWLEDGE_SWITCH_KNOB, checked && KNOWLEDGE_SWITCH_KNOB_ON)} />
      </i>
    </button>
  );
}

export function AgentKnowledgeSection({ form, data, disabled }: AgentKnowledgeSectionProps) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <section className={SECTION}>
      <Intro
        eyebrow="CONTEXT"
        title={t("editor.sections.knowledge")}
        description={t("editor.sectionDescriptions.knowledge")}
      />
      <div className={KNOWLEDGE_LAYOUT}>
        {data.hindsightEnabled && (
          <KnowledgeBlock icon={<Brain />} title={t("memory.enableTitle")} description={t("memory.enableDescription")}>
            <Controller
              name="enableMemory"
              control={form.control}
              render={({ field }) => (
                <CompactSwitch
                  checked={field.value}
                  onChange={field.onChange}
                  title={t("editor.memoryStatus")}
                  description={t("editor.memoryStatusDescription")}
                  badge="Hindsight"
                  disabled={disabled}
                />
              )}
            />
          </KnowledgeBlock>
        )}

        <KnowledgeBlock
          icon={<Database />}
          title={t("knowledge.bindTitle")}
          description={t("editor.knowledgeBaseDescription")}
          bodyClassName={KNOWLEDGE_BODY_BASES}
        >
          <Controller
            name="knowledgeBaseIds"
            control={form.control}
            render={({ field }) => (
              <AgentResourcePicker
                className={KNOWLEDGE_BASES_PICKER}
                label={t("knowledge.bindTitle")}
                options={data.knowledgeBases}
                value={field.value}
                onChange={field.onChange}
                readOnly={disabled}
              />
            )}
          />
        </KnowledgeBlock>

        <KnowledgeBlock
          icon={<Search />}
          title={t("editor.retrievalPolicy")}
          description={t("editor.retrievalPolicyDescription")}
        >
          <div className={RETRIEVAL_FIELDS}>
            <Field label={t("knowledge.defaultNamespaces")} hint={t("knowledge.defaultNamespacesDescription")}>
              <EditorTextarea
                className={cn(DEFAULT_NAMESPACES_TEXTAREA, DEFAULT_NAMESPACES)}
                id="agent-editor-default-namespaces"
                disabled={disabled}
                placeholder={t("knowledge.defaultNamespacesPlaceholder")}
                {...form.register("defaultNamespaces")}
              />
            </Field>
            <div className={cn(RETRIEVAL_OPTIONS, RETRIEVAL_OPTIONS_FIELDS)}>
              <Controller
                name="searchFirst"
                control={form.control}
                render={({ field }) => (
                  <CompactSwitch
                    checked={field.value}
                    onChange={field.onChange}
                    title={t("knowledge.searchFirst")}
                    description={t("editor.searchFirstDescription")}
                    badge={t("editor.recommended")}
                    disabled={disabled}
                  />
                )}
              />
              <Field label={t("knowledge.maxResults")}>
                <EditorStepperField
                  value={Number(form.watch("maxResults"))}
                  min={1}
                  max={20}
                  disabled={disabled}
                  decreaseLabel={t("editor.decreaseMaxResults")}
                  increaseLabel={t("editor.increaseMaxResults")}
                  onChange={(value) =>
                    form.setValue("maxResults", String(value), { shouldDirty: true, shouldValidate: true })
                  }
                />
              </Field>
            </div>
          </div>
        </KnowledgeBlock>
      </div>
    </section>
  );
}
