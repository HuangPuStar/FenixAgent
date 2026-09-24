// 样式迁移守卫（阶段四：状态面板 / 工具时间线 / 提示词导航 / 加载指示 / 窄屏适配）。
//
// 共享工具见 `./chat-style-migration-helpers`。

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatStatusPanel } from "../chat/panels/chat-status-panel";
import { PermissionPanel } from "../chat/panels/PermissionPanel";
import { QuestionPanel } from "../chat/panels/QuestionPanel";
import { ToolCallRow } from "../chat/timeline/ToolCallRow";
import type { ToolCallData, UserMessageEntry } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import { PromptJumpRail } from "../chat/view/chat-navigation-aids";
import { CHAT_DIR, classTokens, MIGRATED_CLASS_NAMES } from "./chat-style-migration-helpers";

const TOOL: ToolCallData = {
  id: "tool-1",
  title: "Read",
  kind: "read-file",
  status: "complete",
  rawInput: { file_path: "src/app.ts", offset: 68, limit: 140 },
  rawOutput: { count: 1 },
};

function toolRow(inActivityChain: boolean): string {
  return renderToStaticMarkup(createElement(ToolCallRow, { tool: TOOL, onPreviewFile: () => {}, inActivityChain }));
}

/** 读取 chat 组件自身的（非 `chat/css/` 聚合入口下的）样式表原文，供静态断言用。 */
function readChatSource(relPath: string): string {
  return readFileSync(join(CHAT_DIR, relPath), "utf8");
}

/** 断言一段渲染结果里没有任何已迁移的语义类名（逐 token 精确比对）。 */
function expectNoLegacyClasses(html: string): void {
  const tokens = classTokens(html);
  for (const name of MIGRATED_CLASS_NAMES) {
    expect(tokens).not.toContain(name);
  }
}

