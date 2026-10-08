import "./AgentEditorChrome.css";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
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

/** 眉标（面板右栏 / 模板对话框）：design 层生效值为 750/8px/0.16em/#3470da。 */
const EYEBROW = "agent-editor-chrome-eyebrow font-mono text-3xs tracking-widest text-blue-500";
/** 面板头部：base(78px/22px/gap 22) 被 design(62px/14px/gap 14) 覆盖，移动端补 safe-area 上边距，760–700h 压到 58px。 */
const HEADER =
  "agent-editor-chrome-header flex flex-none items-center justify-between gap-3.5 border-b border-slate-200 bg-white/95 " +
  "basis-15.5 min-h-15.5 py-0 pl-4.5 pr-3.5";
/** 头部「从模板创建」按钮：design 生效值（32px / 6px gap / 8px 圆角 / 13px / #3264bf on #f5f8ff），
 * ≤759px 图标化（32px 宽、无内边距、字号归零）。深层按钮规则在同名 CSS 类中。 */
const TEMPLATE_TRIGGER = "agent-editor-chrome-template-trigger";
/** 面板头部关闭按钮：34px / 10px 圆角 / #7b899f on 透明，hover 变 #234b97 on #f0f4fa。
 *
 * 底色与文字色**刻意不带 `!`**：这两条的 hover 覆盖在伴随表的 `:hover` 规则里，而 important 声明的
 * 层序是反转的——未分层 important 优先级最低，恒输 `@layer utilities` 里的 ``!`` 工具类。基础若带 `!`
 * （源类串里 `!bg-transparent` / `!text-[#7b899f]` 是带的），hover 就永远不生效。
 * `variant="ghost"` 的基础串没有底色/文字色（只有 `hover:bg-accent`），去掉 `!` 在未 hover 态等价。
 * 该约束由 `agent-editor-font-scale.test.ts` 的「关闭按钮的基础底色/文字色不带 `!`」一条钉住。 */
const CLOSE_BUTTON = "agent-editor-chrome-close-button !size-8.5 !rounded-lg bg-transparent text-slate-500";
/** 模板对话框：单个模板卡（design 层：白底 / 10px 圆角 / 11px×12px 内边距 / hover 变蓝）。 */
const TEMPLATE_CARD =
  "agent-editor-template-card block w-full rounded-lg border border-slate-200 bg-white px-3 py-2.75 text-left text-gray-500 " +
  "focus-visible:border-indigo-300 focus-visible:bg-slate-50 focus-visible:text-blue-800 focus-visible:outline-0";
/** 汇总卡：design 层（72px 高 / 32px 图标列 / hover 左移 2px 并加深阴影）。
 * hover 位移 2026-09-28 从伴随表撤回（`-0.125rem` 在 13px 根字号下渲染 1.625px，`-translate-x-0.5` 即 2px
 * 设计值）；同行高亮 / 投影仍在同名 CSS，其 `transition` 已随属性改成 `translate`。 */
