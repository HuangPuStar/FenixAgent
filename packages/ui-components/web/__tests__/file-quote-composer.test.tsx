import { afterAll, afterEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { useComposerHandlers } from "../chat/composer/composer-handlers";
import { type ComposerState, useComposerState } from "../chat/composer/composer-state";
import { useFileQuotes } from "../chat/composer/use-file-quotes";
import { prepareFileQuote } from "../chat/lib/file-quotes";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const savedGlobals = new Map(
  [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "Element",
    "Node",
    "Event",
    "MouseEvent",
    "KeyboardEvent",
    "CustomEvent",
    "customElements",
    "HTMLInputElement",
    "MutationObserver",
    "NodeFilter",
    "getComputedStyle",
    "IS_REACT_ACT_ENVIRONMENT",
  ].map((key) => [key, (globalThis as Record<string, unknown>)[key]]),
);
afterAll(() => {
  for (const [key, value] of savedGlobals) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[key];
    else (globalThis as Record<string, unknown>)[key] = value;
  }
});
const i18n = createInstance();
void i18n.init({
  lng: "en",
  initAsync: false,
  defaultNS: UI_COMPONENTS_NS,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});
const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
for (const name of [
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "CustomEvent",
  "customElements",
  "HTMLInputElement",
  "MutationObserver",
  "NodeFilter",
]) {
  globals[name] = (win as unknown as Record<string, unknown>)[name];
}
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.IS_REACT_ACT_ENVIRONMENT = true;
const { FileQuoteDialog } = await import("../chat/composer/file-quote-dialog");
let root: Root | undefined;
let state: ComposerState;
let quotes: ReturnType<typeof useFileQuotes>;
let handlers: ReturnType<typeof useComposerHandlers>;
const submissions: unknown[] = [];
function Harness({ sessionId, showDialog }: { sessionId: string | null; showDialog: boolean }) {
  state = useComposerState({ defaultDraft: "existing draft" });
  quotes = useFileQuotes(state, sessionId);
  handlers = useComposerHandlers({
    state,
    mcps: [],
    disabled: false,
    isLoading: false,
    queueSubmitEnabled: false,
    supportsImages: false,
    fileReferenceEnabled: false,
    onSubmit: (message) => submissions.push(message),
    textareaRef: { current: null },
    fileInputRef: { current: null },
  });
  return showDialog ? <FileQuoteDialog quotes={quotes} /> : null;
}
function mount(sessionId: string | null, showDialog = false) {
  root ??= createRoot(document.createElement("div"));
  act(() =>
    root?.render(
      <I18nextProvider i18n={i18n}>
        <Harness sessionId={sessionId} showDialog={showDialog} />
      </I18nextProvider>,
    ),
  );
}
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
});

// 紧凑评论输入支持回车添加，保留选区、来源和草稿，不触发消息发送。
test("confirms a file quote from the compact comment input on Enter", () => {
  mount("session-a", true);
  submissions.length = 0;
  act(() => quotes.request({ text: "selected", source: { path: "a.txt", location: "Lines 1–2" } }));
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Comment (optional)"]');
  expect(input).not.toBeNull();
  act(() => quotes.setComment("please check"));
  act(() => input?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  expect(quotes.pending).toBeNull();
  expect(state.quotes[0]).toMatchObject({
    text: "selected",
    comment: "please check",
    source: { path: "a.txt", location: "Lines 1–2" },
  });
  expect(state.text).toBe("existing draft");
  expect(submissions).toHaveLength(0);
});

// 中文候选确认的回车不能提交引用，右侧确认图标仍可添加不带评论的引用。
test("ignores composing Enter and allows the confirm icon without a comment", () => {
  mount("session-a", true);
  act(() => quotes.request({ text: "selected", source: { path: "a.txt" } }));
  const input = document.querySelector<HTMLInputElement>('input[aria-label="Comment (optional)"]');
  expect(input).not.toBeNull();
  act(() => input?.dispatchEvent(new win.KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true })));
  expect(quotes.pending).not.toBeNull();
  expect(state.quotes).toHaveLength(0);
  act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Add"]')?.click());
  expect(quotes.pending).toBeNull();
  expect(state.quotes[0]?.text).toBe("selected");
});

// 后续普通引用挤占 JSON 额度时，发送必须保留草稿并报错，不能丢掉已确认引用。
test("does not submit or clear a mixed quote draft that exceeds the final payload budget", () => {
  mount("session-a");
  submissions.length = 0;
  act(() =>
    state.updateQuotes([
      {
        id: "file",
        text: "a".repeat(4000),
        omittedCharacterCount: 0,
        source: { path: "a.txt" },
        comment: "注".repeat(1000),
      },
      { id: "normal", text: "b".repeat(4000), omittedCharacterCount: 0 },
    ]),
  );
  act(() => handlers.handleSubmit());
  expect(submissions).toHaveLength(0);
  expect(state.quotes).toHaveLength(2);
});

// 新文件引用和评论追加到当前草稿，不能覆盖用户已写正文或破坏缩进。
test("confirms file selection with optional comment without replacing the draft", () => {
  mount("session-a");
  act(() => quotes.request({ text: "  code\n    next", source: { path: "src/test.ts", unsaved: true } }));
  expect(state.quotes).toHaveLength(0);
  act(() => quotes.setComment("请检查"));
  act(() => quotes.confirm());
  expect(state.quotes[0]).toMatchObject({
    text: "  code\n    next",
    comment: "请检查",
    source: { path: "src/test.ts", unsaved: true },
  });
  expect(state.text).toBe("existing draft");
  expect(quotes.pending).toBeNull();
});

// 首次会话建立保留待发送引用，切换已有对话清除文件引用而保留其他草稿。
test("keeps first session binding and clears file quotes on later conversation switch", () => {
  mount(null);
  act(() => quotes.request({ text: "first", source: { path: "a.txt" } }));
  act(() => quotes.confirm());
  mount("session-a");
  expect(state.quotes).toHaveLength(1);
  mount("session-b");
  expect(state.quotes).toHaveLength(0);
  expect(state.text).toBe("existing draft");
});

// JSON 转义和元数据也占额度，不能允许添加后在发送时静默丢掉引用。
test("rejects payload overflow and preserves Unicode indentation in bounded quotes", () => {
  expect(prepareFileQuote({ text: "<".repeat(4000), source: { path: "a.txt" } }, []).error).toBe("limit");
  expect(prepareFileQuote({ text: "ok", source: { path: "../outside" } }, []).error).toBe("invalid");
  const result = prepareFileQuote({ text: `${"😀".repeat(4000)}末尾`, source: { path: "a.txt" } }, []);
  expect(result.quote?.omittedCharacterCount).toBe(2);
  expect(Array.from(result.quote?.text ?? "")).toHaveLength(4000);
});

// 草稿 ID 属于界面状态，不能让已准入的文件引用在确认后额外超出发送额度。
test("admitted near-limit file quote stays sendable after adding its draft id", () => {
  mount("session-a");
  submissions.length = 0;
  act(() => state.updateQuotes([{ id: "one", text: "a".repeat(4000), omittedCharacterCount: 0 }]));
  act(() => quotes.request({ text: "b".repeat(4000), source: { path: "a.txt" } }));
  act(() => quotes.setComment("注".repeat(785)));
  expect(quotes.prepared?.error).toBeUndefined();
  act(() => quotes.confirm());
  act(() => handlers.handleSubmit());
  expect(submissions).toHaveLength(1);
  const message = submissions[0] as { quoteContext: string };
  expect(message.quoteContext).not.toContain('"id"');
});
