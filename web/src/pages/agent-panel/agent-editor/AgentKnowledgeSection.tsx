import { Brain, Database, Search } from "lucide-react";
import type { ReactNode } from "react";
import { Controller, type UseFormReturn } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { NS } from "../../../i18n";
import { AgentResourcePicker } from "./AgentResourcePicker";
import { EditorStepperField, EditorTextarea, Field, Intro } from "./agent-editor-controls";
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
  children,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`agent-knowledge-block${className ? ` ${className}` : ""}`}>
      <header className="agent-knowledge-block__heading">
        <span>{icon}</span>
        <div>
          <strong>{title}</strong>
          <small>{description}</small>
        </div>
      </header>
      <div className="agent-knowledge-block__body">{children}</div>
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
      className={`agent-knowledge-switch${checked ? " is-on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span>
        <strong>
          {title}
          {badge && <em>{badge}</em>}
        </strong>
        <small>{description}</small>
      </span>
      <i aria-hidden="true">
        <b />
      </i>
    </button>
  );
}

export function AgentKnowledgeSection({ form, data, disabled }: AgentKnowledgeSectionProps) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <section className="agent-editor-section">
      <Intro
        eyebrow="CONTEXT"
        title={t("editor.sections.knowledge")}
        description={t("editor.sectionDescriptions.knowledge")}
      />
      <div className="agent-knowledge-layout">
        {data.hindsightEnabled && (
          <KnowledgeBlock
            icon={<Brain />}
            title={t("memory.enableTitle")}
            description={t("memory.enableDescription")}
            className="agent-knowledge-block--memory"
          >
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
          className="agent-knowledge-block--bases"
        >
          <Controller
            name="knowledgeBaseIds"
            control={form.control}
            render={({ field }) => (
              <AgentResourcePicker
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
          className="agent-knowledge-block--retrieval"
        >
          <div className="agent-retrieval-fields">
            <Field label={t("knowledge.defaultNamespaces")} hint={t("knowledge.defaultNamespacesDescription")}>
              <EditorTextarea
                id="agent-editor-default-namespaces"
                disabled={disabled}
                placeholder={t("knowledge.defaultNamespacesPlaceholder")}
                {...form.register("defaultNamespaces")}
              />
            </Field>
            <div className="agent-retrieval-options">
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
