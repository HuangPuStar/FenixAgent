import { afterAll, afterEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { parseChatQuotes, serializeChatQuotes } from "../chat/lib/context-queue";
import { type ChatInputSubmitOptions, useChatInputSubmit } from "../chat/shell/internal/use-chat-input-submit";
import type { ChatInputMessage, ContentBlock } from "../chat/types";

const globals = globalThis as Record<string, unknown>;
const savedGlobals = new Map(
  ["window", "document", "navigator", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, globals[key]]),
);
const win = initializeHappyDomWindow(new Window());
Object.assign(globals, {
  window: win,
  document: win.document,
  navigator: win.navigator,
  IS_REACT_ACT_ENVIRONMENT: true,
});
afterAll(() => {
  for (const [key, value] of savedGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

let root: Root | undefined;
let submit: (message: ChatInputMessage) => Promise<void>;
const sent: ContentBlock[][] = [];
const fileQuote = {
  text: "选中的正文",
  omittedCharacterCount: 0,
  source: { path: "中文报告.pdf", location: "第 2 页" },
};

/** 挂载真实发送 hook，在端口边界记录实际发出的消息。 */
function Harness({ options }: { options: Partial<ChatInputSubmitOptions> }) {
  submit = useChatInputSubmit({
    isLoading: false,
    activeSessionId: "session-a",
    onCreateSession: async () => "session-a",
    onSendPrompt: async (blocks) => {
      sent.push(blocks);
    },
    imagePrepareFailedMessage: "image-failed",
    sessionCreateFailedMessage: "session-failed",
    sendPromptFailedMessage: "send-failed",
    ...options,
  });
  return null;
}

function mount(options: Partial<ChatInputSubmitOptions> = {}) {
  root ??= createRoot(document.createElement("div"));
  act(() => root?.render(<Harness options={options} />));
}

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  sent.length = 0;
});

// 无正文时引用本身就是有效消息，评论可选，来源及页码不能丢失。
test.each([undefined, "请解释选区"])("只有文件引用也发送完整上下文（评论：%s）", async (comment) => {
  mount();
  const quote = { ...fileQuote, ...(comment ? { comment } : {}) };
  const quoteContext = serializeChatQuotes([quote]);
  await act(async () => submit({ text: " \n ", quoteContext }));
  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual([{ type: "text", text: `<system-reminder>\n${quoteContext}\n</system-reminder>` }]);
  expect(parseChatQuotes(sent[0]?.[0]?.text ?? "")).toEqual([quote]);
});

// 聊天消息选区与文件选区使用同一个发送契约，不能只放行文件来源。
test("只有聊天引用时也可以发送", async () => {
  mount();
  const quoteContext = serializeChatQuotes([{ text: "已有回答", omittedCharacterCount: 0 }]);
  await act(async () => submit({ text: "", quoteContext }));
  expect(sent).toHaveLength(1);
  expect(parseChatQuotes(sent[0]?.[0]?.text ?? "")[0]?.text).toBe("已有回答");
});

// 真正空白提交不能靠场景提示词或后台上下文触发发送，也不能提前消费它们。
test("无正文和引用的空白消息仍被拦截", async () => {
  let flushes = 0;
  mount({
    scenePrompt: "scene",
    flushContext: () => {
      flushes += 1;
      return "background";
    },
  });
  await act(async () => submit({ text: " \n ", quoteContext: " \n " }));
  expect(sent).toHaveLength(0);
  expect(flushes).toBe(0);
});

// 运行中提交应把引用完整入队，不能变成空队列项或误走直发。
test("只有引用时沿用运行中入队路径", async () => {
  const enqueued: { blocks: ContentBlock[]; draft: string }[] = [];
  mount({
    isLoading: true,
    queueSubmitActive: true,
    onEnqueuePrompt: (blocks, draft) => {
      enqueued.push({ blocks, draft });
      return true;
    },
  });
  const quoteContext = serializeChatQuotes([fileQuote]);
  await act(async () => submit({ text: "", quoteContext }));
  expect(sent).toHaveLength(0);
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]?.draft).toBe("");
  expect(parseChatQuotes(enqueued[0]?.blocks[0]?.text ?? "")).toEqual([fileQuote]);
});

// 首条消息只有引用时先创建会话，绑定完成后恰好发送一次。
test("只有引用时可创建会话并在就绪后补发", async () => {
  let creates = 0;
  mount({
    activeSessionId: null,
    onCreateSession: async () => {
      creates += 1;
      return "session-a";
    },
  });
  await act(async () => submit({ text: "", quoteContext: serializeChatQuotes([fileQuote]) }));
  expect(creates).toBe(1);
  expect(sent).toHaveLength(0);
  mount();
  await act(async () => {});
  expect(sent).toHaveLength(1);
  expect(parseChatQuotes(sent[0]?.[0]?.text ?? "")).toEqual([fileQuote]);
});

// 无队列能力时保持运行中的发送限制，引用不能绕过原有并发保护。
test("运行中且不能入队时仍拦截引用提交", async () => {
  mount({ isLoading: true });
  await act(async () => submit({ text: "", quoteContext: serializeChatQuotes([fileQuote]) }));
  expect(sent).toHaveLength(0);
});
