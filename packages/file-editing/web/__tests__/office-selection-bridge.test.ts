import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bindOfficeSelectionBridge } from "../editors/office-selection-bridge";

// 仅当前 iframe 后代且来源、通道都匹配的插件消息可以引用；销毁后失效。
test("accepts only the bound editor source and nonce", () => {
  const win = new Window({ settings: { disableIframePageLoading: true } });
  const root = win.document.createElement("div");
  const frame = win.document.createElement("iframe");
  frame.srcdoc = "<p>provider</p>";
  root.append(frame);
  win.document.body.append(root);
  const source = frame.contentWindow;
  if (!source) throw new Error("iframe window missing");
  const received: unknown[] = [];
  const bindings: Array<{ channel: string }> = [];
  let active = true;
  source.postMessage = ((data: { channel: string }) => bindings.push(data)) as typeof source.postMessage;
  const dispose = bindOfficeSelectionBridge(root as unknown as HTMLElement, "https://office.example", {
    active: () => active,
    onSelection: (selection) => received.push(selection),
    onError: () => {},
  });
  const send = (origin: string, action: string, channel?: string) =>
    win.dispatchEvent(
      new win.MessageEvent("message", {
        origin,
        source,
        data: { type: "fenix-office-selection", action, channel, text: "chosen" },
      }),
    );
  send("https://wrong.example", "ready");
  expect(bindings).toHaveLength(0);
  win.dispatchEvent(
    new win.MessageEvent("message", {
      origin: "https://office.example",
      source: win,
      data: { type: "fenix-office-selection", action: "ready" },
    }),
  );
  expect(bindings).toHaveLength(0);
  send("https://office.example", "ready");
  expect(bindings).toHaveLength(1);
  send("https://office.example", "selection", "wrong-channel");
  expect(received).toEqual([]);
  send("https://office.example", "selection", bindings[0]?.channel);
  expect(received).toEqual([{ text: "chosen" }]);
  active = false;
  send("https://office.example", "selection", bindings[0]?.channel);
  expect(received).toHaveLength(1);
  dispose();
  send("https://office.example", "selection", bindings[0]?.channel);
  expect(received).toHaveLength(1);
});