describe("chat 样式迁移：状态与交互面板", () => {
  // 权限卡片的半圆容器、头部按钮与 body 段落改由工具类表达，锚点齐备且语义类名清空。
  test("权限面板渲染结果不含已迁移的语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(PermissionPanel, {
        requests: [
          {
            requestId: "perm-1",
            toolName: "Bash",
            toolInput: { command: "ls" },
            description: "列出目录",
            options: [{ optionId: "allow", name: "允许", kind: "allow_once" }],
          },
        ],
      }),
    );

    expectNoLegacyClasses(html);
    expect(html).toContain('data-slot="chat-interaction-stack"');
    expect(html).toContain('data-slot="chat-permission-region"');
    // 宽度台阶（源 `.chat-interaction-stack`）与窄屏收窄（源 responsive 片）已下沉到 `panels/chat-interaction-region.css`
    // 的 `.chat-interaction-cards`（两条复合值），`className` 里只剩扁平的 `mx-auto`。
    expect(classTokens(html)).toContain("chat-interaction-cards");
    const interactionCss = readChatSource("panels/chat-interaction-region.css");
    expect(interactionCss).toContain("width: min(756px, calc(100% - 64px))");
    expect(interactionCss).toContain("@media (width < 48rem)");
    expect(interactionCss).toContain("width: calc(100% - 52px)");
  });

  // 提问面板：选项按钮的选中/未选中互斥两态、窄屏隐藏页签式文案都由工具类承担。
  test("提问面板渲染结果不含已迁移的语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(QuestionPanel, {
        questions: [
          {
            // 夹具按真实 `QuestionProjection` 对齐（2026-09-22）：原夹具写的是 `createdAt: 0` /
            // `expiresAt: 0` 并省略 `status` / `description` / `answer` —— 该形状在本包里不存在
            // （`createdAt` 全包零命中），是被测类型早已不含的字段。本用例只断言渲染出的类名，
            // 故补齐必填项即可，断言一条未动。
            questionId: "q-1",
            status: "pending",
            description: null,
            expiresAt: "2026-01-01T00:00:00.000Z",
            answer: null,
            questions: [
              {
                header: "范围",
                question: "补哪个入口？",
                multiSelect: false,
                options: [{ label: "补测试入口", description: "补一条用例" }],
              },
            ],
          },
        ],
      }),
    );

    expectNoLegacyClasses(html);
    expect(html).toContain('data-slot="chat-question-region"');
    // 未选中态：hover 变蓝底蓝字；选中态才带 `bg-blue-50 text-blue-700`（两态互斥，不靠生成顺序）。
    expect(html).toContain("hover:bg-blue-50 hover:text-blue-700");
    expect(html).not.toContain("bg-blue-50 text-blue-700");
  });

  // 状态面板：页签互斥两态、窄屏隐藏页签文字、行内状态色都由工具类表达。
  test("状态面板渲染结果不含已迁移的语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(ChatStatusPanel, {
        todos: [
          // `TodoItem.activeForm` 是 `string | undefined`（生产侧也只把字符串当有效值，见
          // `packages/web-runtime/web/chat/todo.ts` 的 `typeof item.activeForm === "string" ? … : undefined`），
          // 夹具原先写 `null` 与真实类型不符，改为「显式缺省」。
          { content: "检查待办", status: "completed", activeForm: undefined },
          { content: "进行中", status: "in_progress", activeForm: "在跑" },
        ],
        tasks: [
          {
            taskId: "task-1",
            title: "检查子任务",
            kind: "subagent",
            taskSubtype: null,
            summary: null,
            status: "failed",
            turnId: null,
            isBackground: false,
            startedAt: "2026-09-09T00:00:00.000Z",
            completedAt: null,
            updatedAt: "2026-09-09T00:00:00.000Z",
            detailAvailability: "unavailable",
          },
        ],
        tasksLoaded: true,
        changedFiles: [{ path: "src/app.ts", type: "write" }],
      }),
    );

    expectNoLegacyClasses(html);
    expect(html).toContain('data-slot="chat-status-panel"');
    expect(html).toContain('data-slot="chat-status-list"');
    // 页签：默认灰 / 选中蓝底蓝字（互斥两态）+ 窄屏隐藏文字。
    expect(html).toContain("bg-slate-100 text-sky-700");
    expect(html).toContain("max-md:hidden");
    // 行首状态色：completed → 绿、in_progress → 橙。
    expect(html).toContain("text-teal-600");
    expect(html).toContain("text-yellow-600");

    // 失败任务只在 tasks 页签下渲染（默认页签是 todo），故单独渲染一次断言红色状态色。
    const failedOnly = renderToStaticMarkup(
      createElement(ChatStatusPanel, {
        todos: [],
        tasks: [
          {
            taskId: "task-2",
            title: "失败任务",
            kind: "subagent",
            taskSubtype: null,
            summary: null,
            status: "failed",
            turnId: null,
            isBackground: false,
            startedAt: "2026-09-09T00:00:00.000Z",
            completedAt: null,
            updatedAt: "2026-09-09T00:00:00.000Z",
            detailAvailability: "unavailable",
          },
        ],
        tasksLoaded: true,
        changedFiles: [],
      }),
    );
    expect(failedOnly).toContain("text-red-400");
    expectNoLegacyClasses(failedOnly);

    // 变更文件行的「新增标绿」只在 changes 页签下渲染，而该页签默认折叠（组件既有行为），
    // SSR 触达不到那一支，故按源码级断言守住这两个互斥色值。
    const source = readFileSync(join(CHAT_DIR, "panels", "chat-status-panel.tsx"), "utf8");
    expect(source).toContain('"text-3xs text-emerald-600"');
    expect(source).toContain('"text-3xs text-gray-400"');
  });
});

