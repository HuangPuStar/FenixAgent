import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToReadableStream } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { MessageResponse, type MessageResponseProps } from "../chat/primitives/message";
import type { AssistantMessageEntry } from "../chat/types";
import { UI_SPEC_LANGUAGE, UI_SPEC_PLUGINS } from "../chat/ui-spec/plugins";
import { UISpecHostProvider, useUISpecHost } from "../chat/ui-spec/UISpecHostContext";
import { AssistantBubble } from "../chat/view/MessageBubble";
import { i18n } from "./chat-style-migration-helpers";

const completeCode = JSON.stringify({
  version: 1,
  root: "text",
  elements: { text: { type: "Text", props: { text: "接线成功" } } },
});
const partialCode = '{"version":1,"root":"text","elements":';
const fence = (code: string, closed = false) => `\`\`\`ui-spec\n${code}${closed ? "\n```" : ""}`;

async function renderSettled(element: ReactNode) {
  const stream = await renderToReadableStream(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>);
  await stream.allReady;
  return new Response(stream).text();
}

describe("C-3 消息接线契约", () => {
  test("comparator 覆盖正文不变时的全部宿主 props", () => {
    const { compare } = MessageResponse as unknown as {
      compare: (previous: MessageResponseProps, next: MessageResponseProps) => boolean;
    };
    const previous: MessageResponseProps = { children: fence(partialCode), envId: "env-a" };
    expect(compare(previous, { ...previous })).toBe(true);
    for (const changed of [
      { children: fence(completeCode) },
      { envId: "env-b" },
      { sessionId: "session-b" },
      { isStreaming: true },
      { mode: "static" as const },
      { className: "wiring-class" },
    ]) {
      expect(compare(previous, { ...previous, ...changed })).toBe(false);
    }
  });

  test("插件仅注册 ui-spec，首次候选输入不盲等骨架", async () => {
    expect(UI_SPEC_LANGUAGE).toBe("ui-spec");
    expect(UI_SPEC_PLUGINS.renderers?.map((renderer) => renderer.language)).toEqual(["ui-spec"]);
    const html = await renderSettled(<MessageResponse isStreaming>{fence(completeCode)}</MessageResponse>);
    expect(html).toContain("接线成功");
    expect(html).not.toContain("&quot;version&quot;");
  });

  // 未闭合的 ui-spec 围栏在非流式时先补全再交给 streamdown：组件与尾随正文各自归位
  test("非流式未闭合围栏补全后组件与正文各自归位", async () => {
    const html = await renderSettled(<MessageResponse>{`${fence(completeCode)}\n\n尾随**加粗**说明`}</MessageResponse>);
    expect(html).toContain("接线成功");
    expect(html).toContain('data-streamdown="strong"');
    expect(html).not.toContain("&quot;version&quot;");
  });

  // 流式中的未闭合是正常中间态：不补全，避免后续增量落到围栏外
  test("流式未闭合围栏不补全", async () => {
    const html = await renderSettled(
      <MessageResponse isStreaming>{`${fence(completeCode)}\n\n尾随**加粗**说明`}</MessageResponse>,
    );
    expect(html).not.toContain('data-streamdown="strong"');
  });

  test("宿主 Context 相互隔离，未提供时为空", async () => {
    function HostProbe() {
      return <span>{useUISpecHost().envId ?? "no-env"}</span>;
    }
    const html = await renderSettled(
      <>
        <UISpecHostProvider value={{ envId: "env-a" }}>
          <HostProbe />
        </UISpecHostProvider>
        <UISpecHostProvider value={{ envId: "env-b" }}>
          <HostProbe />
        </UISpecHostProvider>
        <HostProbe />
      </>,
    );
    expect(html).toContain("<span>env-a</span><span>env-b</span><span>no-env</span>");
  });
});

