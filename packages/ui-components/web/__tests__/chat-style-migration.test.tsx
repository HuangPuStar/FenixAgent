// 样式迁移守卫测试（2026-09-22）：`@fenix/ui-components` chat 簇从手写 CSS + 语义类名
// 迁到 Tailwind 工具类后，锁定三件事：
//   1. 渲染结果里不再出现被迁移掉的语义类名（改用 `data-slot` / ARIA / role / 文本做锚点）；
//   2. 已迁空的样式表被真正删除（阶段二删除了 `chat-design-shell.css` 与 `chat-design-composer.css`）；
//   3. 剩余样式表只剩「无法迁移的最小片段」（`@keyframes`、必须控制非我方节点的透传规则），
//      已迁移的选择器不再回流。
//
// 与 `file-tree-view-slots.test.tsx` 同款口径：把「已删除的类名清单」显式写进测试，
// 让「顺手把语义钩子加回来」或「迁移回退」都能被这一层发现。

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ChatComposer } from "../chat/composer/ChatComposer";
import { CommandMenu } from "../chat/composer/CommandMenu";
import { ComposerAssets } from "../chat/composer/composer-assets";
import { AgentBadge, AgentBadgeSkeleton } from "../chat/shell/AgentBadge";
import { ChatHeader } from "../chat/shell/ChatHeader";
import { ChatView } from "../chat/view/ChatView";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

const CSS_DIR = join(import.meta.dir, "..", "chat", "css");

/**
 * 本轮迁移后不应再出现在 `class` 属性里的语义类名（源三个样式表的选择器）。
 *
 * 例外（仍在用，故不列入）：
 * - `acp-main-root` / `chat-main-column` / `chat-interface-column`：声明已迁成工具类，但类名保留为
 *   **其它样式表的作用域钩子**（宿主 `apps/web/src/index.css` 的 `.meta-agent-panel .acp-main-root`、
 *   包内 `web/chat/css/chat-layout.css` 与宿主同名文件的「唯一高度链」）——这些样式表不在本阶段范围；
 * - `chat-conversation`：同上，`chat-loading.css` 仍以 `:where(.chat-conversation)` 作用域化 shimmer；
 * - popover / inline 外壳与命令面板头部/底部（`chat-command-popover`、`chat-command-menu--popover`、
 *   `chat-command-menu--inline`、`chat-command-menu-header`、`chat-command-menu-title`、
 *   `chat-command-menu-count`、`chat-command-menu-footer`）：本仓库内没有渲染者，声明保留在
 *   `chat-design-command-menu.css`。
 */
const MIGRATED_CLASS_NAMES = [
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
  "chat-composer-wrapper",
  "chat-composer-divider",
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
function classTokens(html: string): string[] {
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
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function renderComposer(): string {
  return renderToStaticMarkup(
    createElement(ChatComposer, {
      onSubmit: () => {},
      commands: [{ name: "review", description: "Code review", input: { hint: "target" } }],
      mcps: [{ id: "fs", name: "Filesystem", description: "Read the workspace" }],
      supportsImages: true,
      modelName: "Claude Test",
      contextUsage: { totalTokens: 12_300, contextWindow: 200_000 },
      availableModes: [{ id: "bypass", name: "Bypass" }],
      currentModeId: "bypass",
      showNewSession: true,
      onNewSession: () => {},
    }),
  );
}

describe("chat 样式迁移：输入岛与命令面板", () => {
  // 输入岛（含能力面板与附件行）渲染后不应再带任何语义类名，且新锚点齐备。
  test("输入岛渲染结果不含已迁移的语义类名", () => {
    const html = renderComposer();
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    // 正向对照：锚点必须在，否则上面的「不含」会因组件整体缺失而恒真。
    for (const slot of [
      "chat-composer-plugin",
      "chat-composer-file",
      "chat-composer-model",
      "chat-composer-context",
      "chat-composer-meta-actions",
      "chat-composer-security-policy",
      "chat-composer-send",
    ]) {
      expect(html).toContain(`data-slot="${slot}"`);
    }
  });

  // 命令面板的三形态差异不能抹平：面板形态吃到密度覆盖，基础形态保持基类密度。
  test("命令面板面板形态与基础形态的密度覆盖都被保留", () => {
    const base = renderToStaticMarkup(
      createElement(CommandMenu, {
        commands: [{ name: "review", description: "Code review" }],
        filter: "",
        showSearch: true,
        onSelect: () => {},
        onClose: () => {},
      }),
    );
    const panel = renderToStaticMarkup(
      createElement(CommandMenu, {
        commands: [{ name: "review", description: "Code review" }],
        filter: "",
        showSearch: true,
        variant: "panel",
        onSelect: () => {},
        onClose: () => {},
      }),
    );

    // 基类密度：行高 42px、搜索行 46px、滚动区 322px。
    expect(base).toContain("min-h-[42px]");
    expect(base).toContain("h-[46px]");
    expect(base).toContain("h-[min(322px,46vh)]");
    // 面板覆盖：行高 34px、搜索行 38px、滚动区 210px、面板阴影。
    expect(panel).toContain("min-h-[34px]");
    expect(panel).toContain("h-[38px]");
    expect(panel).toContain("h-[min(210px,34vh)]");
    expect(panel).toContain("shadow-[0_5px_20px_rgb(41_58_88_/_5%)]");
    // 面板字号与行首图标灰（56e6b649 的效果）逐字保留。
    expect(panel).toContain("text-[12px]");
    expect(panel).toContain("text-[#8a96a8]");

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(classTokens(base)).not.toContain(name);
      expect(classTokens(panel)).not.toContain(name);
    }
  });

  // 附件行：引用卡与移除按钮的锚点在，语义类名不在（含 hover 才出现的移除按钮）。
  test("附件与引用资产使用锚点而非语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(ComposerAssets, {
        images: [{ mimeType: "image/png", data: "AAAA", url: "/x.png" }],
        files: [{ name: "index.ts", path: "src/index.ts" }],
        quotes: [{ id: "quote-1", text: "引用正文", omittedCharacterCount: 3 }],
        onRemoveImage: () => {},
        onRemoveFile: () => {},
        onRemoveQuote: () => {},
      }),
    );

    expect(html).toContain('data-slot="chat-composer-asset"');
    expect(html).toContain('data-slot="chat-composer-quote"');
    expect(html).toContain('data-slot="chat-composer-quote-preview"');
    for (const name of MIGRATED_CLASS_NAMES) {
      expect(classTokens(html)).not.toContain(name);
    }
  });
});

