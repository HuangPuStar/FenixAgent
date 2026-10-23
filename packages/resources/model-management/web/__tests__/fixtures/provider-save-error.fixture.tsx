import { spyOn } from "bun:test";
import { strict as assert } from "node:assert";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { toast } from "sonner";
import { MODELS_NS, modelManagementResources } from "../../i18n";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const { useAgentModelsData } = await import("../../pages/agent-panel/pages/agent-models-data");
const scenario = process.argv[2];
assert.ok(scenario === "duplicate" || scenario === "generic");
const messages: string[] = [];
const toastSpy = spyOn(toast, "error").mockImplementation((message) => {
  messages.push(String(message));
  return "test-toast";
});
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input, init) =>
  Response.json(
    init?.method === "POST"
      ? {
          success: false,
          error: { code: scenario === "duplicate" ? "ALREADY_EXISTS" : "SERVER_ERROR", message: "Save failed" },
        }
      : { success: true, data: { providers: [] } },
    { status: init?.method === "POST" ? (scenario === "duplicate" ? 409 : 500) : 200 },
  )) as typeof fetch;
const instance = createInstance();
await instance.use(initReactI18next).init({
  lng: "zh",
  ns: [MODELS_NS],
  resources: { zh: { [MODELS_NS]: modelManagementResources.zh } },
});
let controller: ReturnType<typeof useAgentModelsData> | undefined;
/** 仅挂载真实数据控制器，失败反馈通过 sonner 出口观察。 */
function Harness() {
  controller = useAgentModelsData();
  return null;
}
const root = createRoot(document.createElement("div"));
try {
  await act(async () => {
    root.render(createElement(I18nextProvider, { i18n: instance }, createElement(Harness)));
  });
  assert.ok(controller);
  const saveProvider = controller.saveProvider;
  await act(async () => {
    await assert.rejects(
      saveProvider.runAsync(
        {
          configName: "  e2e-provider  ",
          displayName: { value: "不同的展示名称", edited: true },
          protocol: "openai",
          apiKey: "",
          baseURL: { value: "", edited: false },
          selectedModels: [],
        },
        null,
      ),
      { message: "Save failed" },
    );
  });
  assert.deepEqual(messages, [
    scenario === "duplicate" ? '服务商 "e2e-provider" 已存在，请更换名称' : "保存失败: Save failed",
  ]);
} finally {
  await act(async () => root.unmount());
  globalThis.fetch = originalFetch;
  toastSpy.mockRestore();
}
