// web/src/__tests__/composer-paste-image.test.tsx
// ChatComposer（输入岛）「粘贴图片 → 落成待发送资产」的接线契约。
//
// 为什么在这一层钉：粘贴处理在包内（`@fenix/ui-components/chat/composer`），但能不能落成资产取决于
// 宿主注入的两个端口——`supportsImages`（agent 是否声明可收 ACP 图片内容块）与 `uploadFiles`
// （workspace 上传端口，拖拽上传与文件选择器走同一条通路）。这里用**真实组件 + 宿主端口替身**，
// 逐条钉住两条通路的判据与失败分支，而不是断言包内实现细节。
//
// 修复前的现象：`supportsImages` 由宿主从能力投影派生（实际恒为 false，见 report 的根因链），
// 而旧 `handlePaste` 在 `!supportsImages` 时直接 `return`——粘贴图片在真实界面上「什么都没发生」，
// 既不落资产也没有任何回执。修复后：
// - agent 声明图片能力 → 仍走内联 base64 图片资产（旧行为，未变）；
// - 否则复用拖拽上传/文件选择那条 workspace 上传通路，图片落成文件资产（`@./user/<name>`）随消息发出；
// - 两条通路都不可用时给出明确回执，不再静默丢弃。
//
// 断言口径：文案一律取包内字典 `uiComponentsResources.en`（`t()` 的真实取值），不写死英文串。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatComposer } from "@fenix/ui-components/chat/composer/ChatComposer";
import type { ComposerNotice } from "@fenix/ui-components/chat/composer/composer-handlers";
import type { FileAttachment } from "@fenix/ui-components/chat/types";
import { uiComponentsResources } from "@fenix/ui-components/i18n";
import { UI_COMPONENTS_NS } from "@fenix/ui-components/i18n/namespace";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";

const window = initializeHappyDomWindow(new Window());
const globalRecord = globalThis as Record<string, unknown>;
globalRecord.window = window;
globalRecord.document = window.document;
globalRecord.navigator = window.navigator;
// HTML 元素构造器与自定义元素注册表必须成对注入（前端规范 §11.2）；FileReader 必须与 happy-dom
// 的 Blob 同源，否则 `processImageFiles` 的 base64 编码在测试里抛错。
globalRecord.HTMLElement = window.HTMLElement;
globalRecord.customElements = window.customElements;
globalRecord.FileReader = window.FileReader;
globalRecord.IS_REACT_ACT_ENVIRONMENT = true;

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: uiComponentsResources.en } },
});

const COMPOSER_COPY = uiComponentsResources.en.chat.components.chatComposer;
const ASSET_COPY = uiComponentsResources.en.chat.components.composerAssets;

/** 提交载荷（`onSubmit` 收到的 `ChatInputMessage`）。 */
type Submitted = Parameters<Parameters<typeof ChatComposer>[0]["onSubmit"]>[0];

/** 一次挂载的句柄：容器、root，以及集中留存的提交载荷与用户提示。 */
interface MountedComposer {
  container: HTMLElement;
  root: Root;
  submitted: Submitted[];
  notices: ComposerNotice[];
}

/** 挂载真实的 ChatComposer，并把提交载荷与用户提示集中留存供断言。 */
function mountComposer(props: Omit<Parameters<typeof ChatComposer>[0], "onSubmit">): MountedComposer {
  const submitted: Submitted[] = [];
  const notices: ComposerNotice[] = [];
  const host = window.document.createElement("div");
  window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
  const root: Root = createRoot(host as unknown as HTMLElement);
  act(() => {
    root.render(
      <I18nextProvider i18n={i18n}>
        <ChatComposer
          {...props}
          onSubmit={(message) => submitted.push(message)}
          onNotice={(notice) => notices.push(notice)}
        />
      </I18nextProvider>,
    );
  });
  return { container: host as unknown as HTMLElement, root, submitted, notices };
}

/** 构造剪贴板替身：happy-dom 无真实 DataTransfer，粘贴只消费 `files` / `items` 两个入口。 */
function clipboardOf(files: File[], options: { itemsOnly?: boolean } = {}): DataTransfer {
  const items = files.map((file) => ({
    kind: "file",
    type: file.type,
    getAsFile: () => file,
  }));
  // itemsOnly 模拟「files 为空、图片只在 items 里」的来源（从网页复制图片、部分截图工具）
  return { files: options.itemsOnly ? [] : files, items } as unknown as DataTransfer;
}