describe("chat 样式迁移：Agent 工牌卡", () => {
  // 工牌卡（含管理态与骨架态）不应再带语义类名，`data-badge-name` 水印契约保持不变。
  test("工牌卡渲染结果不含已迁移的语义类名", () => {
    const badge = renderToStaticMarkup(
      createElement(AgentBadge, {
        name: "Code Agent",
        description: "描述",
        skills: [{ id: "s1", label: "review" }],
        status: "running",
        onEnter: () => {},
        onEdit: () => {},
      }),
    );
    const skeleton = renderToStaticMarkup(createElement(AgentBadgeSkeleton));

    for (const html of [badge, skeleton]) {
      for (const name of MIGRATED_CLASS_NAMES) {
        expect(classTokens(html)).not.toContain(name);
      }
    }
    // 水印依赖 `data-badge-name` + `content: attr(...)`，契约必须保留；锚点供空状态用例断言。
    expect(badge).toContain('data-badge-name="Code Agent"');
    expect(badge).toContain('data-slot="agent-badge"');
    // 骨架屏动画：`@keyframes` 仍在 CSS，组件按名引用。
    expect(skeleton).toContain("animate-[agent-badge-pulse_2s_cubic-bezier(0.4,0,0.6,1)_infinite]");
  });
});

describe("chat 样式迁移：外壳与空状态", () => {
  // 顶部卡片：`chat-header-card` 类名已删除，独立渲染的玻璃形态与外壳内（ACP 子树）平面形态都由工具类表达。
  test("ChatHeader 卡片样式已内联为工具类", () => {
    const html = renderToStaticMarkup(createElement(ChatHeader, { activeSessionId: null, onSelectSession: () => {} }));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    // 玻璃形态（独立渲染）：半透明底 + blur + 圆角；外壳内形态：45px、直角、白底、单独底边。
    expect(tokens).toContain("backdrop-blur-[16px]");
    expect(tokens).toContain("[.acp-main-root_&]:h-[45px]");
    expect(tokens).toContain("[.acp-main-root_&:not(.dark_*)]:bg-white");
    expect(tokens).toContain("[.dark_&]:bg-[rgba(45,45,47,0.72)]");
    expect(tokens).toContain(
      "[@supports_not_((backdrop-filter:blur(16px))_or_(-webkit-backdrop-filter:blur(16px)))]:bg-[var(--color-surface-1)]",
    );
  });

  // 空状态与消息容器：语义类名换成 `data-slot` 锚点 + 工具类（选区判定与宿主测试都依赖锚点）。
  test("空状态与消息容器使用锚点与工具类", () => {
    const html = renderToStaticMarkup(createElement(ChatView, { entries: [] }));
    const tokens = classTokens(html);

    for (const name of MIGRATED_CLASS_NAMES) {
      expect(tokens).not.toContain(name);
    }
    expect(html).toContain('data-slot="chat-empty-state"');
    expect(html).toContain('data-slot="chat-empty-suggestions"');
    expect(html).toContain('data-slot="chat-conversation-content"');
  });
});

