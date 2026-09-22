import { cn } from "@fenix/ui-components/lib/cn";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { NS } from "@fenix/web-runtime/i18n/namespace";
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
import { selectionToValue } from "../../../lib/agent-node";
import { EditorPagination } from "./agent-editor-controls";
import {
  AGENT_EDITOR_PAGE_SIZE,
  type AgentEditorValues,
  type AgentTemplate,
  paginateAgentEditorOptions,
} from "./agent-editor-model";
import type { AgentEditorData } from "./use-agent-editor";

/** 等宽眉标字体族：源 CSS 写明 `ui-monospace, SFMono-Regular, Menlo, monospace`，与主题 `--font-mono` 不等值，故用 arbitrary。 */
const EYEBROW_FONT = "[font-family:ui-monospace,SFMono-Regular,Menlo,monospace]";
/** 眉标（面板右栏 / 模板对话框）：design 层生效值为 750/8px/0.16em/#3470da。 */
const EYEBROW = `text-[8px] [font-weight:750] ${EYEBROW_FONT} tracking-[0.16em] text-[#3470da]`;
/** 面板头部：base(78px/22px/gap 22) 被 design(62px/14px/gap 14) 覆盖，移动端补 safe-area 上边距，760–700h 压到 58px。 */
const HEADER =
  "flex flex-none items-center justify-between gap-[14px] border-b border-[#e8edf4] bg-[rgb(255_255_255_/_95%)] " +
  "basis-[62px] min-h-[62px] py-0 pl-[18px] pr-[14px] " +
  "[@media(max-width:759px)]:pt-[max(12px,env(safe-area-inset-top))] " +
  "[@media(min-width:760px)_and_(max-height:700px)]:basis-[58px] " +
  "[@media(min-width:760px)_and_(max-height:700px)]:min-h-[58px]";
/** 头部「从模板创建」按钮：design 生效值（32px / 6px gap / 8px 圆角 / 13px / #3264bf on #f5f8ff），
 *  ≤759px 图标化（32px 宽、无内边距、字号归零）。挂在父 `<span class="contents">` 上，用子选择器压过 Button 自带工具类。 */
const TEMPLATE_TRIGGER =
  "[&>button]:!h-[32px] [&>button]:!gap-[6px] [&>button]:!rounded-lg [&>button]:!border-[#c9d8f1] " +
  "[&>button]:!bg-[#f5f8ff] [&>button]:!px-[10px] [&>button]:!text-[13px] [&>button]:!font-bold " +
  "[&>button]:!whitespace-nowrap [&>button]:!text-[#3264bf] " +
  "[&>button]:[&:hover]:!border-[#9eb9e8] [&>button]:[&:hover]:!bg-[#eaf1ff] [&>button]:[&:hover]:!text-[#2857ad] " +
  "[@media(max-width:759px)]:[&>button]:!w-[32px] [@media(max-width:759px)]:[&>button]:!p-0 " +
  "[@media(max-width:759px)]:[&>button]:text-[0px]";
/** 面板头部关闭按钮：34px / 10px 圆角 / #7b899f on 透明，hover 变 #234b97 on #f0f4fa。 */
const CLOSE_BUTTON =
  "!size-[34px] !rounded-[10px] !bg-transparent !text-[#7b899f] " + "[&:hover]:!bg-[#f0f4fa] [&:hover]:!text-[#234b97]";
/** 模板对话框：单个模板卡（design 层：白底 / 10px 圆角 / 11px×12px 内边距 / hover 变蓝）。 */
const TEMPLATE_CARD =
  "block w-full rounded-[10px] border border-[#e0e6ef] bg-[#fff] px-[12px] py-[11px] text-left text-[#53647e] " +
  "[&:hover]:border-[#a9c3f5] [&:hover]:bg-[#f9fbff] [&:hover]:text-[#1f55b7] " +
  "focus-visible:border-[#a9c3f5] focus-visible:bg-[#f9fbff] focus-visible:text-[#1f55b7] focus-visible:outline-0";
