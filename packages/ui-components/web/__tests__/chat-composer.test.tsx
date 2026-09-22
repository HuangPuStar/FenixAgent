import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import ReactDOMServer from "react-dom/server";
import { initReactI18next } from "react-i18next/initReactI18next";
import { ChatComposer } from "../chat/composer/ChatComposer";
import type { ComposerExternalEvent, ComposerExternalSubscribe } from "../chat/composer/composer-effects";
import { processImageFiles, uploadComposerFiles } from "../chat/composer/composer-file-processing";
import { buildPromptText } from "../chat/composer/composer-prompt";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

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

    const send = container.querySelector('[data-slot="chat-composer-send"]');
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
    expect(container.querySelectorAll('[data-slot="chat-composer-quote"]').length).toBe(1);

    for (let i = 0; i < 8; i += 1) {
      act(() => emit?.({ type: "quote", quote: { text: `extra ${i}` } }));
    }
    expect(container.querySelectorAll('[data-slot="chat-composer-quote"]').length).toBe(8);
    expect(notices.at(-1)?.level).toBe("info");
    expectText(notices.at(-1)?.message, "components.composerAssets.quoteLimitReached");
  });

  // 同一 React 批次内连续注入引用时，字符配额必须同步累加（源实现在一次 act 内派发 3 条
  // 4000 字符引用并断言只保留 2 条）。配额判断若读渲染期快照，这 3 条会各自按满额度放行。
  test("quote intake enforces character budget within one batch", () => {
    let emit: ((event: ComposerExternalEvent) => void) | undefined;
    mount({
      onSubmit: () => {},
      subscribeExternal: (handler) => {
        emit = handler;
        return () => {};
      },
    });

    act(() => {
      emit?.({ type: "quote", quote: { text: "甲".repeat(4_000) } });
      emit?.({ type: "quote", quote: { text: "乙".repeat(4_000) } });
      emit?.({ type: "quote", quote: { text: "丙".repeat(4_000) } });
    });

    const assets = container.querySelectorAll('[data-slot="chat-composer-quote"]');
    expect(assets.length).toBe(2);
    const rendered = container.textContent ?? "";
    expect(rendered).toContain("甲".repeat(100));
    expect(rendered).toContain("乙".repeat(100));
    expect(rendered).not.toContain("丙".repeat(100));
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
    expect(container.querySelectorAll('[data-slot="chat-composer-asset"]').length).toBe(1);
  });

  // 未注入 uploadFiles 时附件按钮禁用（源实现以 envId 是否存在判定），注入后可用
  test("attachment button follows uploadFiles injection", () => {
    mount({ onSubmit: () => {} });
    expect(findFileButton(container).disabled).toBe(true);

    act(() => root.unmount());
    root = createRoot(container);
    mount({ onSubmit: () => {}, uploadFiles: async () => [] });
    expect(findFileButton(container).disabled).toBe(false);
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

// ─────────────────────────────────────────────────────────────────────────────
// 迁移自 `packages/agent-runtime/web/__tests__/chat-composer.test.tsx`
// （CE 阶段 2 §1.6 T6c1：旧聊天实现整体退场，用例随实现迁入 owner 包）。
//
// 迁移改动点（用例名与中文注释逐字保留，仅按包内契约改写断言的取值来源）：
// - 导入路径按 A→B 表改写（`../components/chat/x` → `../chat/<layer>/x`）；`buildPromptText` 与
//   `ReactDOMServer` 提到文件头，`ComposerAssets` 沿用旧用例的 `await import`。
// - i18n 换包内字典：旧文件读宿主 `apps/web/src/i18n/locales/en/components.json` 的 `chatComposer.*`；
//   包内同键位于 `uiComponents` 命名空间的 `chat.*` 子树（`chat.components.chatComposer.*`），
//   断言经 `chatText` / `expectCopy` 取包内字典译文，字典缺键时回落 key（口径同 `expectText`）。
// - `envId` prop 已随纯化去掉：旧用例名里的「environment」在包内对应「是否注入 `uploadFiles` /
//   `renderFilePicker`」。用例名保留旧名以便与旧文件逐条对照，断言按包内实际契约书写。
// - 旧实现以 3 个 window CustomEvent（`chat:apply-suggested-prompt` / `file-tree:reference` /
//   `chat:quote`）接收外部输入，包内收敛为 `subscribeExternal` 注入，交互用例改为直接向注入的
//   订阅者派发事件（不再需要自建 happy-dom window）。
// - happy-dom 引导复用文件头已有的包内 `testing` 入口，不再读 `apps/web/src/__tests__/happy-dom-window`。
// - §8.2 与 README「已知取舍」登记的 ToolCallRow / TodoChanges 取舍不涉及本文件用例，故无删除项。
// ─────────────────────────────────────────────────────────────────────────────

/** 迁移用例里的 `ChatComposer` props（类型空间取值，不产生运行时加载）。 */
type MigratedComposerProps = Parameters<typeof ChatComposer>[0];
/** `onSubmit` 收到的消息类型（旧文件用 `ComposerProps["onSubmit"]` 推导，语义一致）。 */
type SubmittedMessage = Parameters<MigratedComposerProps["onSubmit"]>[0];

/**
 * 断言渲染结果里出现了某条 composer 文案（包内 `uiComponents` 命名空间，`key` 相对 `chat.` 子树，
 * 如 `components.chatComposer.send`）——译文与 key 两种形态都接受，口径与 `expectText` 一致。
 */
function expectCopy(html: string, key: string) {
  const translated = chatText(key);
  const candidates = [translated, `chat.${key}`].filter((value): value is string => typeof value === "string");
  expect(
    candidates.some((candidate) => html.includes(candidate)),
    `文案 chat.${key} 既没有以译文也没有以 key 形态出现在渲染结果里`,
  ).toBe(true);
}

/** 找到附件入口按钮（包内该按钮带稳定锚点 `data-slot="chat-composer-file"`）。 */
function findFileButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector('[data-slot="chat-composer-file"]') as unknown as HTMLButtonElement;
}

/** 找到发送/停止按钮（含 lucide 图标的 button）；包内该按钮带稳定锚点 `data-slot="chat-composer-send"`。 */
function findActionButton(container: HTMLElement): HTMLElement | null {
  return (
    Array.from(container.querySelectorAll("button")).find((b) =>
      b.querySelector("svg.lucide-send, svg.lucide-square"),
    ) ?? null
  );
}

describe("Composer prompt capabilities", () => {
  // 未选择能力时保持用户正文原样，不产生额外 reminder。
  test("keeps plain prompt unchanged without selected capabilities", () => {
    expect(buildPromptText({ text: "检查这个改动" })).toBe("检查这个改动");
  });

  // Skill slash command 已在用户正文中，发送边界只为 MCP 注入 system-reminder。
  test("injects only selected mcps at the send boundary", () => {
    expect(buildPromptText({ text: "/review 检查这个改动", mcps: ["filesystem"] })).toBe(
      "<system-reminder>\nThe user selected these MCP connections for this turn: filesystem\nUse the selected MCP connections when they are relevant to the user's request.\n</system-reminder>\n\n/review 检查这个改动",
    );
  });
});

describe("ChatComposer", () => {
  // 引用在输入区只显示紧凑方形卡片，正文仅放入受限的 hover/focus 预览。
  test("renders a compact quote tile with bounded hover preview", async () => {
    const { ComposerAssets } = await import("../chat/composer/composer-assets");
    const html = ReactDOMServer.renderToString(
      <ComposerAssets
        images={[]}
        files={[]}
        quotes={[{ id: "quote-1", text: "不应展示的引用正文", omittedCharacterCount: 128 }]}
        onRemoveImage={() => {}}
        onRemoveFile={() => {}}
        onRemoveQuote={() => {}}
      />,
    );

    expect(html).toContain('data-slot="chat-composer-quote"');
    expect(html).toContain('data-slot="chat-composer-quote-preview"');
    expect(html).toContain("不应展示的引用正文");
    expect(html).toContain("…");
  });

  test("exports as function", () => {
    expect(typeof ChatComposer).toBe("function");
  });

  test("renders without envId (minimal props)", () => {
    expect(() => {
      ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    }).not.toThrow();
  });

  test("renders textarea with placeholder", () => {
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} placeholder="给智能体发送消息…" />);
    expect(html).toContain("给智能体发送消息");
  });

  // 发送按钮现在是纯图标（无文字），检查 lucide Send 图标存在
  test("renders send button", () => {
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    expect(html).toContain("lucide-send");
  });

  // 只渲染协议真实 token 总量，不按固定上限推算百分比。
  test("renders real context usage without a fake percentage", () => {
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} contextUsage={{ totalTokens: 12300, inputTokens: 5000, outputTokens: 7300 }} />,
    );
    expect(html).toContain("12.3k");
    // 只断言「正文里没有百分比数值」：先剥掉 class 属性，工具类里合规的 `92%` 之类不该算作伪造百分比。
    expect(html.replace(/class="[^"]*"/g, "")).not.toMatch(/\d\s*%/);
  });

  // 元信息条：新会话按钮文案（i18n 译文或 key 回显，见 expectCopy）
  test("renders new session button when showNewSession is true", () => {
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} showNewSession={true} onNewSession={() => {}} />,
    );
    expectCopy(html, "components.chatComposer.newSession");
  });

  // 浮动按钮组：技能按钮在有 commands 和 envId 时渲染
  // （迁移：`envId` 在包内对应「注入了 `uploadFiles`」，本用例断言技能入口与附件入口都渲染。）
  test("renders skill and file buttons when commands and envId provided", () => {
    const mockCommands = [
      { name: "review", description: "Code review" },
      { name: "test", description: "Run tests" },
    ];
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} commands={mockCommands} uploadFiles={async () => []} />,
    );
    expectCopy(html, "components.chatComposer.skillButton");
    expectCopy(html, "components.chatComposer.attach");
  });

  // 无环境时仍展示文件入口以保持工具栏稳定，但入口必须禁用，不能触发无作用上传。
  // （迁移：包内「无环境」= 未注入 `uploadFiles` / `supportsImages`，禁用判定由 `supportsAttachments` 承担。）
  test("disables file button when commands exist without an environment", () => {
    const mockCommands = [{ name: "review", description: "Code review" }];
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={mockCommands} />);
    expectCopy(html, "components.chatComposer.skillButton");
    expectCopy(html, "components.chatComposer.attach");
    // 「入口被禁用」按稳定锚点断言：aria-label 的取值随 i18n 状态变化，不作为禁用与否的判据。
    expect(html).toMatch(/<button[^>]*data-slot="chat-composer-file"[^>]*disabled=""/);
  });

  // 浮动按钮组：仅有 envId 无 commands 时，只有文件按钮
  // （迁移：旧断言 `not.toContain("chatComposer.commandButton")` 在包内恒真——该 key 两端都不存在，
  //  改为按稳定锚点断言技能入口不渲染。）
  test("renders only file button when no commands", () => {
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} uploadFiles={async () => []} />);
    expect(html).not.toContain('data-slot="chat-composer-plugin"');
    expectCopy(html, "components.chatComposer.attach");
  });

  // 浮动按钮组：commands 为空数组时不显示技能按钮，无 envId 时不显示文件按钮
  // （迁移：无 envId 时包内仍渲染文件入口（禁用态），故断言口径同下：入口在、技能入口不在。）
  test("renders no buttons when commands empty array and no envId", () => {
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} commands={[]} />);
    expect(html).not.toContain('data-slot="chat-composer-plugin"');
    expectCopy(html, "components.chatComposer.attach");
  });

  // 断点 1 修复：canCancel（accepting/running/awaiting_permission）时按钮渲染 Square 停止图标，
  // 输出过程中（running，loading 非空但 canCancel=true）停止按钮也必须可见
  test("renders Square stop icon when canCancel is true", () => {
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} canCancel={true} onInterrupt={() => {}} />,
    );
    expect(html).toContain("lucide-square");
    expect(html).not.toContain("lucide-send");
  });

  // canCancel 时停止按钮可点击（不带 disabled）——running 输出期间可随时中断
  test("stop button is enabled when canCancel is true", () => {
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} canCancel={true} onInterrupt={() => {}} />,
    );
    // 「停止态」由 aria-label 承担（原断言的是 `chat-composer-send is-stop` 类名组合）；
    // 「可点击」按发送/停止锚点所在按钮不带 disabled 断言。
    expectCopy(html, "components.chatComposer.stop");
    const sendTag = html.match(/<button[^>]*data-slot="chat-composer-send"[^>]*>/)?.[0];
    expect(sendTag).toBeDefined();
    // 只查布尔属性本身（`disabled=""`）：class 里的 `disabled:*` 工具类不算禁用。
    expect(sendTag).not.toContain('disabled=""');
  });

  // cancelling（isLoading 且 canCancel=false）：渲染 Square 且 disabled，防止重复点发重取消
  test("renders disabled Square when isLoading and canCancel is false (cancelling)", () => {
    const html = ReactDOMServer.renderToString(
      <ChatComposer onSubmit={() => {}} isLoading={true} canCancel={false} onInterrupt={() => {}} />,
    );
    expect(html).toContain("lucide-square");
    expect(html).toContain('disabled=""');
  });

  // 默认状态（无 canCancel/isLoading）渲染 Send 图标——回归保护，与既有行为一致
  test("renders Send icon by default", () => {
    const html = ReactDOMServer.renderToString(<ChatComposer onSubmit={() => {}} />);
    expect(html).toContain("lucide-send");
    expect(html).not.toContain("lucide-square");
  });
});

