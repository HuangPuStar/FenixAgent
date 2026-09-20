import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ChatComposer } from "../chat/composer/ChatComposer";
import type { ComposerExternalEvent, ComposerExternalSubscribe } from "../chat/composer/composer-effects";
import { processImageFiles, uploadComposerFiles } from "../chat/composer/composer-file-processing";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../lib/i18n";
import { initializeHappyDomWindow } from "./happy-dom-window";

/**
 * 输入岛（`web/chat/composer/`）的行为测试。
 *
 * 覆盖范围是纯化后的契约，而不是 UI 结构：外部输入通道（`subscribeExternal`）、
 * 半受控输入状态、提示出口（`onNotice`）与注入式的上传/压缩回调。
 * 文案断言取「包内字典里的译文，字典尚未搬运时回落 key」，避免集成阶段补 i18n 后测试失真。
 */

const window = initializeHappyDomWindow(new Window());
// biome-ignore lint/suspicious/noExplicitAny: 测试环境需要把 happy-dom 的 DOM 注入全局
(globalThis as any).window = window;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).document = window.document;
// biome-ignore lint/suspicious/noExplicitAny: 同上
(globalThis as any).navigator = window.navigator;
// biome-ignore lint/suspicious/noExplicitAny: 同上（FileReader 必须与 happy-dom 的 Blob 同源）
(globalThis as any).FileReader = window.FileReader;
// biome-ignore lint/suspicious/noExplicitAny: React 19 的 act 环境标记
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

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

