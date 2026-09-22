/**
 * chat 样式迁移守卫的共享工具（阶段一至四通用）。
 *
 * 拆出本模块的原因：守卫用例按阶段拆成多个 `*.test.tsx`，i18n 实例、类名清单与解析工具只应有一份。
 *
 * 与 `file-tree-view-slots.test.tsx` 同款口径：把「已删除的类名清单」显式写进测试，
 * 让「顺手把语义钩子加回来」或「迁移回退」都能被这一层发现。
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "i18next";
import { renderToReadableStream } from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/** chat 样式表目录 / chat 组件根目录（供静态检查与源码级断言使用）。 */
export const CSS_DIR = join(import.meta.dir, "..", "chat", "css");
export const CHAT_DIR = join(import.meta.dir, "..", "chat");

/** 守卫用例共用的 i18next 实例（en 字典；`initReactI18next` 注册为默认实例）。 */
export const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/**
 * 迁移后不应再出现在 `class` 属性里的语义类名（阶段一至四各样式表的源选择器）。
 *
 * 例外（声明已迁成工具类，但**类名保留为其它样式表的作用域钩子**）：
 * - `acp-main-root` / `chat-main-column` / `chat-interface-column` / `chat-interface-root`：宿主
 *   `apps/web/src/index.css`、包内与宿主的 `chat-layout.css` 仍以它们作「唯一高度链」选择器——
 *   这两个样式表属后续阶段；移除条件见 `ACPMain` / `ChatInterface` 与 `chat.css` 的注释。
 * 阶段五起**没有命令面板形态的例外**：popover/inline 外壳（`chat-command-popover`、
 * `chat-command-menu--popover`、`chat-command-menu--inline`、`chat-command-menu-header`、
 * `chat-command-menu-title`、`chat-command-menu-count`、`chat-command-menu-footer`）经复核无渲染者、
 * 属死代码，随 `chat-design-command-menu.css` 整文件删除，其类名因此也进入下面的「不得回流」清单
 * （不得再出现在任何 chat 样式表或 JSX `className` 里）。
 *
 * 阶段四已解除的两条跨边界合约不再列入例外：`chat-activity-chain`（唯一外部引用方是工具片）、
 * `chat-conversation`（唯一外部引用方是加载片）都随本阶段迁移一并删除。
 */