/** 在输入框上派发一次粘贴（先聚焦，与真实粘贴的前提一致）。 */
function paste(container: HTMLElement, clipboard: DataTransfer): Event {
  const textarea = textareaOf(container);
  const event = new window.ClipboardEvent("paste", { bubbles: true, cancelable: true });
  // happy-dom 的 ClipboardEvent init 只接受它自己的 DataTransfer 类型，这里直接挂属性：
  // React 以 `"clipboardData" in event` 判定后原样取用（见 react-dom 的 clipboardData 分支）。
  Object.defineProperty(event, "clipboardData", { value: clipboard, configurable: true });
  act(() => {
    textarea.focus();
    textarea.dispatchEvent(event as unknown as Event);
  });
  return event as unknown as Event;
}

/** 取正文输入框与待发送资产行的稳定锚点。 */
function textareaOf(container: HTMLElement): HTMLTextAreaElement {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("输入岛未渲染 textarea");
  return textarea as unknown as HTMLTextAreaElement;
}

function assetTiles(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll('[data-slot="chat-composer-asset"]')) as unknown as HTMLElement[];
}

/** 点击发送按钮（包内锚点 `data-slot="chat-composer-send"`），并在同一个 act 内冲刷状态。 */
function clickSend(container: HTMLElement): void {
  const send = container.querySelector('[data-slot="chat-composer-send"]');
  if (!send) throw new Error("未找到发送按钮");
  act(() => (send as unknown as HTMLButtonElement).click());
}