/** 读包内英文字典的 chat 子树；集成阶段搬运 i18n 之前返回 undefined。 */
function chatText(path: string): string | undefined {
  const chat = (en as Record<string, unknown>).chat as Record<string, unknown> | undefined;
  let current: unknown = chat;
  for (const part of path.split(".")) {
    if (typeof current !== "object" || current === null) return;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

/** 断言渲染出的文案：字典已搬运则比译文，否则比 key（两种状态下都能发现回归）。 */
function expectText(actual: string | null | undefined, key: string) {
  expect(actual).toBe(chatText(key) ?? `chat.${key}`);
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const host = window.document.createElement("div");
  // happy-dom 的 appendChild 要求同源 Node 类型（与 DOM lib 的 Node 声明不同名）
  window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
  container = host as unknown as HTMLDivElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function mount(props: Parameters<typeof ChatComposer>[0]) {
  act(() => {
    root.render(<ChatComposer {...props} />);
  });
}

describe("ChatComposer 纯化接缝", () => {
  // 外部通道注入建议提示词后正文更新，点击发送按钮回调 onSubmit 并清空草稿
  test("suggested prompt + submit", () => {
    let emit: ((event: ComposerExternalEvent) => void) | undefined;
    const subscribe: ComposerExternalSubscribe = (handler) => {
      emit = handler;
      return () => {
        emit = undefined;
      };
    };
    const submitted: unknown[] = [];
    mount({ onSubmit: (message) => submitted.push(message), subscribeExternal: subscribe });

    act(() => emit?.({ type: "suggested-prompt", prompt: "hello agent" }));
    expect(container.querySelector("textarea")?.value).toBe("hello agent");

    const send = container.querySelector(".chat-composer-send");
    expectText(send?.getAttribute("aria-label"), "components.chatComposer.send");
    act(() => (send as unknown as HTMLButtonElement).click());

    expect(submitted.length).toBe(1);
    expect(submitted[0]).toMatchObject({ text: "hello agent" });
    expect(container.querySelector("textarea")?.value).toBe("");
  });

  // 引用事件累积为待发送引用，达到上限后通过 onNotice 提示（不再直连 sonner toast）
  test("quote intake enforces limit through onNotice", () => {
    let emit: ((event: ComposerExternalEvent) => void) | undefined;
    const notices: Array<{ level: string; message: string }> = [];
    mount({
      onSubmit: () => {},
      onNotice: (notice) => notices.push(notice),
      subscribeExternal: (handler) => {
        emit = handler;
        return () => {};
      },
    });

    act(() => emit?.({ type: "quote", quote: { text: "first quote" } }));
    expect(container.querySelectorAll(".chat-composer-asset.is-quote").length).toBe(1);

    for (let i = 0; i < 8; i += 1) {
      act(() => emit?.({ type: "quote", quote: { text: `extra ${i}` } }));
    }
    expect(container.querySelectorAll(".chat-composer-asset.is-quote").length).toBe(8);
    expect(notices.at(-1)?.level).toBe("info");
    expectText(notices.at(-1)?.message, "components.composerAssets.quoteLimitReached");
  });

  // 文件树引用事件追加 @./path 正文与附件 chip
  test("file reference appends mention and attachment", () => {
    let emit: ((event: ComposerExternalEvent) => void) | undefined;
    mount({
      onSubmit: () => {},
      subscribeExternal: (handler) => {
        emit = handler;
        return () => {};
      },
    });

    act(() => emit?.({ type: "file-reference", file: { name: "index.ts", path: "src/index.ts" } }));
    expect(container.querySelector("textarea")?.value).toBe("@./src/index.ts ");
    expect(container.querySelectorAll(".chat-composer-asset").length).toBe(1);
  });

  // 未注入 uploadFiles 时附件按钮禁用（源实现以 envId 是否存在判定），注入后可用
  test("attachment button follows uploadFiles injection", () => {
    mount({ onSubmit: () => {} });
    expect((container.querySelector(".chat-composer-file") as unknown as HTMLButtonElement).disabled).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    mount({ onSubmit: () => {}, uploadFiles: async () => [] });
    expect((container.querySelector(".chat-composer-file") as unknown as HTMLButtonElement).disabled).toBe(false);
  });

  // 受控 draft 传入时以宿主值为准（半受控语义）
  test("controlled draft wins", () => {
    mount({ onSubmit: () => {}, draft: "controlled text", onDraftChange: () => {} });
    expect(container.querySelector("textarea")?.value).toBe("controlled text");
  });
});

describe("注入式文件处理", () => {
  // 上传回调被注入后按 name/path 映射为附件，体积超限时抛出源 i18n key
  test("uploadComposerFiles delegates to injected upload", async () => {
    const called: File[][] = [];
    const result = await uploadComposerFiles([new File(["a"], "a.txt")], async (files) => {
      called.push(files);
      return [{ name: "a.txt", path: "user/a.txt" }];
    });
    expect(called.length).toBe(1);
    expect(result).toEqual([{ name: "a.txt", path: "user/a.txt" }]);

    const oversized = { size: 101 * 1024 * 1024, name: "big.bin" } as unknown as File;
    await expect(uploadComposerFiles([oversized], async () => [])).rejects.toThrow("chatComposer.fileTooLarge");
  });

  // 注入 compress 后大图走回调并把 mimeType 归一为 jpeg，小图不触发压缩
  test("processImageFiles uses injected compress only above threshold", async () => {
    // happy-dom 的 FileReader 只接受同源 Blob，故用 window.File 构造
    const small = new window.File([new Uint8Array([1, 2, 3])], "small.png", {
      type: "image/png",
    }) as unknown as File;
    const [image] = await processImageFiles([small]);
    expect(image.mimeType).toBe("image/png");

    const heavy = { size: 3 * 1024 * 1024, type: "image/png" } as unknown as File;
    const compressed = new window.Blob([new Uint8Array([9])], { type: "image/jpeg" }) as unknown as Blob;
    let compressCalls = 0;
    const [jpeg] = await processImageFiles([heavy], async () => {
      compressCalls += 1;
      return compressed;
    });
    expect(compressCalls).toBe(1);
    expect(jpeg.mimeType).toBe("image/jpeg");
  });
});