describe("C-3 真实 MessageResponse 同实例更新", () => {
  let root: Root;
  let host: HTMLDivElement;
  let restore: () => void;

  beforeEach(() => {
    const window = initializeHappyDomWindow(new Window());
    const globals: Record<string, unknown> = {
      window,
      document: window.document,
      navigator: window.navigator,
      HTMLElement: window.HTMLElement,
      ResizeObserver: window.ResizeObserver,
      getComputedStyle: window.getComputedStyle.bind(window),
      requestAnimationFrame: window.requestAnimationFrame.bind(window),
      cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const originals = Object.keys(globals).map(
      (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
    );
    for (const [key, value] of Object.entries(globals)) {
      Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    }
    restore = () => {
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
      window.happyDOM.abort();
    };
    host = window.document.createElement("div") as unknown as HTMLDivElement;
    root = createRoot(host);
  });

  afterEach(async () => {
    try {
      await act(async () => root.unmount());
    } finally {
      restore();
    }
  });

  async function update(element: ReactNode) {
    await act(async () => root.render(<I18nextProvider i18n={i18n}>{element}</I18nextProvider>));
  }

  const hasRaw = () => Array.from(host.querySelectorAll("pre")).some((pre) => pre.textContent?.includes(partialCode));

  test("增量确认、停止、旧正文新候选、static、超时与恢复", async () => {
    const response = (code: string, props: MessageResponseProps = {}) => (
      <MessageResponse isStreaming {...props}>
        {fence(code)}
      </MessageResponse>
    );
    await update(response(partialCode));
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{`));
    expect(hasRaw()).toBe(false);
    await update(response(`${partialCode}{`, { isStreaming: false }));
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{`));
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{"text"`, { mode: "static" }));
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{"text"`));
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{"text":`));
    expect(hasRaw()).toBe(false);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 3100));
    });
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{"text":{`));
    expect(hasRaw()).toBe(false);
    await update(response(completeCode));
    await update(<MessageResponse isStreaming>{fence(completeCode, true)}</MessageResponse>);
    expect(host.textContent).toContain("接线成功");
  }, 10000);

  test("宿主切换清除增量；正文不变时 envId 和 className 仍更新", async () => {
    const response = (code: string, envId: string, sessionId: string) => (
      <MessageResponse envId={envId} sessionId={sessionId} isStreaming>
        {fence(code)}
      </MessageResponse>
    );
    await update(response(partialCode, "env-a", "session-a"));
    await update(response(`${partialCode}{`, "env-a", "session-a"));
    expect(hasRaw()).toBe(false);
    await update(response(`${partialCode}{`, "env-b", "session-a"));
    expect(hasRaw()).toBe(true);
    await update(response(`${partialCode}{"text"`, "env-b", "session-a"));
    expect(hasRaw()).toBe(false);
    await update(response(`${partialCode}{"text"`, "env-b", "session-b"));
    expect(hasRaw()).toBe(true);
    const markdown = "[文件](./user/report.txt)";
    await update(<MessageResponse envId="env-a">{markdown}</MessageResponse>);
    await update(
      <MessageResponse envId="env-b" className="wiring-class">
        {markdown}
      </MessageResponse>,
    );
    expect(host.querySelector("a")?.getAttribute("href")).toBe(
      "/web/environments/env-b/fs/user/report.txt?preview=true",
    );
    expect(host.querySelector(".message-response")?.classList.contains("wiring-class")).toBe(true);
  });

  test("仅最后 message chunk 活跃；末尾 thought 不反向激活旧正文", async () => {
    const entry = (code: string, thought = false): AssistantMessageEntry => ({
      type: "assistant_message",
      id: "wiring-entry",
      chunks: [
        { type: "message", text: fence(partialCode) },
        { type: "message", text: fence(code) },
        ...(thought ? [{ type: "thought" as const, text: "处理中" }] : []),
      ],
    });
    await update(<AssistantBubble entry={entry(partialCode)} isStreaming />);
    expect(host.querySelectorAll("pre").length).toBe(2);
    await update(<AssistantBubble entry={entry(`${partialCode}{`)} isStreaming />);
    expect(host.querySelectorAll("pre").length).toBe(1);
    await update(<AssistantBubble entry={entry(`${partialCode}{`, true)} isStreaming />);
    expect(host.querySelectorAll("pre").length).toBe(2);
  });
});