describe("chat 样式迁移：工具时间线", () => {
  // 工具行：整行网格、行首图标、标题/详情/状态槽都由工具类承担，锚点齐备。
  test("工具行渲染结果不含已迁移的语义类名", () => {
    const html = toolRow(false);

    expectNoLegacyClasses(html);
    expect(html).toContain('data-slot="chat-tool-call-row"');
    expect(html).toContain('data-slot="chat-tool-call-file-link"');
    expect(html).toContain('data-slot="chat-tool-call-details-button"');
    // 行容器四种网格列与图标尺寸（源 `.chat-tool-call-row` / `.tool-call-row-icon`）已下沉到
    // `timeline/ToolCallRow.css`，`className` 里只留语义类名。
    const tokens = classTokens(html);
    expect(tokens).toContain("chat-tool-call-grid");
    expect(tokens).toContain("chat-tool-call-icon");
    // 文件链接态下 meta 槽的 `flex: 0 1 auto`（源 `.tool-call-row-meta` 的 file-preview 分支）。
    expect(tokens).toContain("chat-tool-call-meta-inline");
    const toolCss = readChatSource("timeline/ToolCallRow.css");
    expect(toolCss).toContain("grid-template-columns: 22px minmax(0, 1fr) auto auto");
    expect(toolCss).toContain("flex: 0 0 22px");
    expect(toolCss).toContain("width: calc(var(--spacing) * 3.75)");
  });

  // 活动链内的工具行左移 32px 抵消链的 pl-8（源 `.chat-activity-chain .tool-call-row-compact`）。
  test("活动链内的工具行带对齐补偿，链外不带", () => {
    expect(toolRow(true)).toContain("-ml-8");
    expect(toolRow(false)).not.toContain("-ml-8");
  });

  // 提示词导航轨：刻度与预览卡改为 beui 的 `PreviewRail` 原样渲染，本组件只剩浮层锚点与工具类。
  test("提示词导航渲染结果不含已迁移的语义类名", () => {
    const entries: UserMessageEntry[] = [
      { type: "user_message", id: "prompt-0", content: "第一条" },
      { type: "user_message", id: "prompt-1", content: "第二条" },
    ];
    const html = renderToStaticMarkup(createElement(PromptJumpRail, { entries }));

    expectNoLegacyClasses(html);
    // beui 的锚点（`data-slot` 与轨道/刻度类名都是它自带的，未改动）。
    expect(html).toContain('data-slot="preview-rail-item"');
    expect(html).toContain('data-slot="preview-rail-tick"');
    expect(html).toContain("w-12");
    expect(html).toContain("h-0.5");
    expect(html).toContain("origin-left");
    // 浮层定位只剩锚点这一条自定义类名（贴会话列左缘）。
    expect(classTokens(html)).toContain("chat-prompt-rail-anchor");
    // 宽屏媒体查询随替换作废：整轨窄屏也显示（注释里对旧查询的引用不算，先剥掉注释再断言）。
    const railCss = readChatSource("view/chat-navigation-aids.css").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(railCss).not.toContain("@media");
    expect(railCss).not.toContain(".chat-prompt-rail {");
    expect(railCss).not.toContain(".chat-prompt-preview");
  });

  // 导航轨浮层外壳不得吃指针事件，只有刻度轨可以。
  //
  // 为什么是硬约束：该浮层是消息滚动层的**兄弟**而非后代（`Conversation` 的两个子元素依次是它与滚动层），
  // 而它的宽度被 CSS `left: max(8px, calc(50% - 446px))` 与工具类 `right-4` 一起拉满成一条横向宽带
  // （1440×900 实测 1064×260px、垂直居中、`z-[8]`）。外壳一旦可命中，落在带内的滚轮就命中它，浏览器
  // 沿其祖先上溯找不到任何可滚动容器（`overflow-y-hidden` / `overflow: hidden`），整条带变成滚轮死区：
  // 实测消息区 `scrollTop 420` 时，带内 5 个落点 × 上下两向全部零位移，带外左侧 40px 处（命中消息正文）
  // 立刻 ±400；把外壳临时设为 `pointer-events: none` 后同一批落点全部恢复 ±400。
  // beui 的预览卡容器自带 `pointer-events-none` + `aria-hidden`（本就不可交互），无需在此放行。
  test("导航轨浮层外壳不吃指针事件，且只放行刻度轨", () => {
    const entries: UserMessageEntry[] = [
      { type: "user_message", id: "prompt-0", content: "第一条" },
      { type: "user_message", id: "prompt-1", content: "第二条" },
    ];
    const html = renderToStaticMarkup(createElement(PromptJumpRail, { entries }));

    // 先做元素级定位：两个元素都得在，否则下面的类断言在「元素压根没渲染」时也会通过。
    const anchorTag = html.match(/<div[^>]*chat-prompt-rail-anchor[^>]*>/)?.[0] ?? "";
    const railTag = html.match(/<nav[^>]*>/)?.[0] ?? "";
    expect(anchorTag).not.toBe("");
    expect(railTag).not.toBe("");

    expect(anchorTag).toContain("pointer-events-none");
    expect(railTag).toContain("pointer-events-auto");
  });
});

