import {
  Brain,
  Check,
  ChevronRight,
  CircleDot,
  Cpu,
  Database,
  Layers3,
  Server,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import { type RefObject, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NS } from "../../../i18n";
import { selectionToValue } from "../../../lib/agent-node";
import { EditorPagination } from "./agent-editor-controls";
import {
  AGENT_EDITOR_PAGE_SIZE,
  type AgentEditorValues,
  type AgentTemplate,
  paginateAgentEditorOptions,
} from "./agent-editor-model";
import type { AgentEditorData } from "./use-agent-editor";

export function AgentEditorHeader({
  title,
  name,
  agentId,
  readOnly,
  showTemplate,
  templateTriggerRef,
  onTemplate,
  onClose,
}: {
  title: string;
  name: string;
  agentId: string | null;
  readOnly: boolean;
  showTemplate: boolean;
  templateTriggerRef: RefObject<HTMLButtonElement | null>;
  onTemplate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <header className="agent-editor-header">
      <div className="agent-editor-header-identity">
        <span className="agent-editor-avatar">
          <Sparkles />
        </span>
        <div className="min-w-0">
          <div className="agent-editor-title-row">
            <h2>{title}</h2>
            <em>{readOnly ? t("editor.readOnlyStatus") : t("editor.runningStatus")}</em>
          </div>
          <p>
            {name || t("editor.unnamedAgent")}
            {agentId && <code>{agentId}</code>}
          </p>
        </div>
      </div>
      <div className="agent-editor-header-actions">
        <div className="agent-editor-save-meta">
          <span>
            <CircleDot />
            {t("editor.runtimeInstances")}
          </span>
          <small>{t("editor.lastSaved")}</small>
        </div>
        {showTemplate && (
          <Button
            ref={templateTriggerRef}
            type="button"
            variant="outline"
            className="agent-editor-template-button"
            onClick={onTemplate}
          >
            <WandSparkles />
            {t("editor.buildFromTemplate")}
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="agent-editor-close"
          aria-label={t("editor.close")}
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
    </header>
  );
}

export function AgentTemplatePicker({
  templates,
  onApply,
  onClose,
}: {
  templates: AgentTemplate[];
  onApply: (template: AgentTemplate) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const filtered = templates.filter((template) =>
    `${template.name} ${template.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const paged = paginateAgentEditorOptions(filtered, page);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="agent-editor-template-picker max-w-xl">
        <div className="agent-editor-template-picker__header">
          <span>{t("editor.templatesEyebrow")}</span>
          <DialogTitle>{t("editor.templateTitle")}</DialogTitle>
          <DialogDescription>{t("editor.templateDescription")}</DialogDescription>
        </div>
        <div className="agent-editor-template-picker__search">
          <Input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            aria-label={t("editor.searchTemplates")}
            placeholder={t("editor.searchTemplates")}
          />
          <p role="status">{t("editor.resultCount", { count: filtered.length, total: templates.length })}</p>
        </div>
        <div className="agent-editor-template-picker__list">
          {filtered.length ? (
            paged.items.map((template) => (
              <button key={template.id} type="button" onClick={() => onApply(template)}>
                <strong>{template.name}</strong>
                <p>{template.description}</p>
                <span>{t("editor.templateSkillCount", { count: template.skills.length })}</span>
              </button>
            ))
          ) : (
            <p className="py-8 text-center text-sm text-text-muted">{t("editor.noMatchingResources")}</p>
          )}
        </div>
        <EditorPagination
          page={paged.page}
          pageSize={AGENT_EDITOR_PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
        />
      </DialogContent>
    </Dialog>
  );
}

export function AgentEditorSummary({
  values,
  data,
  onSectionChange,
}: {
  values: AgentEditorValues;
  data: AgentEditorData;
  onSectionChange: (section: "model" | "knowledge" | "capabilities" | "runtime") => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const model = data.models.find((option) => option.id === values.modelId);
  const node = data.nodes.find((option) => option.id === selectionToValue(values.agentNode));
  const cards = [
    {
      section: "model" as const,
      icon: <Cpu />,
      label: t("editor.summaryCoreModel"),
      value: model?.label ?? values.modelId ?? t("editor.notConfigured"),
      meta: model?.meta ?? t("editor.summaryModelMeta"),
    },
    {
      section: "knowledge" as const,
      icon: <Database />,
      label: t("editor.summaryContext"),
      value: t("editor.summaryKnowledgeCount", { count: values.knowledgeBaseIds.length }),
      meta: values.enableMemory ? t("editor.summaryMemoryEnabled") : t("editor.summaryMemoryDisabled"),
    },
    {
      section: "capabilities" as const,
      icon: <Layers3 />,
      label: t("editor.summaryCapabilities"),
      value: t("editor.summaryCapabilityCount", {
        skills: values.skillIds.length,
        mcps: values.mcpIds.length,
        sites: values.siteAppIds.length,
      }),
      meta: t("editor.summaryCapabilityMeta"),
    },
    {
      section: "runtime" as const,
      icon: <Server />,
      label: t("editor.summaryRuntime"),
      value: node?.label ?? t("editor.defaultRuntime"),
      meta: t("editor.summaryRuntimeMeta"),
    },
  ];
  return (
    <aside className="agent-editor-summary">
      <span className="agent-editor-summary-eyebrow">{t("editor.configurationOverview")}</span>
      <h3>{t("editor.summaryTitle")}</h3>
      <p>{t("editor.summaryDescription")}</p>
      <div className="agent-editor-summary-cards">
        {cards.map((card) => (
          <button type="button" key={card.label} onClick={() => onSectionChange(card.section)}>
            <span>{card.icon}</span>
            <div>
              <small>{card.label}</small>
              <strong title={card.value}>{card.value}</strong>
              <em>{card.meta}</em>
            </div>
            <ChevronRight />
          </button>
        ))}
      </div>
      <div className="agent-editor-summary-note">
        <Brain />
        <p>
          <strong>{t("editor.summaryHowItWorks")}</strong>
          {t("editor.summaryHowItWorksDescription")}
        </p>
      </div>
      <div className="agent-editor-summary-safety">
        <Check />
        {t("editor.summarySafety")}
      </div>
    </aside>
  );
}
