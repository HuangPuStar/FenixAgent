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
    // 宽度台阶（源 `.chat-interaction-stack`）与窄屏收窄（源 responsive 片）都在。
    expect(html).toContain("w-[min(756px,calc(100%-64px))]");
    expect(html).toContain("[@media(max-width:720px)]:w-[calc(100%-52px)]");
  });

  // 提问面板：选项按钮的选中/未选中互斥两态、窄屏隐藏页签式文案都由工具类承担。
  test("提问面板渲染结果不含已迁移的语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(QuestionPanel, {
        questions: [
          {
            questionId: "q-1",
            createdAt: 0,
            expiresAt: 0,
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
    // 未选中态：hover 变蓝底蓝字；选中态才带 `bg-[#f0f5ff]`（两态互斥，不靠生成顺序）。
    expect(html).toContain("hover:bg-[#f0f5ff]");
    expect(html).not.toContain("bg-[#f0f5ff] text-[#245fc9]");
  });

  // 状态面板：页签互斥两态、窄屏隐藏页签文字、行内状态色都由工具类表达。
  test("状态面板渲染结果不含已迁移的语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(ChatStatusPanel, {
        todos: [
          { content: "检查待办", status: "completed", activeForm: null },
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
    expect(html).toContain("bg-[#f1f5fc] text-[#285eb8]");
    expect(html).toContain("[@media(max-width:720px)]:hidden");
    // 行首状态色：completed → 绿、in_progress → 橙。
    expect(html).toContain("text-[#25a47a]");
    expect(html).toContain("text-[#d28a27]");

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
    expect(failedOnly).toContain("text-[#db5d56]");
    expectNoLegacyClasses(failedOnly);

    // 变更文件行的「新增标绿」只在 changes 页签下渲染，而该页签默认折叠（组件既有行为），
    // SSR 触达不到那一支，故按源码级断言守住这两个互斥色值。
    const source = readFileSync(join(CHAT_DIR, "panels", "chat-status-panel.tsx"), "utf8");
    expect(source).toContain('"text-[10px] text-[#259a70]"');
    expect(source).toContain('"text-[10px] text-[#8a96a8]"');
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
    // 行容器四种网格列与图标尺寸（源 `.chat-tool-call-row` / `.tool-call-row-icon`）。
    expect(html).toContain("grid-cols-[22px_minmax(0,1fr)_auto_auto]");
    expect(html).toContain("h-[22px]");
  });

  // 活动链内的工具行左移 32px 抵消链的 pl-8（源 `.chat-activity-chain .tool-call-row-compact`）。
  test("活动链内的工具行带对齐补偿，链外不带", () => {
    expect(toolRow(true)).toContain("-ml-8");
    expect(toolRow(false)).not.toContain("-ml-8");
  });

  // 提示词导航轨：轨道/列表/刻度/预览都改成锚点 + 工具类（含选中态与悬停态互斥）。
  test("提示词导航渲染结果不含已迁移的语义类名", () => {
    const entries: UserMessageEntry[] = [
      { type: "user_message", id: "prompt-0", content: "第一条" },
      { type: "user_message", id: "prompt-1", content: "第二条" },
    ];
    const html = renderToStaticMarkup(createElement(PromptJumpRail, { entries }));

    expectNoLegacyClasses(html);
    expect(html).toContain('data-slot="chat-prompt-jump-rail"');
    expect(html).toContain('data-slot="chat-prompt-jump-list"');
    expect(html).toContain('data-slot="chat-prompt-jump-item"');
    expect(html).toContain('data-slot="chat-prompt-jump-tick"');
    // 宽屏才显示（源 `@media (min-width: 1180px) and (min-height: 620px)`，含端点同义表达）。
    expect(html).toContain("[@media(min-width:1180px)_and_(min-height:620px)]:block");
    // 选中刻度与其余刻度互斥（选中态不带 hover 变宽类）。
    expect(html).toContain("w-[19px] bg-[#202936]");
    expect(html).toContain("group-hover:w-[13px]");
  });
});

describe("chat 样式迁移：加载指示与窄屏适配", () => {
  // 三点脉冲与文字微光不再依赖 `chat-conversation` 作用域，`chat-conversation` 类名随之删除。
  test("加载指示改用工具类且会话容器不再带语义类名", () => {
    const html = renderToStaticMarkup(
      createElement(ChatView, {
        entries: [{ type: "user_message", id: "u-1", content: "hi" }],
        isLoading: true,
      }),
    );

    expectNoLegacyClasses(html);
    // 用 token 列表断言（`&` 在 HTML 里被转义成 `&amp;`，原字符串比对会假失败）。
    const tokens = classTokens(html);
    expect(tokens).toContain("animate-[loadingDotBounce_1.4s_ease-in-out_-0.32s_infinite_both]");
    expect(tokens).toContain("[.dark_&]:animate-[loadingDotBounceDark_1.4s_ease-in-out_-0.32s_infinite_both]");
    expect(tokens).toContain("animate-[shimmerSlide_2s_ease-in-out_infinite]");
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

    expect(classExpressions).not.toContain("chat-activity-chain");
    expect(classExpressions).not.toContain("chat-conversation");
    // 工具行改为按 `inActivityChain` 传参（属性名出现即说明替代写法在位）。
    expect(sources.map((rel) => readFileSync(join(CHAT_DIR, rel), "utf8")).join("\n")).toContain("inActivityChain");
  });
});