describe("chat 样式迁移：加载指示与窄屏适配", () => {
  // 加载指示不再依赖 `chat-conversation` 作用域，`chat-conversation` 类名随之删除。
  // 2026-09-24 改版：三点脉冲 + 文字微光换成「阶段文字 + 流光条」，动画只剩 `.chat-loading-beam`
  // 一条（扫光细节与阶段文案断言见 `chat-loading-indicator.test.tsx`）。
  test("加载指示改用工具类且会话容器不再带语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(ChatView, {
        entries: [{ type: "user_message", id: "u-1", content: "hi" }],
        isLoading: true,
      }),
    );

    expectNoLegacyClasses(html);
    // 动画已下沉到 `ChatView.css` 的 `.chat-loading-beam`；`className` 里只剩扁平工具类，
    // 故这里断言样式表契约与「不再出现已退役的旧类名」。
    const tokens = classTokens(html);
    expect(tokens).toContain("chat-loading-beam");
    expect(tokens).not.toContain("chat-loading-indicator");
    expect(tokens).not.toContain("chat-loading-shimmer");
    const chatViewCss = readChatSource("view/ChatView.css");
    expect(chatViewCss).toContain("animation: chat-loading-sweep 1.8s ease-in-out infinite");
    expect(chatViewCss).not.toContain("loadingDotBounce");
    expect(chatViewCss).not.toContain("chat-loading-shimmer");
  });

  // 两条旧跨边界合约已解除：类名不再出现在任何消费方的 `className` 里（源码级检查）。
  test("chat-activity-chain / chat-conversation 不再作为类名出现", () => {
    const sources = [
      "view/ChatView.tsx",
      "view/MessageBubble.tsx",
      "view/chat-navigation-aids.tsx",
      "primitives/conversation.tsx",
      "timeline/ToolCallRow.tsx",
      "timeline/ToolCallGroup.tsx",
    ];
    // 只看 `className=` 表达式里的类名（注释与 `data-slot` 值里出现不算）。
    const classExpressions = sources
      .flatMap((rel) => [
        ...readFileSync(join(CHAT_DIR, rel), "utf8").matchAll(
          /className=(?:"([^"]*)"|\{`([^`]*)`\}|\{cn\(([\s\S]*?)\)\})/g,
        ),
      ])
      .flatMap((match) => match.slice(1).filter((value): value is string => typeof value === "string"))
      .join(" ")
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");

    // 逐 token 精确比对：`classExpressions` 是拼接串，子串匹配会把新类的合法前缀（如
    // `chat-conversation-scroll-button`）误判成旧类名 `chat-conversation` 回流。
    const classTokensInSources = classExpressions.split(/\s+/).filter(Boolean);
    expect(classTokensInSources).not.toContain("chat-activity-chain");
    expect(classTokensInSources).not.toContain("chat-conversation");
    // 工具行改为按 `inActivityChain` 传参（属性名出现即说明替代写法在位）。
    expect(sources.map((rel) => readFileSync(join(CHAT_DIR, rel), "utf8")).join("\n")).toContain("inActivityChain");
  });
});