// ── 交互测试（happy-dom + react-dom/client）──
// 补 P2-5：SSR 字符串断言只验证了渲染结果，未覆盖 onClick 分支。
// 以下用例直接渲染并点击按钮，验证 canCancel 时点击走 onInterrupt 而非 handleSubmit。

describe("ChatComposer interaction", () => {
  // 连续引用应同步更新预算；发送时引用作为本轮原子字段提交，方形卡不暴露正文。
  test("bounds synchronous quotes and submits hidden quote context", () => {
    let emit: ((event: ComposerExternalEvent) => void) | undefined;
    let submitted: SubmittedMessage | undefined;
    const props: MigratedComposerProps = {
      contextScope: "session-a",
      onSubmit: (message) => {
        submitted = message;
      },
      subscribeExternal: (handler) => {
        emit = handler;
        return () => {
          emit = undefined;
        };
      },
    };
    mount(props);

    act(() => {
      emit?.({ type: "quote", quote: { text: "甲".repeat(4_000) } });
      emit?.({ type: "quote", quote: { text: "乙".repeat(4_000) } });
      emit?.({ type: "quote", quote: { text: "丙".repeat(4_000) } });
    });

    expect(container.querySelectorAll('[data-slot="chat-composer-quote"]').length).toBe(2);
    expect(container.querySelectorAll('[data-slot="chat-composer-quote-preview"]').length).toBe(2);
    const button = findActionButton(container);
    act(() => (button as unknown as HTMLButtonElement).click());
    expect(submitted?.quoteContext).toContain("甲".repeat(100));
    expect(submitted?.quoteContext).toContain("乙".repeat(100));
    expect(submitted?.quoteContext).not.toContain("丙");
  });

  // 切换确定性会话 scope 时清空旧引用，避免旧会话上下文进入新会话。
  test("clears quote tiles when context scope changes", () => {
    let emit: ((event: ComposerExternalEvent) => void) | undefined;
    const subscribe: ComposerExternalSubscribe = (handler) => {
      emit = handler;
      return () => {
        emit = undefined;
      };
    };
    const props: MigratedComposerProps = {
      contextScope: "session-a",
      onSubmit: () => {},
      subscribeExternal: subscribe,
    };
    mount(props);

    act(() => {
      emit?.({ type: "quote", quote: { text: "旧会话" } });
    });
    expect(container.querySelectorAll('[data-slot="chat-composer-quote"]').length).toBe(1);

    mount({ ...props, contextScope: "session-b" });
    expect(container.querySelectorAll('[data-slot="chat-composer-quote"]').length).toBe(0);
  });

  // canCancel（running 输出中）时点击按钮：只触发 onInterrupt，不触发 onSubmit——
  // 这是断点 1 的核心交互：输出期间点停止必须走取消链路而不是重发消息
  test("click calls onInterrupt when canCancel is true", () => {
    let submitCalls = 0;
    let interruptCalls = 0;
    mount({
      onSubmit: () => {
        submitCalls += 1;
      },
      onInterrupt: () => {
        interruptCalls += 1;
      },
      canCancel: true,
    });

    const button = findActionButton(container);
    expect(button).not.toBeNull();
    expect(button?.querySelector("svg.lucide-square")).not.toBeNull();
    act(() => (button as unknown as HTMLButtonElement).click());
    expect(interruptCalls).toBe(1);
    expect(submitCalls).toBe(0);
  });

  // cancelling（isLoading 且 canCancel=false，取消已发出）时按钮禁用：
  // 点击无任何动作，防止重复点触发无意义的重发 cancel RPC
  test("click is no-op when cancelling (isLoading && !canCancel)", () => {
    let submitCalls = 0;
    let interruptCalls = 0;
    mount({
      onSubmit: () => {
        submitCalls += 1;
      },
      onInterrupt: () => {
        interruptCalls += 1;
      },
      isLoading: true,
      canCancel: false,
    });

    const button = findActionButton(container);
    expect(button).not.toBeNull();
    expect(button?.hasAttribute("disabled")).toBe(true);
    act(() => (button as unknown as HTMLButtonElement).click());
    expect(interruptCalls).toBe(0);
    expect(submitCalls).toBe(0);
  });
});