/** 汇总卡：design 层（72px 高 / 32px 图标列 / hover 左移 2px 并加深阴影）。 */
const SUMMARY_CARD =
  "grid w-full min-h-[72px] grid-cols-[32px_minmax(0,1fr)_12px] items-center gap-[10px] rounded-[11px] border " +
  "border-[#e0e7f0] bg-[rgb(255_255_255_/_94%)] px-[9px] py-[10px] text-left text-[#53637b] " +
  "shadow-[0_4px_14px_rgb(35_60_105_/_5%)] " +
  "transition-[border-color_140ms_ease,transform_140ms_ease,box-shadow_140ms_ease] " +
  "[&:hover]:-translate-x-[2px] [&:hover]:border-[#aac3ef] [&:hover]:shadow-[0_8px_20px_rgb(35_60_105_/_9%)] " +
  "[&>span]:grid [&>span]:size-8 [&>span]:place-items-center [&>span]:rounded-[9px] [&>span]:bg-[#eaf2ff] [&>span]:text-[#2f69d2] " +
  "[&>div]:flex [&>div]:min-w-0 [&>div]:flex-col [&>svg]:w-[11px] [&>svg]:text-[#a2adbd] " +
  "[@media(min-width:760px)_and_(max-width:1119px)]:min-h-[48px] [@media(min-width:760px)_and_(max-width:1119px)]:grid-cols-[24px_minmax(0,1fr)_10px] " +
  "[@media(min-width:760px)_and_(max-width:1119px)]:px-[7px] [@media(min-width:760px)_and_(max-width:1119px)]:py-[6px] " +
  "[@media(min-width:760px)_and_(max-width:1119px)]:[&>span]:size-6";