describe("chat 样式迁移：CSS 只剩文档化的最小片段", () => {
  // 阶段二已把 shell 片与 composer 残留片全部迁空，两个样式表必须真的删除（否则同一属性会有两个来源）。
  test("已迁空的样式表被删除", () => {
    expect(existsSync(join(CSS_DIR, "chat-design-shell.css"))).toBe(false);
    expect(existsSync(join(CSS_DIR, "chat-design-composer.css"))).toBe(false);
  });

  // 任何 chat 样式表里都不得回流已迁移的选择器（回流意味着同一属性有了两个来源）。
  test("已迁移的选择器不再出现在样式表里", () => {
    const commandMenuCss = withoutComments(readFileSync(join(CSS_DIR, "chat-design-command-menu.css"), "utf8"));
    const agentBadgeCss = withoutComments(readFileSync(join(CSS_DIR, "chat-agent-badge.css"), "utf8"));
    // 阶段二迁走的选择器：所属文件已删除，故对「全部仍在的样式表」做联合断言，防止被搬到别处复活。
    const survivorCss = [
      "chat.css",
      "chat-design-messages.css",
      "chat-design-tools.css",
      "chat-design-status.css",
      "chat-design-command-menu.css",
      "chat-design-selection.css",
      "chat-design-responsive.css",
      "chat-layout.css",
      "chat-loading.css",
      "chat-agent-badge.css",
    ]
      .filter((file) => existsSync(join(CSS_DIR, file)))
      .map((file) => withoutComments(readFileSync(join(CSS_DIR, file), "utf8")))
      .join("\n");

    for (const selector of [
      ".chat-composer-wrapper",
      ".chat-composer-card",
      ".chat-composer-meta",
      ".chat-composer-textarea",
      ".chat-composer-plugin",
      ".chat-composer-icon-button",
      ".chat-composer-context",
      ".chat-composer-model",
      ".chat-composer-security-policy",
      ".chat-composer-send",
      ".chat-composer-assets",
      ".chat-composer-asset",
      ".chat-composer-capabilities",
      ".chat-composer-new-session",
      ".chat-header-card",
      ".chat-composer-divider",
      ".chat-session-sidebar",
      ".chat-session-row",
      ".chat-conversation-content",
      ".chat-empty-state",
      ".chat-empty-mark",
      ".chat-empty-suggestions",
      ".chat-input-dock",
    ]) {
      expect(commandMenuCss).not.toContain(selector);
      expect(survivorCss).not.toContain(selector);
    }

    for (const selector of [
      ".chat-command-menu {",
      ".chat-command-menu--panel",
      ".chat-command-menu-search",
      ".chat-command-menu-input",
      ".chat-command-menu-scroll",
      ".chat-command-menu-list",
      ".chat-command-menu-item",
      ".chat-command-menu-name",
      ".chat-command-menu-description",
      ".chat-command-menu-tail",
      ".chat-command-menu-hint",
      ".chat-command-menu-empty",
      ".chat-command-menu-section",
      ".chat-command-menu-check",
      ".chat-command-menu-command-icon",
      ".chat-command-menu-mcp",
    ]) {
      expect(commandMenuCss).not.toContain(selector);
    }

    for (const selector of [".agent-badge", ".skill-tag"]) {
      expect(agentBadgeCss).not.toContain(selector);
    }
  });

  // 无法迁移的片段必须仍在（否则是静默丢失）：动画与「必须控制非我方节点」的透传规则。
  test("无法迁移的片段被原样保留", () => {
    const commandMenuCss = readFileSync(join(CSS_DIR, "chat-design-command-menu.css"), "utf8");
    const agentBadgeCss = readFileSync(join(CSS_DIR, "chat-agent-badge.css"), "utf8");

    expect(commandMenuCss).toContain(".chat-command-popover");
    expect(commandMenuCss).toContain(".chat-command-menu--inline");
    expect(commandMenuCss).toContain(".chat-command-menu-footer");
    expect(agentBadgeCss).toContain("@keyframes agent-badge-pulse");
    // 已迁移的声明不应借「残留」名义留在样式表里。
    expect(agentBadgeCss).not.toContain("stroke-width");
    expect(commandMenuCss).not.toContain("min-height: 34px");
  });

  // 窄屏适配里针对输入岛的两条已随类名删除而失效，阶段二必须删掉（否则是死规则）。
  test("responsive 表里已无输入岛的死规则", () => {
    const responsiveCss = withoutComments(readFileSync(join(CSS_DIR, "chat-design-responsive.css"), "utf8"));

    expect(responsiveCss).not.toContain(".chat-composer-wrapper");
    expect(responsiveCss).not.toContain(".chat-composer-context");
    // 状态面板簇的两条仍在（属后续阶段）。
    expect(responsiveCss).toContain(".chat-interaction-stack");
    expect(responsiveCss).toContain(".chat-status-tabs button span");
  });
});