const SUMMARY_CARD =
  "agent-editor-summary-card grid w-full min-h-18 items-center gap-2.5 rounded-lg border " +
  "border-slate-200 bg-white/94 px-2.25 py-2.5 text-left text-slate-600 md:max-lg:min-h-12 " +
  "md:max-lg:px-1.75 md:max-lg:py-1.5 hover:-translate-x-0.5 hover:border-indigo-300";

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
      <div className="flex min-w-0 items-center gap-2.25">
        <span className="agent-editor-chrome-logo grid size-9 flex-none basis-9 place-items-center overflow-hidden rounded-lg text-white">
          <Sparkles className="w-4.25" />
        </span>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="agent-editor-chrome-title text-sm text-slate-800" data-slot="editor-title">
              {title}
            </h2>
            {/* 运行状态 pill 改用库内状态徽标：配色（含 dark 变体）与刻度归 `config/StatusBadge`，
                文案仍由本处经 `label` 注入 —— 库组件只收语义（色调），不绑定业务词表。
                原实现是 `<em>` + 手写药丸类，其 color/background 引用了未定义 token（--color-success）而
                实际无配色，一并被这次替换修掉（状态色从此只由 `tone` 决定）。 */}
            <StatusBadge
              status={readOnly ? "readOnly" : "running"}
              label={readOnly ? t("editor.readOnlyStatus") : t("editor.runningStatus")}
              tone={readOnly ? "neutral" : "success"}
              className={cn(loading && "invisible")}
            />
          </div>
          <p
            className="mt-0.5 flex items-center gap-1.75 overflow-hidden text-3xs whitespace-nowrap text-slate-500"
            data-slot="editor-subtitle"
          >
            {name || t("editor.unnamedAgent")}
            {agentId && (
              <code className="before:mr-1.75 before:content-['·'] overflow-hidden text-ellipsis max-md:hidden">
                {agentId}
              </code>
            )}
          </p>
        </div>
      </div>
      <div className="flex h-full items-center gap-2">
        <div className={cn("flex flex-col items-end gap-0.75 text-3xs text-text-primary", loading && "invisible")}>
          <span className="flex items-center gap-1.25 text-3xs [font-weight:650] text-slate-700">
            <CircleDot className="w-2.5 text-teal-700" />
            {t("editor.runtimeInstances")}
          </span>
          <small className="text-3xs text-gray-400">{t("editor.lastSaved")}</small>
        </div>
        {showTemplate && (
          // 锚点挂在 `display:contents` 的包装上：不改变 flex 布局，又不用覆盖 Button 自己的 `data-slot="button"`。
          <span className={TEMPLATE_TRIGGER} data-slot="editor-mobile-template">
            <Button ref={templateTriggerRef} type="button" variant="outline" onClick={onTemplate}>
              {/* `size-` 类会命中 Button 的 `[&_svg:not([class*='size-'])]:size-4` 排除条件，从而按 13px 渲染。 */}
              <WandSparkles className="size-3.25" />
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
          <X className="size-4.25" />
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
      <DialogContent className="agent-editor-template-dialog !gap-3.5 !border-slate-200 !bg-slate-50 !p-5 max-w-xl">
        <div data-slot="editor-template-header">
          <span className={EYEBROW}>{t("editor.templatesEyebrow")}</span>
          <DialogTitle className="mt-1.5 text-16 tracking-tight text-slate-800" data-slot="editor-template-title">
            {t("editor.templateTitle")}
          </DialogTitle>
          <DialogDescription
            className="mt-1.5 text-xs leading-normal text-slate-500"
            data-slot="editor-template-description"
          >
            {t("editor.templateDescription")}
          </DialogDescription>
        </div>
        <div>
          <Input
            className="border-slate-200 bg-white"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(0);
            }}
            aria-label={t("editor.searchTemplates")}
            placeholder={t("editor.searchTemplates")}
          />
          <p role="status" className="mt-1.5 text-3xs leading-normal text-slate-500">
            {t("editor.resultCount", { count: filtered.length, total: templates.length })}
          </p>
        </div>
        <div className="grid max-h-80 gap-1.75 overflow-y-auto overscroll-contain pr-0.75">
          {filtered.length ? (
            paged.items.map((template) => (
              <button key={template.id} type="button" className={TEMPLATE_CARD} onClick={() => onApply(template)}>
                <strong className="text-xs text-slate-700">{template.name}</strong>
                <p className="mt-1 line-clamp-2 text-3xs leading-normal text-slate-400">{template.description}</p>
                <span className="agent-editor-template-count mt-1.75 block text-3xs text-blue-600">
                  {t("editor.templateSkillCount", { count: template.skills.length })}
                </span>
              </button>
            ))
          ) : (
            <p className="py-8 px-3 text-center text-3xs text-gray-400" data-slot="editor-template-empty">
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
  // 右栏汇总**不带 `overscroll-contain`**：本栏在更长可滚祖先（管理页 `AppPage` 的 `main`）之内的常规流列，
  // 自身内容通常不溢出，带该类时滚轮被本列吃掉且不链式上溯（实测双向 0→0），面板顶部留在视口外时没法用
  // 滚轮把它滚回来。去掉后与同面板中栏 `CONTENT`、头部、页脚的既有实测行为一致；代价是被浮层遮住的管理页
  // 会随滚轮移动。机制、实测读数与取舍见 `agent-editor-classes.ts` 的 `CONFIG_MAP` 注记，
  // 结构守卫见 `__tests__/agent-editor-overscroll-chain.test.ts`。
  return (
    <aside className="agent-editor-summary-aside min-h-0 overflow-y-auto border-l border-slate-200 bg-slate-50 px-3 pb-3.5 pt-4 md:max-lg:block">
      <span className={EYEBROW} data-slot="editor-summary-eyebrow">
        {t("editor.configurationOverview")}
      </span>
      <h3
        className="agent-editor-summary-title mt-1.75 text-lg leading-tight tracking-tight text-slate-800 md:max-2xl:text-base"
        data-slot="editor-summary-title"
      >
        {t("editor.summaryTitle")}
      </h3>
      <p className="mt-2 max-w-147.5 text-xs leading-relaxed text-slate-500 md:max-lg:hidden">
        {t("editor.summaryDescription")}
      </p>
      <div className="mt-2.5 grid gap-2 md:max-lg:gap-1.5 md:max-lg:mt-2">
        {cards.map((card) => (
          <button type="button" key={card.label} className={SUMMARY_CARD} onClick={() => onSectionChange(card.section)}>
            <span className="grid size-8 place-items-center rounded-md bg-indigo-50 text-blue-600 max-md:size-6">
              {card.icon}
            </span>
            <div>
              {/* 卡片标题：10px/500。`font-weight: 500` 原在伴随 CSS 的 `.agent-editor-summary-card-label` 里，
                  是扁平类名 + 扁平值（伪深层），已换算成 `font-medium`（`--font-weight-medium: 500`，逐值等价），
                  语义类名随之删除——没有第二条声明需要它当钩子。 */}
              <small className="text-3xs font-medium tracking-normal text-gray-400">{card.label}</small>
              <strong
                className="agent-editor-summary-card-value mt-0.5 overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-snug text-slate-700"
                title={card.value}
              >
                {card.value}
              </strong>
              <em className="mt-0.5 line-clamp-2 text-3xs leading-snug text-gray-400 not-italic md:max-lg:hidden">
                {card.meta}
              </em>
            </div>
            <ChevronRight className="w-2.75 text-gray-400" />
          </button>
        ))}
      </div>
      {/* 便签的 background 引用未定义 token（--color-primary-subtle），实际透明，故只迁 color。 */}
      <div className="mt-3.5 flex gap-2 rounded-lg p-2.5 text-primary md:max-lg:hidden">
        <Brain className="w-3.25 shrink-0" />
        <p className="text-3xs leading-normal text-text-muted">
          <strong className="mb-0.5 block text-xs text-text-primary">{t("editor.summaryHowItWorks")}</strong>
          {t("editor.summaryHowItWorksDescription")}
        </p>
      </div>
      {/* `agent-editor-summary-safety` 语义类随 `<48rem` 之外最后一条规则（`> svg` 宽度）撤回而删除：
          宽度现在挂在图标自身的 `w-2.5`，类名已没有样式表定义，留着只是空钩子。 */}
      <div className="mt-2.25 flex items-center gap-1.25 text-3xs text-text-muted md:max-lg:hidden">
        <Check className="w-2.5" />
        {t("editor.summarySafety")}
      </div>
    </aside>
  );
}
