import { afterAll, afterEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import type { PreviewFetch } from "../components/preview/preview-source";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const keys = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "customElements",
  "IS_REACT_ACT_ENVIRONMENT",
];
const saved = new Map(keys.map((key) => [key, globals[key]]));
for (const key of keys)
  globals[key] =
    key === "IS_REACT_ACT_ENVIRONMENT"
      ? true
      : key === "window"
        ? win
        : (win as unknown as Record<string, unknown>)[key];
const { FileViewerPreview } = await import("../components/preview/FileViewerPreview");
const i18n = createInstance();
void i18n.init({
  lng: "en",
  initAsync: false,
  defaultNS: UI_COMPONENTS_NS,
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  win.document.body.replaceChildren();
});
afterAll(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

async function mount(
  filePath = "user/report.html",
  fetchPreview: PreviewFetch = async () => new Response("<h1>report</h1>"),
) {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  const buildPreviewUrl = () => "/preview/report?preview=true";
  await act(async () => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <FileViewerPreview
          envId="env-1"
          filePath={filePath}
          buildPreviewUrl={buildPreviewUrl}
          fetchPreview={fetchPreview}
          toolbarActions={<button type="button">Edit</button>}
        />
      </I18nextProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return host;
}

// 下载必须保留原始文件地址和文件名；文件操作在同一工具栏中，图标按钮仍有可访问名称。
test("preview toolbar exposes an icon download with the original filename alongside host actions", async () => {
  const host = await mount();
  const download = host.querySelector<HTMLAnchorElement>('a[aria-label="Download"]');
  expect(download).not.toBeNull();
  expect(download?.getAttribute("href")).toBe("/preview/report?preview=true");
  expect(download?.download).toBe("report.html");
  expect(download?.textContent).toBe("");
  expect(download?.parentElement?.textContent).toBe("Edit");
});

// 全屏只扩展页面内区域，退出不能重建 HTML iframe，避免丢失预览位置和内部状态。
test("preview expands inside the page and Escape preserves the same preview iframe", async () => {
  const host = await mount();
  const frame = host.querySelector("iframe");
  expect(frame).not.toBeNull();
  const expand = host.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]');
  expect(expand).not.toBeNull();
  expect(expand?.textContent).toBe("");
  act(() => expand?.click());
  expect(host.querySelector(".fixed.inset-0")).not.toBeNull();
  expect(host.querySelector('button[aria-label="Exit fullscreen"]')).not.toBeNull();
  expect(document.fullscreenElement).toBeFalsy();
  const dialog = document.createElement("div");
  dialog.setAttribute("role", "alertdialog");
  document.body.append(dialog);
  act(() =>
    expand?.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as KeyboardEvent,
    ),
  );
  expect(Boolean(host.querySelector(".fixed.inset-0"))).toBe(true);
  dialog.remove();
  expand?.addEventListener("keydown", (event) => event.stopPropagation());
  act(() =>
    expand?.dispatchEvent(
      new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }) as unknown as KeyboardEvent,
    ),
  );
  expect(host.querySelector(".fixed.inset-0")).toBeNull();
  expect(host.querySelector("iframe")).toBe(frame);
});

// 预览刷新必须重新读取当前文件，且不能把用户退出全屏或丢掉模式切换操作。
test("preview Refresh reloads the current file while retaining fullscreen and host actions", async () => {
  const host = await mount();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Fullscreen"]')?.click());
  const refresh = host.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]');
  expect(Boolean(refresh)).toBe(true);
  await act(async () => {
    refresh?.click();
    await Bun.sleep(20);
  });
  expect(host.querySelector("iframe")?.getAttribute("src")).toBe("/preview/report?preview=true&retry=1");
  expect(Boolean(host.querySelector(".fixed.inset-0"))).toBe(true);
  expect(host.querySelector('a[aria-label="Download"]')?.parentElement?.textContent).toBe("Edit");
});

// 连续刷新时，即使取数适配器在取消后仍回包，旧响应也不能覆盖最新文件内容。
test("preview Refresh ignores an older read that completes after the latest read", async () => {
  const replies: ((response: Response) => void)[] = [];
  const host = await mount("note.tex", () => new Promise((resolve) => replies.push(resolve)));
  await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="Refresh"]')?.click());
  expect(replies.length).toBe(2);
  await act(async () => {
    replies[1]?.(new Response("\\section{Latest preview}"));
  });
  for (let index = 0; index < 50 && !host.textContent?.includes("Latest preview"); index++)
    await act(async () => {
      await Bun.sleep(10);
    });
  expect(host.textContent).toContain("Latest preview");
  await act(async () => {
    replies[0]?.(new Response("\\section{Outdated preview}"));
    await Bun.sleep(30);
  });
  expect(host.textContent).toContain("Latest preview");
  expect(host.textContent).not.toContain("Outdated preview");
});
