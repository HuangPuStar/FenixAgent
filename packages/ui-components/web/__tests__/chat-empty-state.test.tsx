import { describe, expect, test } from "bun:test";
import { createInstance } from "i18next";
import { renderToStaticMarkup } from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ThreadEntry } from "../chat/types";
import { ChatView } from "../chat/view/ChatView";
import zh from "../i18n/locales/zh/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

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

  // 推荐提示词应引导用户先讨论思路、风险和取舍，而不是要求 Agent 直接行动。
  // 包内字典的键带 `chat.components.` 前缀，故断言路径由 `chatEmpty.*` 改为 `chat.components.chatEmpty.*`。
  test("推荐讨论型起始话题", () => {
    expect(zh.chat.components.chatEmpty.eyebrow).toBe("从一次充分讨论开始");
    expect(zh.chat.components.chatEmpty.suggestionReview).toBe("讨论代码变更的思路与风险");
    expect(zh.chat.components.chatEmpty.suggestionPlan).toBe("讨论技术方案的选择与取舍");
    expect(zh.chat.components.chatEmpty.suggestionBuild).toBe("讨论构建失败的可能原因");
  });

  // 可见正文后紧接工具调用时应标记专用紧凑边界，避免出现过大的垂直空白。
  test("正文后的工具调用使用紧凑间距", () => {
    const entries: ThreadEntry[] = [
      { type: "assistant_message", id: "assistant-1", chunks: [{ type: "message", text: "开始读取文件" }] },
      {
        type: "tool_call",
        toolCall: { id: "tool-1", title: "Read", kind: "read-file", status: "complete" },
      },
    ];
    const markup = renderToStaticMarkup(<ChatView entries={entries} />);

    // 类名 `chat-activity-chain--after-message` 已迁为条件工具类，紧凑边界改按数据状态断言；
    // `chat-activity-chain` 类名保留（工具簇样式表仍以它作作用域钩子），锚点为 `data-slot`。
    expect(markup).toContain('data-slot="chat-activity-chain"');
    expect(markup).toContain('data-after-message="true"');
  });
});