/** 等待挂起的异步通路（上传 promise 与 happy-dom 的 FileReader 都可能落在后几轮事件循环）。 */
async function flush(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 造一张图片文件（happy-dom 的 File 与 FileReader 同源，base64 编码可跑通）。 */
function imageFile(name: string, bytes = [1, 2, 3]): File {
  return new window.File([new Uint8Array(bytes)], name, { type: "image/png" }) as unknown as File;
}

/** 只做体积/名字判定的超大文件替身，避免真的分配 100MB 内存。 */
function oversizedImage(name: string): File {
  return { name, type: "image/png", size: 101 * 1024 * 1024 } as unknown as File;
}

/** 无文件名的剪贴板图片（浏览器只给 MIME 类型、不给文件名的来源）。 */
function unnamedImage(): File {
  return new window.File([new Uint8Array([7, 8, 9])], "", { type: "image/png" }) as unknown as File;
}

/** 记录上传端口收到的批次，并按 workspace 相对路径返回附件。 */
function recordingUpload(): { calls: File[][]; upload: (files: File[]) => Promise<FileAttachment[]> } {
  const calls: File[][] = [];
  return {
    calls,
    upload: async (files) => {
      calls.push(files);
      return files.map((file) => ({ name: file.name, path: `user/${file.name}` }));
    },
  };
}

let mounted: MountedComposer | null = null;

afterEach(() => {
  if (mounted) act(() => mounted?.root.unmount());
  mounted = null;
});

describe("ChatComposer 粘贴图片", () => {
  // 业务意图：agent 未声明图片能力（真实环境的常态）时，粘贴的图片必须仍然落成资产——走拖拽上传
  // 那条同一条 workspace 上传通路，而不是静默丢弃；资产随消息以 `@./user/<name>` 引用发出。
  test("粘贴单张图片：走宿主上传端口落成文件资产，并随消息以 @./ 引用发出", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container, submitted } = mounted;

    paste(container, clipboardOf([imageFile("shot.png")]));
    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]?.name).toBe("shot.png");
    expect(assetTiles(container).length).toBe(1);
    expect(container.textContent).toContain("shot.png");
    // 正文补上 workspace 引用：agent 据此读图，且与拖拽上传/文件选择的既有约定一致
    expect(textareaOf(container).value).toBe("@./user/shot.png ");

    clickSend(container);
    expect(submitted.length).toBe(1);
    expect(submitted[0]?.attachments).toEqual([{ name: "shot.png", path: "user/shot.png" }]);
    expect(submitted[0]?.images).toBeUndefined();
  });

  // 业务意图：一次粘贴多张图要整批交给同一条上传通路（后端一次 multipart 携带全部文件），
  // 每张都落成资产；分批上传会产生多条请求且中途失败会留下半套资产。
  test("粘贴多张图片：整批进入同一次上传，全部落成资产", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container } = mounted;

    paste(container, clipboardOf([imageFile("a.png"), imageFile("b.png", [4, 5, 6])]));
    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0]?.map((file) => file.name)).toEqual(["a.png", "b.png"]);
    expect(assetTiles(container).length).toBe(2);
    expect(textareaOf(container).value).toBe("@./user/a.png @./user/b.png ");
    // 焦点不被抢走：粘贴发生在输入框内，处理完仍应停在原处（用户要继续打字）；
    // happy-dom 的 Element 与 lib.dom 的 Element 不是同一份声明，故按 unknown 比对身份
    expect((window.document.activeElement as unknown) === (textareaOf(container) as unknown)).toBe(true);
  });

  // 业务意图：粘贴是「叠加」语义——已有附件时新增资产，不能覆盖用户已经选好的待发送内容。
  test("粘贴时已有其他附件：新增资产叠加，已有资产不丢失", async () => {
    const { upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container, submitted } = mounted;

    paste(container, clipboardOf([imageFile("first.png")]));
    await flush();
    paste(container, clipboardOf([imageFile("second.png")]));
    await flush();

    expect(assetTiles(container).length).toBe(2);
    expect(container.textContent).toContain("first.png");
    expect(container.textContent).toContain("second.png");

    clickSend(container);
    expect(submitted[0]?.attachments).toEqual([
      { name: "first.png", path: "user/first.png" },
      { name: "second.png", path: "user/second.png" },
    ]);
  });

  // 业务意图：非图片粘贴（纯文本）必须保持浏览器默认行为——一旦被 preventDefault 吞掉，
  // 用户粘贴文字时会「什么都没进去」，这是比图片粘贴失效更严重的回归。
  test("粘贴非图片内容：不拦截默认文本粘贴，也不产生资产", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container } = mounted;

    // 文本剪贴板：files / items 均为空（浏览器只会把 text/plain 交给默认粘贴）
    const event = paste(container, clipboardOf([]));

    expect(event.defaultPrevented).toBe(false);
    expect(calls.length).toBe(0);
    expect(assetTiles(container).length).toBe(0);
    expect(textareaOf(container).value).toBe("");
  });

  // 业务意图：agent 声明可收图片内容块时，粘贴仍走内联 base64 图片资产（模型直接看到像素，
  // 不必再读 workspace 文件），且不得再额外上传一份——两条通路只能命中一条。
  test("粘贴图片且 agent 支持图片：走内联 base64 图片资产，不上传", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: true, uploadFiles: upload });
    const { container, submitted } = mounted;

    paste(container, clipboardOf([imageFile("inline.png")]));
    await flush();

    expect(calls.length).toBe(0);
    expect(assetTiles(container).length).toBe(1);
    const preview = container.querySelector('[data-slot="chat-composer-asset"] img');
    expect(preview?.getAttribute("src")?.startsWith("data:image/png;base64,")).toBe(true);

    clickSend(container);
    expect(submitted[0]?.images).toEqual([{ mimeType: "image/png", data: expect.any(String) }]);
    expect(submitted[0]?.attachments).toBeUndefined();
  });

  // 业务意图：上传失败必须给用户回执（否则「粘贴后什么都没发生」正是本次问题的最初症状），
  // 同时不得污染正文或留下半套资产。
  test("上传失败：给出失败提示，不产生资产也不改写正文", async () => {
    mounted = mountComposer({
      supportsImages: false,
      uploadFiles: async () => {
        throw new Error("network down");
      },
    });
    const { container, notices } = mounted;

    paste(container, clipboardOf([imageFile("shot.png")]));
    await flush();

    expect(notices.length).toBe(1);
    expect(notices[0]?.level).toBe("error");
    expect(notices[0]?.message).toBe(COMPOSER_COPY.uploadFailed);
    expect(assetTiles(container).length).toBe(0);
    expect(textareaOf(container).value).toBe("");
  });

  // 业务意图：体积校验失败要在**发起上传前**拦截并报出上限（与拖拽上传/文件选择同一条校验），
  // 不能让用户等一次注定失败的大文件上传。
  test("超过 100MB 的图片：上传前拦截并提示体积上限", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container, notices } = mounted;

    paste(container, clipboardOf([oversizedImage("huge.png")]));
    await flush();

    expect(calls.length).toBe(0);
    expect(notices[0]?.level).toBe("error");
    expect(notices[0]?.message).toBe(COMPOSER_COPY.fileTooLarge);
    expect(assetTiles(container).length).toBe(0);
  });

  // 业务意图：粘贴后到资产出现之间有一段上传/编码窗口，必须让用户看到「正在处理」，
  // 否则用户会重复粘贴（同一张图进两遍）。状态行以 role="status" 对读屏软件播报。
  test("粘贴处理中：显示进行中状态，完成后消失并落成资产", async () => {
    let finishUpload: (() => void) | undefined;
    mounted = mountComposer({
      supportsImages: false,
      uploadFiles: (files) =>
        new Promise<FileAttachment[]>((resolve) => {
          finishUpload = () => resolve(files.map((file) => ({ name: file.name, path: `user/${file.name}` })));
        }),
    });
    const { container } = mounted;

    paste(container, clipboardOf([imageFile("slow.png")]));
    await flush();

    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe(COMPOSER_COPY.pastingImages.replace("{{count}}", "1"));
    expect(assetTiles(container).length).toBe(0);

    finishUpload?.();
    await flush();

    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(assetTiles(container).length).toBe(1);
  });

  // 业务意图：部分来源只把图片放进 `clipboardData.items`（`files` 为空）——只读 `files` 的实现会
  // 把这类粘贴当成「没有图片」直接放行，用户看到的仍是「粘贴没反应」。
  test("图片只出现在 clipboardData.items 时：仍能落成资产", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container } = mounted;

    paste(container, clipboardOf([imageFile("from-items.png")], { itemsOnly: true }));
    await flush();

    expect(calls[0]?.map((file) => file.name)).toEqual(["from-items.png"]);
    expect(assetTiles(container).length).toBe(1);
  });

  // 业务意图：应用内位图/file promise 类剪贴板不给文件名，而服务端上传门面按空文件名返回 400；
  // 不补名的话这类粘贴只能看到「文件上传失败」，等于粘贴依旧不可用。
  test("剪贴板图片没有文件名：补名后照常上传", async () => {
    const { calls, upload } = recordingUpload();
    mounted = mountComposer({ supportsImages: false, uploadFiles: upload });
    const { container } = mounted;

    paste(container, clipboardOf([unnamedImage()]));
    await flush();

    expect(calls.length).toBe(1);
    expect(calls[0]?.[0]?.name).toMatch(/^pasted-image-\d+-1\.png$/);
    expect(assetTiles(container).length).toBe(1);
  });

  // 业务意图：宿主既没给上传端口、agent 也不支持图片时，粘贴不能静默无反应——给可见回执，
  // 但不 preventDefault（剪贴板里可能还带文本，吞掉默认行为会让用户连文本都拿不到）。
  test("两条通路都不可用：给出明确回执，不静默丢弃也不吞掉默认粘贴", async () => {
    mounted = mountComposer({ supportsImages: false });
    const { container, notices } = mounted;

    const event = paste(container, clipboardOf([imageFile("shot.png")]));
    await flush();

    expect(event.defaultPrevented).toBe(false);
    expect(notices[0]?.level).toBe("error");
    expect(notices[0]?.message).toBe(ASSET_COPY.pasteImageUnsupported);
    expect(assetTiles(container).length).toBe(0);
  });

  // 业务意图：内联通路上压缩/编码失败的单张图片会被剔除出结果，若不比对数量就会静默少一张；
  // 用户必须收到「部分图片处理失败」的回执（本次要覆盖的失败分支之一）。
  test("内联图片处理失败：提示部分图片被跳过", async () => {
    mounted = mountComposer({
      supportsImages: true,
      // 超过 2MiB 阈值才会走压缩端口：让压缩失败，模拟解码/压缩失败的图片
      compressImage: async () => {
        throw new Error("decode failed");
      },
    });
    const { container, notices } = mounted;

    const big = { name: "big.png", type: "image/png", size: 3 * 1024 * 1024 } as unknown as File;
    paste(container, clipboardOf([big]));
    await flush();

    expect(notices[0]?.level).toBe("error");
    expect(notices[0]?.message).toBe(ASSET_COPY.processImagePartialFailed);
    expect(assetTiles(container).length).toBe(0);
  });
});

beforeEach(() => {
  // 每个用例独占挂载点：上一条用例卸载后 DOM 里不留残留资产行
  window.document.body.innerHTML = "";
});