export const MIGRATED_CLASS_NAMES = [
  "agent-badge",
  "agent-badge-action",
  "agent-badge-action-primary",
  "agent-badge-actions",
  "agent-badge-avatar",
  "agent-badge-body",
  "agent-badge-desc",
  "agent-badge-divider",
  "agent-badge-dot",
  "agent-badge-dots",
  "agent-badge-header",
  "agent-badge-name",
  "agent-badge-skeleton",
  "agent-badge-skeleton-circle",
  "agent-badge-skeleton-line",
  "agent-badge-skeleton-tag",
  "agent-badge-skills",
  "agent-badge-skills-hint",
  "agent-badge-skills-label",
  "agent-badge-skills-none",
  "agent-badge-skills-row",
  "agent-badge-source",
  "agent-badge-tag",
  "chat-command-menu",
  "chat-command-menu--panel",
  "chat-command-menu-check",
  "chat-command-menu-command-icon",
  "chat-command-menu-description",
  "chat-command-menu-empty",
  "chat-command-menu-hint",
  "chat-command-menu-input",
  "chat-command-menu-item",
  "chat-command-menu-list",
  "chat-command-menu-mcp",
  "chat-command-menu-mcp-icon",
  "chat-command-menu-mcp-state",
  "chat-command-menu-name",
  "chat-command-menu-scroll",
  "chat-command-menu-search",
  "chat-command-menu-section",
  "chat-command-menu-section-title",
  "chat-command-menu-tail",
  "chat-composer-asset",
  "chat-composer-asset-icon",
  "chat-composer-asset-remove",
  "chat-composer-assets",
  "chat-composer-capabilities",
  "chat-composer-card",
  "chat-composer-context",
  "chat-composer-file",
  "chat-composer-icon-button",
  "chat-composer-meta",
  "chat-composer-meta-actions",
  "chat-composer-meta-main",
  "chat-composer-model",
  "chat-composer-new-session",
  "chat-composer-plugin",
  "chat-composer-quote-preview",
  "chat-composer-security-policy",
  "chat-composer-send",
  "chat-composer-textarea",
  "chat-activity-chain",
  "chat-conversation",
  "chat-entry--active-prompt",
  "chat-interaction-icon",
  "chat-interaction-region",
  "chat-interaction-stack",
  "chat-loading-dots",
  "chat-permission-audit",
  "chat-permission-body",
  "chat-permission-copy",
  "chat-prompt-jump-index",
  "chat-prompt-jump-index__item",
  "chat-prompt-jump-index__list",
  "chat-prompt-jump-index__preview",
  "chat-prompt-jump-index__tick",
  "chat-question-body",
  "chat-question-copy",
  "chat-question-options",
  "chat-question-region",
  "chat-status-collapse",
  "chat-status-header",
  "chat-status-list",
  "chat-status-note",
  "chat-status-panel",
  "chat-status-tabs",
  "chat-tool-call-row",
  "chat-tool-call-row-details-button",
  "chat-tool-call-row-details-icon",
  "is-added",
  "is-cancelled",
  "is-collapsed",
  "is-error",
  "is-file-preview",
  "is-open",
  "is-running",
  "loading-text-shimmer",
  "tool-call-detail-code",
  "tool-call-group",
  "tool-call-group-list",
  "tool-call-group-summary",
  "tool-call-row-compact",
  "tool-call-row-copy",
  "tool-call-row-duration",
  "tool-call-row-end",
  "tool-call-row-error",
  "tool-call-row-file-link",
  "tool-call-row-heading",
  "tool-call-row-icon",
  "tool-call-row-meta",
  "tool-call-row-status",
  "tool-call-row-title",
  "chat-command-menu--inline",
  "chat-command-menu--popover",
  "chat-command-menu-count",
  "chat-command-menu-footer",
  "chat-command-menu-header",
  "chat-command-menu-title",
  "chat-command-popover",
  "chat-assistant-chunks",
  "chat-assistant-message",
  "chat-activity-chain--after-message",
  "chat-composer-wrapper",
  "chat-composer-divider",
  "chat-entry",
  "chat-entry--activity",
  "chat-entry--assistant",
  "chat-entry--tool-group",
  "chat-entry--user",
  "chat-markdown-content",
  "chat-markdown-response",
  "chat-markdown-response--rendered",
  "chat-message-actions",
  "chat-message-content",
  "chat-quote-message",
  "chat-quote-message-preview",
  "chat-quote-messages",
  "chat-scroll-navigation",
  "chat-scroll-to-latest",
  "chat-selection-action",
  "chat-system-reminder",
  "chat-thinking-block",
  "chat-thinking-content",
  "chat-thinking-trigger",
  "chat-user-bubble",
  "chat-user-message-content",
  "chat-user-message-frame",
  "message-bubble-enter",
  "is-active",
  "is-selected",
  "message-content",
  "chat-conversation-content",
  "chat-empty-mark",
  "chat-empty-state",
  "chat-empty-suggestions",
  "chat-header-card",
  "chat-input-dock",
  "chat-session-row",
  "chat-session-sidebar",
  "is-active",
  "is-mcp",
  "is-quote",
  "is-ready",
  "is-selected",
  "is-stop",
  "skill-tag",
  "skill-tag-static",
] as const;

/**
 * 抽取 SSR 结果里所有 `class` 属性的值，按空白切成 token 列表（逐个精确比对，避免子串误判）。
 *
 * React 会把属性值里的 `&` / `>` / `'` 等做 HTML 转义（如 `[.dark_&]:` → `[.dark_&amp;]:`），
 * 因此先还原实体再切分，否则带 `&` 的工具类断言会假失败。
 */
export function classTokens(html: string): string[] {
  return [...html.matchAll(/class="([^"]*)"/g)].flatMap((match) =>
    match[1]
      .replaceAll("&amp;", "&")
      .replaceAll("&gt;", ">")
      .replaceAll("&lt;", "<")
      .replaceAll("&quot;", '"')
      .replaceAll("&#x27;", "'")
      .split(/\s+/)
      .filter(Boolean),
  );
}

/** 去掉 CSS 注释：文件头会以说明文字引用源选择器，静态检查只能看真实声明。 */
export function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 读取某个 chat 样式表并去掉注释（文件头会以说明文字引用源选择器，静态检查只看真实声明）。 */
export function readChatCss(fileName: string): string {
  return withoutComments(readFileSync(join(CSS_DIR, fileName), "utf8"));
}

/** 流式渲染（`MessageResponse` 内部是 lazy(streamdown)，同步渲染只会拿到 Suspense 兜底）。 */
export async function renderStreaming(element: Parameters<typeof renderToReadableStream>[0]): Promise<string> {
  const stream = await renderToReadableStream(element);
  await stream.allReady;

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let markup = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    markup += decoder.decode(value, { stream: true });
  }
  return markup + decoder.decode();
}
