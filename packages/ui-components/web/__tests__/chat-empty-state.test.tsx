import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ThreadEntry } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const CHAT_VIEW_DIR = join(import.meta.dir, "../chat/view");

/**
 * Chat 空状态与时间线间距的服务端渲染测试。
 *
 * 迁移自 `packages/agent-runtime/web/__tests__/chat-empty-state.test.tsx`（CE 阶段 2 §1.6 T6c1），
 * 旧实现 `packages/agent-runtime/web/components/chat/**` 随整体退场删除后由本文件续接覆盖。
 *
 * 迁移改动点：
 * - 导入路径按 A→B 映射表改写（`../components/chat/*` → `../chat/*`，`../lib/types` → `../chat/types`）。
 * - i18n 从宿主 `@/src/i18n/locales/zh/components.json` 换成包内字典
 *   `../i18n/locales/zh/uiComponents.json`，命名空间收敛为 `UI_COMPONENTS_NS`，键加 `chat.components.` 前缀；
 *   仍用 zh 字典，与原用例的断言语言保持一致。
 * - 用例本身为纯 `renderToStaticMarkup` 渲染，不触碰 DOM API，因此不需要 happy-dom 引导
 *   （对照同目录 `chat-composer.test.tsx` 的交互式用例）。
 * - 宿主注入点（原实现的 `chat:apply-suggested-prompt` window 事件、`@/src/*` 依赖）在本文件未被触达，
 *   不需要为宿主打桩；空状态建议提示词的投递改由 `onApplySuggestedPrompt` prop 注入。
 */

// 与包内其他 chat 测试同款：用 `initReactI18next` 把实例登记为 `useTranslation` 的默认实例。
// 服务端渲染只需译文字符串，无需 DOM 引导。
const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { zh: { [UI_COMPONENTS_NS]: zh } },
});

describe("Chat 空状态", () => {
  // 首次进入会话时应渲染设计稿中的引导层级，而不是旧工牌卡。
  // 三个可选起始任务的文案随 i18n 状态变化（字典内容由下方「推荐讨论型起始话题」直接断言），
  // 此处只断言引导容器、品牌标识与调用方标题。
  test("按设计稿渲染引导内容", () => {
    const markup = renderToStaticMarkup(
      <ChatView
        entries={[]}
        agentName="Code Agent"
        emptyTitle="今天想完成什么？"
        emptyDescription="描述目标、贴入上下文，或从一个常见任务开始。"
      />,
    );

    expect(markup).toContain('data-slot="chat-empty-state"');
    expect(markup).toContain("brand/fenix-agent-logo-mark.png");
    expect(markup).toContain("今天想完成什么？");
    expect(markup).not.toContain('data-slot="agent-badge"');
  });

  // 会话加载中显示标准转圈加载态，而不是工牌卡骨架（卡片会被误读为会话内容）。
  test("会话加载中显示转圈加载态", () => {
    const markup = renderToStaticMarkup(<ChatView entries={[]} isLoading />);

    expect(markup).toContain('role="status"');
    expect(markup).toContain("正在加载会话…");
    expect(markup).not.toContain('data-slot="agent-badge"');
  });

  // 拆分到 chat-empty-state.tsx 后，空状态的 DOM 层级、class、图标、文案与间距必须逐项保持原样。
  test("空状态 DOM 结构与拆分前一致", () => {
    const markup = renderToStaticMarkup(<ChatView entries={[]} emptyTitle="标题保持" emptyDescription="说明保持" />);
    expect(markup).toContain('data-slot="chat-empty-state"');
    expect(markup).toContain('aria-labelledby="chat-empty-title"');
    expect(markup).toContain('id="chat-empty-title"');
    expect(markup).toContain("chat-empty-heading my-1.75 text-3xl");
    expect(markup).toContain("max-w-115 text-sm leading-relaxed text-slate-500");
    expect(markup).toContain("h-11.5 w-11.5 rotate-[-5deg]");
    expect(markup).toContain("h-6.75 w-6.75 rotate-[5deg]");
    expect(markup).toContain("mt-4.5 text-blue-600");
    expect(markup).toContain("从一次充分讨论开始");
    expect(markup).toContain('data-slot="chat-empty-suggestions"');
    expect(markup.match(/chat-empty-prompt-button/g)).toHaveLength(3);
    expect(markup).toContain("讨论代码变更的思路与风险");
    expect(markup).toContain("讨论技术方案的选择与取舍");
    expect(markup).toContain("讨论构建失败的可能原因");
    expect(markup).toContain("标题保持");
    expect(markup).toContain("说明保持");
  });

  // 推荐提示词应引导用户先讨论思路、风险和取舍，而不是要求 Agent 直接行动。
  // 包内字典的键带 `chat.components.` 前缀，故断言路径由 `chatEmpty.*` 改为 `chat.components.chatEmpty.*`。
  test("推荐讨论型起始话题", () => {
    expect(zh.chat.components.chatEmpty.eyebrow).toBe("从一次充分讨论开始");
    expect(zh.chat.components.chatEmpty.suggestionReview).toBe("讨论代码变更的思路与风险");
    expect(zh.chat.components.chatEmpty.suggestionPlan).toBe("讨论技术方案的选择与取舍");
    expect(zh.chat.components.chatEmpty.suggestionBuild).toBe("讨论构建失败的可能原因");
  });

  // 活动链紧邻正文时保留来源标记；折叠标题是独立过程块，间距改由统一的 `my-2` 承担。
  test("正文后的活动链保留来源标记", () => {
    const entries: ThreadEntry[] = [
      { type: "assistant_message", id: "assistant-1", chunks: [{ type: "message", text: "开始读取文件" }] },
      {
        type: "tool_call",
        toolCall: { id: "tool-1", title: "Read", kind: "read-file", status: "complete" },
      },
    ];
    const markup = renderToStaticMarkup(<ChatView entries={entries} />);

    // 类名 `chat-activity-chain--after-message` 已迁为数据状态钩子，锚点为 `data-slot`；
    // 该标记只表达「链前是正文」，不再参与间距计算（见 `ActivityChain` 的 `afterMessage` 注释）。
    expect(markup).toContain('data-slot="chat-activity-chain"');
    expect(markup).toContain('data-after-message="true"');
  });

  // 空状态自定义选择器留在 ChatView.css，宿主 Tailwind 扫描面覆盖 packages/**/web；
  // 拆分到新文件后类名仍会进入构建产物（构建后 CSS 已人工核对）。
  test("空状态选择器与 Tailwind 扫描面存在", () => {
    const css = readFileSync(join(CHAT_VIEW_DIR, "ChatView.css"), "utf8");
    expect(css).toContain(".chat-empty-heading");
    expect(css).toContain(".chat-empty-prompt-list");
    expect(css).toContain(".chat-empty-prompt-button:hover");
    const hostCss = readFileSync(join(import.meta.dir, "../../../../apps/web/src/index.css"), "utf8");
    expect(hostCss).toContain('@source "../../../packages/**/web/**/*.{ts,tsx}"');
  });
});
