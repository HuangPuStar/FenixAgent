import "./AgentEditorChrome.css";
import { StatusBadge } from "@fenix/ui-components/config/StatusBadge";
import { cn } from "@fenix/ui-components/lib/cn";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@fenix/ui-components/ui/alert-dialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Input } from "@fenix/ui-components/ui/input";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { CircleDot, Sparkles, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TEMPLATE_PANEL } from "./agent-editor-classes";
import { EditorPagination } from "./agent-editor-controls";
import { AGENT_EDITOR_PAGE_SIZE, type AgentTemplate, paginateAgentEditorOptions } from "./agent-editor-model";

/** 眉标（右栏模板面板）：design 层生效值为 750/8px/0.16em/#3470da。 */
const EYEBROW = "agent-editor-chrome-eyebrow font-mono text-3xs tracking-widest text-blue-500";
/** 面板头部：base(78px/22px/gap 22) 被 design(62px/14px/gap 14) 覆盖，移动端补 safe-area 上边距，760–700h 压到 58px。 */
const HEADER =
  "agent-editor-chrome-header flex flex-none items-center justify-between gap-3.5 border-b border-slate-200 bg-white/95 " +
  "basis-15.5 min-h-15.5 py-0 pl-4.5 pr-3.5";
/** 面板头部关闭按钮：34px / 10px 圆角 / #7b899f on 透明，hover 变 #234b97 on #f0f4fa。
 *
 * 底色与文字色**刻意不带 `!`**：这两条的 hover 覆盖在伴随表的 `:hover` 规则里，而 important 声明的
 * 层序是反转的——未分层 important 优先级最低，恒输 `@layer utilities` 里的 ``!`` 工具类。基础若带 `!`
 * （源类串里 `!bg-transparent` / `!text-[#7b899f]` 是带的），hover 就永远不生效。
 * `variant="ghost"` 的基础串没有底色/文字色（只有 `hover:bg-accent`），去掉 `!` 在未 hover 态等价。
 * 该约束由 `agent-editor-font-scale.test.ts` 的「关闭按钮的基础底色/文字色不带 `!`」一条钉住。 */
const CLOSE_BUTTON = "agent-editor-chrome-close-button !size-8.5 !rounded-lg bg-transparent text-slate-500";
/** 模板面板：单个模板卡（design 层：白底 / 10px 圆角 / 11px×12px 内边距 / hover 变蓝）。 */
const TEMPLATE_CARD =
  "agent-editor-template-card block w-full rounded-lg border border-slate-200 bg-white px-3 py-2.75 text-left text-gray-500 " +
  "focus-visible:border-indigo-300 focus-visible:bg-slate-50 focus-visible:text-blue-800 focus-visible:outline-0";

export function AgentEditorHeader({
  title,
  name,
  agentId,
  readOnly,
  loading = false,
  onClose,
}: {
  title: string;
  name: string;
  agentId: string | null;
  readOnly: boolean;
  /** 加载壳复用同一头部：运行状态 pill 与保存说明先占位隐藏，避免加载态闪出另一套排版。 */
  loading?: boolean;
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

/**
 * 模板面板：工作区右栏常驻的模板列表（2026-10-09 从「从模板构建」对话框改为常驻列，故不再有遮罩、
 * 关闭动作与焦点回还）。搜索、结果计数与分页原样保留；卡片点击先经确认弹窗（见下），应用后表单字段
 * 就地更新，反馈由页脚草稿态承担。是否渲染由调用方决定：只读态或无模板时整列不渲染，工作区随之回落
 * 两列（见 `agent-editor-classes.ts` 的 `NO_TEMPLATE_PANEL`）；列几何见同文件的 `TEMPLATE_PANEL`。
 */
export function AgentTemplatePanel({
  templates,
  onApply,
}: {
  templates: AgentTemplate[];
  onApply: (template: AgentTemplate) => void;
}) {
  const { t } = useTranslation(NS.AGENTS);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  /**
   * 待应用模板与弹窗开关**分离**：关闭时保留 `pending`——Radix 的关闭动画期间标题仍在渲染，
   * 清空会让「应用模板「X」？」闪成空名字；每次打开前必被覆盖，不存在脏读。
   */
  const [pending, setPending] = useState<AgentTemplate | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const filtered = templates.filter((template) =>
    `${template.name} ${template.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const paged = paginateAgentEditorOptions(filtered, page);
  return (
    <>
      <aside className={TEMPLATE_PANEL} aria-label={t("editor.templateTitle")}>
        <div data-slot="editor-template-header">
          <span className={EYEBROW} data-slot="editor-template-eyebrow">
            {t("editor.templatesEyebrow")}
          </span>
          {/* 原生 `<h3>` / `<p>`（原 `DialogTitle` / `DialogDescription`）：刻度不变，但不再经组件内的 `cn`
              合并——`text-16` 不在 tailwind-merge 的字号组里，与同一元素上的 `text-slate-800` 一起进 `cn`
              会被丢掉（`docs/design/issues/2026-09-28-web-style-closure-defects.md` §五.2）。 */}
          <h3
            className="mt-1.5 text-16 leading-none font-semibold tracking-tight text-slate-800"
            data-slot="editor-template-title"
          >
            {t("editor.templateTitle")}
          </h3>
          <p className="mt-1.5 text-xs leading-normal text-slate-500" data-slot="editor-template-description">
            {t("editor.templateDescription")}
          </p>
        </div>
        <div className="mt-3.5">
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
        {/* 列表不再自设高度：整列是滚动容器（`TEMPLATE_PANEL` 的 `overflow-y-auto`），嵌套滚动会让滚轮
            落在卡片上时吃掉一次滚动却不移动列表。 */}
        <div className="mt-2.5 grid gap-1.75">
          {filtered.length ? (
            paged.items.map((template) => (
              <button
                key={template.id}
                type="button"
                className={TEMPLATE_CARD}
                onClick={() => {
                  setPending(template);
                  setConfirmOpen(true);
                }}
              >
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
          className="mt-2.5"
          page={paged.page}
          pageSize={AGENT_EDITOR_PAGE_SIZE}
          total={filtered.length}
          onPageChange={setPage}
        />
      </aside>
      {/* 应用前确认：模板一次性替换 Prompt 与 Skills（创建态还替换名称），卡片点击不直接生效。
          确认按钮点击后由 Radix 自行关闭并触发 `onOpenChange`；取消按钮复用 `dialog.cancel`，
          描述复用面板顶部的 `templateDescription`（同一条替换规则，不复制同义键）。 */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("editor.applyTemplateTitle", { name: pending?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("editor.templateDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("dialog.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending) onApply(pending);
              }}
            >
              {t("editor.applyTemplateConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