export function AgentEditorHeader({
  title,
  name,
  agentId,
  readOnly,
  loading = false,
  showTemplate,
  templateTriggerRef,
  onTemplate,
  onClose,
}: {
  title: string;
  name: string;
  agentId: string | null;
  readOnly: boolean;
  /** 加载壳复用同一头部：运行状态 pill 与保存说明先占位隐藏，避免加载态闪出另一套排版。 */
  loading?: boolean;
  showTemplate: boolean;
  templateTriggerRef: RefObject<HTMLButtonElement | null>;
  onTemplate: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  return (
    <header className={HEADER}>
      <div className="flex min-w-0 items-center gap-[9px]">
        <span className="grid size-[36px] flex-none basis-[36px] place-items-center overflow-hidden rounded-[10px] bg-[linear-gradient(145deg,#367cf1,#1749b3)] text-[#fff] shadow-[0_8px_20px_rgb(39_100_231_/_24%)] [&>svg]:w-[17px]">
          <Sparkles />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-[14px] [font-weight:720] text-[#18243d]" data-slot="editor-title">
              {title}
            </h2>
            {/* 状态 pill 的 color/background 源里引用未定义 token（--color-success），实际不生效，故只迁有效声明。 */}
            <em
              className={cn("rounded-full px-[6px] py-[2px] text-[10px] not-italic", loading && "invisible")}
              data-slot="editor-status-pill"
            >
              {readOnly ? t("editor.readOnlyStatus") : t("editor.runningStatus")}
            </em>
          </div>
          <p
            className="mt-[2px] flex items-center gap-[7px] overflow-hidden text-[11px] whitespace-nowrap text-[#5e6d85]"
            data-slot="editor-subtitle"
          >
            {name || t("editor.unnamedAgent")}
            {agentId && (
              <code className="overflow-hidden text-ellipsis [&::before]:mr-[7px] [&::before]:content-['·'] [@media(max-width:759px)]:hidden">
                {agentId}
              </code>
            )}
          </p>
        </div>
      </div>
      <div className="flex h-full items-center gap-2">
        <div className={cn("flex flex-col items-end gap-[3px] text-[11px] text-text-primary", loading && "invisible")}>
          <span className="flex items-center gap-[5px] text-[11px] [font-weight:650] text-[#34445e] [&>svg]:w-[10px] [&>svg]:text-[#16866f]">
            <CircleDot />
            {t("editor.runtimeInstances")}
          </span>
          <small className="text-[11px] text-[#96a1b2]">{t("editor.lastSaved")}</small>
        </div>
        {showTemplate && (
          // 锚点挂在 `display:contents` 的包装上：不改变 flex 布局，又不用覆盖 Button 自己的 `data-slot="button"`。
          <span className={TEMPLATE_TRIGGER} data-slot="editor-mobile-template">
            <Button ref={templateTriggerRef} type="button" variant="outline" onClick={onTemplate}>
              {/* `size-` 类会命中 Button 的 `[&_svg:not([class*='size-'])]:size-4` 排除条件，从而按 13px 渲染。 */}
              <WandSparkles className="size-[13px]" />
              {t("editor.buildFromTemplate")}
            </Button>
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={CLOSE_BUTTON}
          aria-label={t("editor.close")}
          onClick={onClose}
        >
          <X className="size-[17px]" />
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
      <DialogContent className="!gap-[14px] !border-[#dfe5ee] !bg-[#f7f9fc] !p-[20px] !shadow-[0_18px_48px_rgb(29_64_126_/_18%)] max-w-xl">
        <div
          className="[&>h2]:mt-[6px] [&>h2]:text-[17px] [&>h2]:tracking-[-0.025em] [&>h2]:text-[#17233b] [&>p]:mt-[6px] [&>p]:text-[12px] [&>p]:leading-[1.55] [&>p]:text-[#738098]"
          data-slot="editor-template-header"
        >
          <span className={EYEBROW}>{t("editor.templatesEyebrow")}</span>
          <DialogTitle>{t("editor.templateTitle")}</DialogTitle>
          <DialogDescription>{t("editor.templateDescription")}</DialogDescription>
        </div>
        <div className="[&>input]:!border-[#dce4ef] [&>input]:!bg-[#fff] [&>p]:mt-[6px] [&>p]:text-[11px] [&>p]:leading-[1.55] [&>p]:text-[#738098]">
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
        <div className="grid max-h-[320px] gap-[7px] overflow-y-auto overscroll-contain pr-[3px]">
          {filtered.length ? (
            paged.items.map((template) => (
              <button key={template.id} type="button" className={TEMPLATE_CARD} onClick={() => onApply(template)}>
                <strong className="text-[13px] text-[#31425d]">{template.name}</strong>
                <p className="mt-[4px] line-clamp-2 text-[11px] leading-[1.5] text-[#7e8ca1]">{template.description}</p>
                <span className="mt-[7px] block text-[10px] [font-weight:680] text-[#2764e7]">
                  {t("editor.templateSkillCount", { count: template.skills.length })}
                </span>
              </button>
            ))
          ) : (
            <p className="py-8 px-[12px] text-center text-[11px] text-[#8a97aa]" data-slot="editor-template-empty">
              {t("editor.noMatchingResources")}
            </p>
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
    <aside className="min-h-0 overflow-y-auto overscroll-contain border-l border-[#e5ebf3] bg-[#f7f9fc] bg-[radial-gradient(circle_at_90%_0%,rgb(50_108_221_/_8%),transparent_36%)] px-[12px] pb-[14px] pt-[16px] [@media(min-width:760px)_and_(max-width:1119px)]:block">
      <span className={EYEBROW} data-slot="editor-summary-eyebrow">
        {t("editor.configurationOverview")}
      </span>
      <h3
        className="mt-[7px] text-[18px] [font-weight:730] leading-[1.2] tracking-[-0.035em] text-[#17233b] [@media(min-width:760px)_and_(max-width:1399px)]:text-[16px]"
        data-slot="editor-summary-title"
      >
        {t("editor.summaryTitle")}
      </h3>
      <p className="mt-2 max-w-[590px] text-[12px] leading-[1.65] text-[#738098] [@media(min-width:760px)_and_(max-width:1119px)]:hidden">
        {t("editor.summaryDescription")}
      </p>
      <div className="mt-[10px] grid gap-2 [@media(min-width:760px)_and_(max-width:1119px)]:gap-[6px] [@media(min-width:760px)_and_(max-width:1119px)]:mt-2">
        {cards.map((card) => (
          <button type="button" key={card.label} className={SUMMARY_CARD} onClick={() => onSectionChange(card.section)}>
            <span>{card.icon}</span>
            <div>
              <small className="text-[11px] [font-weight:500] tracking-normal text-[#8996a9]">{card.label}</small>
              <strong
                className="mt-[2px] overflow-hidden text-ellipsis whitespace-nowrap text-[13px] [font-weight:680] leading-[1.35] text-[#32425a]"
                title={card.value}
              >
                {card.value}
              </strong>
              <em className="mt-[2px] line-clamp-2 text-[11px] leading-[1.35] text-[#8b97a8] not-italic [@media(min-width:760px)_and_(max-width:1119px)]:hidden">
                {card.meta}
              </em>
            </div>
            <ChevronRight />
          </button>
        ))}
      </div>
      {/* 便签的 background 引用未定义 token（--color-primary-subtle），实际透明，故只迁 color。 */}
      <div className="mt-[14px] flex gap-2 rounded-[10px] p-[10px] text-primary [&>svg]:w-[13px] [&>svg]:shrink-0 [@media(min-width:760px)_and_(max-width:1119px)]:hidden">
        <Brain />
        <p className="text-[11px] leading-[1.5] text-text-muted">
          <strong className="mb-[2px] block text-[13px] text-text-primary">{t("editor.summaryHowItWorks")}</strong>
          {t("editor.summaryHowItWorksDescription")}
        </p>
      </div>
      <div className="mt-[9px] flex items-center gap-[5px] text-[11px] text-text-muted [&>svg]:w-[10px] [@media(min-width:760px)_and_(max-width:1119px)]:hidden">
        <Check />
        {t("editor.summarySafety")}
      </div>
    </aside>
  );
}
