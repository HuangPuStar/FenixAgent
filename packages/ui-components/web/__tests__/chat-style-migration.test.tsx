// 样式迁移守卫（阶段一：输入岛 / 命令面板 / 工牌卡）+ 跨阶段的 CSS 文件台账。
//
// 共享工具（i18n、已迁类名清单、解析函数）见 `./chat-style-migration-helpers`；
// 阶段二/三/四的用例分别在同目录的 `chat-style-migration-{shell,messages,status-tools}.test.tsx`。

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatComposer } from "../chat/composer/ChatComposer";
import { CommandMenu } from "../chat/composer/CommandMenu";
import { ComposerAssets } from "../chat/composer/composer-assets";
import { AgentBadge, AgentBadgeSkeleton } from "../chat/shell/AgentBadge";
import { CHAT_DIR, CSS_DIR, classTokens, MIGRATED_CLASS_NAMES, readChatCss } from "./chat-style-migration-helpers";

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

describe("chat 样式迁移：CSS 文件台账", () => {
  // 阶段一至四已迁空的样式表必须真的删除（否则同一属性会有两个来源）。
  test("已迁空的样式表被删除", () => {
    for (const file of [
      // 阶段二
      "chat-design-shell.css",
      "chat-design-composer.css",
      // 阶段三
      "chat-design-messages.css",
      "chat-design-selection.css",
      // 阶段四
      "chat-design-status.css",
      "chat-design-tools.css",
      "chat-navigation-aids.css",
      "chat-loading.css",
      "chat-design-responsive.css",
      // 阶段五（命令面板形态退役 + 工牌关键帧并入 chat-animations.css）
      "chat-design-command-menu.css",
      "chat-agent-badge.css",
    ]) {
      expect(existsSync(join(CSS_DIR, file))).toBe(false);
    }
    // 组件自导入的两片（阶段三删除）
    for (const file of ["primitives/conversation.css", "primitives/chat-message-content.css"]) {
      expect(existsSync(join(CHAT_DIR, file))).toBe(false);
    }
  });

  // 仍在的样式表不得回流已迁移的选择器（回流意味着同一属性有了两个来源）。
  test("已迁移的选择器不再出现在任何 chat 样式表里", () => {
    const allCss = readdirSync(CSS_DIR)
      .filter((file) => file.endsWith(".css"))
      .map((file) => readChatCss(file))
      .join("\n");

    for (const selector of [
      // 阶段一：输入岛
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
      // 阶段一：命令面板（未渲染外壳的残留除外，见本文件末条用例）
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
      // 阶段一：工牌卡
      ".agent-badge",
      ".skill-tag",
      // 阶段二：外壳片 / composer 残留片
      ".chat-header-card",
      ".chat-composer-divider",
      ".chat-session-sidebar",
      ".chat-session-row",
      ".chat-conversation-content",
      ".chat-empty-state",
      ".chat-empty-mark",
      ".chat-empty-suggestions",
      ".chat-input-dock",
      // 阶段三：消息簇
      ".chat-user-bubble",
      ".chat-user-message-frame",
      ".chat-user-message-content",
      ".chat-assistant-message",
      ".chat-assistant-chunks",
      ".chat-entry--activity",
      ".chat-thinking-trigger",
      ".chat-message-actions",
      ".chat-quote-message ",
      ".chat-system-reminder",
      ".chat-message-content",
      ".chat-markdown-content",
      ".chat-markdown-response",
      ".chat-selection-action",
      ".chat-scroll-to-latest",
      ".chat-scroll-navigation",
      // 阶段四：状态面板 / 工具时间线 / 提示词导航 / 加载指示 / 窄屏适配
      ".chat-interaction-stack",
      ".chat-interaction-region",
      ".chat-interaction-icon",
      ".chat-permission-body",
      ".chat-permission-copy",
      ".chat-permission-audit",
      ".chat-question-body",
      ".chat-question-copy",
      ".chat-question-options",
      ".chat-status-panel",
      ".chat-status-header",
      ".chat-status-tabs",
      ".chat-status-collapse",
      ".chat-status-list",
      ".chat-status-note",
      ".tool-call-group",
      ".tool-call-group-list",
      ".tool-call-group-summary",
      ".tool-call-row-compact",
      ".tool-call-row-icon",
      ".tool-call-row-copy",
      ".tool-call-row-heading",
      ".tool-call-row-title",
      ".tool-call-row-meta",
      ".tool-call-row-error",
      ".tool-call-row-end",
      ".tool-call-row-duration",
      ".tool-call-row-status",
      ".tool-call-row-file-link",
      ".tool-call-detail-code",
      ".chat-tool-call-row",
      ".chat-tool-call-row-details-button",
      ".chat-tool-call-row-details-icon",
      ".chat-prompt-jump-index",
      ".chat-entry--active-prompt",
      ".chat-loading-dots",
      ".loading-text-shimmer",
      ".chat-conversation",
      // 阶段五退役的命令面板三形态外壳（原 chat-design-command-menu.css）
      ".chat-command-popover",
      ".chat-command-menu--popover",
      ".chat-command-menu--inline",
      ".chat-command-menu-header",
      ".chat-command-menu-title",
      ".chat-command-menu-count",
      ".chat-command-menu-footer",
    ]) {
      expect(allCss).not.toContain(selector);
    }
  });

  // 无法迁移的片段必须仍在（否则是静默丢失）：包内唯一的关键帧文件里五个 `@keyframes` 一个都不能少。
  test("关键帧片段被原样保留", () => {
    const animations = readChatCss("chat-animations.css");

    for (const keyframes of [
      "loadingDotBounce",
      "loadingDotBounceDark",
      "shimmerSlide",
      "chat-active-prompt-flash",
      "agent-badge-pulse",
    ]) {
      expect(animations).toContain(`@keyframes ${keyframes}`);
    }
    // 已迁移的声明（例如工牌卡自身的尺寸/描边）不得借「关键帧」名义回流到本文件。
    expect(animations).not.toContain("stroke-width");
    expect(animations).not.toContain("border-radius");
  });

  // 关键帧合并后的两侧对齐：JSX 里按名引用的动画，必须在 chat-animations.css 里有同名 `@keyframes`
  // （改名只改一侧会让动画静默失效，这条用例就是那个接缝的守卫）。
  test("JSX 引用的动画名都能在关键帧文件里解析到", () => {
    const animations = readChatCss("chat-animations.css");
    const declared = new Set([...animations.matchAll(/@keyframes\s+([\w-]+)/g)].map((match) => match[1]));
    expect(declared.size).toBeGreaterThanOrEqual(5);

    const sources = ["view/ChatView.tsx", "view/chat-navigation-aids.tsx", "shell/AgentBadge.tsx"];
    const referenced = sources.flatMap((rel) =>
      [...readFileSync(join(CHAT_DIR, rel), "utf8").matchAll(/animate-\[([\w-]+?)[_\]]/g)].map((match) => match[1]),
    );

    expect(referenced.length).toBeGreaterThan(0);
    for (const name of new Set(referenced)) {
      expect(declared).toContain(name);
    }
  });

  // 阶段五退役的命令面板三形态不得回流：既不在任何 chat 样式表里，也不在 chat 组件的 className 里。
  test("已退役的命令面板形态不得回流", () => {
    const retired = [
      "chat-command-popover",
      "chat-command-menu--popover",
      "chat-command-menu--inline",
      "chat-command-menu-header",
      "chat-command-menu-title",
      "chat-command-menu-count",
      "chat-command-menu-footer",
    ];
    // 1) 样式表侧（任一存活分片）
    const allCss = readdirSync(CSS_DIR)
      .filter((file) => file.endsWith(".css"))
      .map((file) => readChatCss(file))
      .join("\n");
    for (const name of retired) {
      expect(allCss).not.toContain(`.${name}`);
    }
    // 2) JSX 侧：只看 `className=` 表达式（注释与 `data-slot` 值里出现不算）
    const classExpressions = readdirSync(join(CHAT_DIR, "composer"))
      .filter((file) => file.endsWith(".tsx"))
      .map((file) =>
        [...readFileSync(join(CHAT_DIR, "composer", file), "utf8").matchAll(/className=(?:"([^"]*)")/g)]
          .map((match) => match[1])
          .join(" "),
      )
      .join(" ");
    for (const name of retired) {
      expect(classExpressions).not.toContain(name);
    }
  });

  // 聚合入口的 @import 必须都指向存在的文件（本阶段删了 5 个分片，漏删会 404）。
  test("聚合入口的 @import 全部有效", () => {
    const chatCss = readChatCss("chat.css");
    const imports = [...chatCss.matchAll(/@import "\.\/([^"]+)"/g)].map((match) => match[1]);

    expect(imports.length).toBeGreaterThan(0);
    for (const file of imports) {
      expect(existsSync(join(CSS_DIR, file))).toBe(true);
    }
    for (const gone of [
      "chat-design-status.css",
      "chat-design-tools.css",
      "chat-navigation-aids.css",
      "chat-loading.css",
      "chat-design-responsive.css",
      "chat-design-messages.css",
      "chat-design-selection.css",
    ]) {
      expect(imports).not.toContain(gone);
    }
  });
});
