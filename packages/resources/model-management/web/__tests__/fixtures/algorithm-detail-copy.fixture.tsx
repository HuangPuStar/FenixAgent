import assert from "node:assert/strict";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";

const shouldCopy = process.argv[2] === "success";
assert.ok(shouldCopy || process.argv[2] === "failure", "Unknown copy scenario");

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
globals.IS_REACT_ACT_ENVIRONMENT = true;
for (const key of [
  "document",
  "navigator",
  "CustomEvent",
  "DocumentFragment",
  "Element",
  "Event",
  "HTMLElement",
  "HTMLButtonElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
  "customElements",
]) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.window = win;
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globals.getComputedStyle = win.getComputedStyle.bind(win);

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createInstance } = await import("i18next");
const { I18nextProvider } = await import("react-i18next");
const { initReactI18next } = await import("react-i18next/initReactI18next");
const { toast } = await import("sonner");
const { MODELS_NS } = await import("../../i18n/namespace");
const { AlgorithmDetailDialog } = await import("../../src/pages/agent-panel/pages/AlgorithmDetailDialog");

const i18n = createInstance();
await i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [MODELS_NS],
  defaultNS: MODELS_NS,
  initAsync: false,
  resources: {
    en: { [MODELS_NS]: { algorithms: { copyCode: "Copy code", copied: "Copied", copyFailed: "Copy failed" } } },
  },
});

const code = "first line\nsecond line";
let clipboardValue = "previous clipboard value";
let selectedAtCopy = "";
let writeTextCalls = 0;
Object.defineProperty(win, "isSecureContext", { configurable: true, value: false });
Object.defineProperty(win.navigator, "clipboard", {
  configurable: true,
  value: {
    writeText: async () => {
      writeTextCalls += 1;
    },
  },
});
win.document.execCommand = (() => {
  selectedAtCopy = win.getSelection()?.toString() ?? "";
  if (shouldCopy) clipboardValue = selectedAtCopy;
  return shouldCopy;
}) as typeof win.document.execCommand;

const container = win.document.createElement("div") as unknown as HTMLElement;
win.document.body.appendChild(container);
const root = createRoot(container);
try {
  await act(async () => {
    root.render(
      createElement(
        I18nextProvider,
        { i18n },
        createElement(AlgorithmDetailDialog, {
          algorithm: {
            id: "test",
            name: "Test",
            emoji: "🧪",
            categories: [],
            description: "",
            code,
            params: [],
            scenes: [],
          },
          open: true,
          onClose: () => {},
        }),
      ),
    );
  });
  const button = [...win.document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === "Copy code",
  );
  assert.ok(button, "Copy button must be rendered in the real dialog DOM");
  await act(async () => {
    button.click();
  });
  assert.equal(writeTextCalls, 0);
  assert.equal(selectedAtCopy, code);
  assert.equal(clipboardValue, shouldCopy ? code : "previous clipboard value");
  const notifications = toast.getHistory();
  assert.equal(notifications.length, 1);
  const notification = notifications[0];
  assert.ok(notification && "type" in notification);
  assert.equal(notification.type, shouldCopy ? "success" : "error");
  assert.equal(notification.title, shouldCopy ? "Copied" : "Copy failed");
} finally {
  act(() => root.unmount());
  await new Promise((resolve) => setTimeout(resolve, 0));
  win.close();
}
