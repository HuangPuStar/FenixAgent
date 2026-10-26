import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { registryApi } from "../api/registry";
import { MACHINE_NS, machineResources } from "../i18n";
import { MachineConnectionGuide } from "../pages/machine-connection-guide";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const originals = new Map(
  ["window", "document", "navigator", "HTMLElement", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [key, globals[key]]),
);
const i18n = createInstance();
await i18n.init({ lng: "zh", initAsync: false, resources: { zh: { [MACHINE_NS]: machineResources.zh } } });
let root: Root;
let container: HTMLElement;
let api: ReturnType<typeof spyOn<typeof registryApi, "connectionParameters">>;
beforeEach(() => {
  Object.assign(globals, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  container = win.document.createElement("div");
  root = createRoot(container);
  api = spyOn(registryApi, "connectionParameters").mockResolvedValue({
    success: true,
    data: { machineId: "mach-a", agentType: "peri", rcsUrl: "wss://platform.example" },
  });
});
afterEach(() => {
  act(() => root.unmount());
  api.mockRestore();
});
afterAll(() => {
  for (const [key, value] of originals) globals[key] = value;
  win.happyDOM.abort();
});
async function render() {
  act(() =>
    root.render(
      <I18nextProvider i18n={i18n}>
        <MachineConnectionGuide machineId="mach-a" organizationId="org-a" />
      </I18nextProvider>,
    ),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// 文档使用经过授权的参数并提供真实下载、软件入口和后续使用说明，不收集密钥。
test("文档包含自动带入的连接参数、下载和本地启动说明", async () => {
  await render();
  expect(api.mock.calls[0]).toEqual(["mach-a", "org-a"]);
  expect(container.querySelector("a[download]")?.getAttribute("href")).toBe("/web/registry/acp-runtime.js");
  expect(container.textContent).toContain("RCS_MACHINE_ID='mach-a'");
  expect(container.textContent).toContain("RCS_URL='wss://platform.example'");
  expect(container.textContent).toContain("bun ./acp-runtime.js peri acp");
  expect(container.textContent).toContain("启动后");
  expect(container.querySelector("a[href='https://bun.sh/']")).not.toBeNull();
  expect(container.querySelector("input")).toBeNull();
  expect(container.textContent).not.toContain("SUPPORTED_ENGINE_TYPES");
  expect(container.textContent).not.toContain("RCS_TENANT_ID");
  const lines = container.querySelector("pre code")?.textContent?.split("\n");
  expect(lines).toHaveLength(1);
  expect(lines?.[0]).toBe(
    "RCS_SECRET='自己填' RCS_URL='wss://platform.example' RCS_MACHINE_ID='mach-a' AGENT_TYPE='peri' bun ./acp-runtime.js peri acp",
  );
});

// 引擎由数据库记录决定，命令不能把所有引擎都当成 peri 启动。
test("根据引擎生成命令，不支持的引擎不生成启动命令", async () => {
  for (const [agentType, command] of [
    ["opencode", "opencode acp"],
    ["ccb", "ccb --acp"],
    ["claude-code", "claude-code"],
    ["unknown", null],
  ]) {
    api.mockResolvedValue({
      success: true,
      data: { machineId: "mach-a", agentType: agentType!, rcsUrl: "wss://platform.example" },
    });
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    if (command) expect(container.textContent).toContain(`bun ./acp-runtime.js ${command}`);
    else expect(container.textContent).not.toContain("bun ./acp-runtime.js");
    if (agentType === "claude-code") {
      const startupCommand = container.querySelector("pre code")?.textContent;
      expect(startupCommand?.split("\n")).toHaveLength(1);
      expect(startupCommand).toContain("RCS_SECRET='自己填'");
      expect(startupCommand).toContain('CLAUDE_CODE_CLI_PATH="$(command -v claude)"');
    }
    if (agentType === "opencode") {
      expect(container.textContent).toContain("必须安装指定版本");
      expect(container.textContent).toContain("npm install -g opencode-ai@1.17.12");
    } else {
      expect(container.textContent).not.toContain("opencode-ai@");
    }
  }
});

// 参数不可读取时不显示虚假的可执行命令，用户可以重试。
test("查询失败显示错误与重试入口", async () => {
  api.mockResolvedValue({ success: false, error: { code: "NOT_FOUND", message: "Machine not found" } });
  await render();
  expect(container.querySelector('[role="alert"]')).not.toBeNull();
  expect(container.textContent).not.toContain("bun ./acp-runtime.js");
  expect(container.querySelector("button")?.textContent).toContain("重试");
});
