// web/__tests__/openui-action-message.test.ts
// OpenUI 动作消息的纯逻辑契约：拼消息时的表单围栏、空消息拦截，以及 `open_url` 的协议白名单。
//
// 这两条都是「模型输出直接决定行为」的边界：拼接格式错了模型拿不到表单值；协议白名单漏了会把
// `javascript:` 链接交给浏览器。`openExternalUrl` 只依赖全局 `window.open`，用 happy-dom 注入
// 全局并在结束后成对还原，避免把测试窗口泄漏给同进程后续文件。

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { composeOpenUIActionMessage, openExternalUrl } from "../chat/openui/action-message";

const win = initializeHappyDomWindow(new Window());
let savedWindow: PropertyDescriptor | undefined;

beforeAll(() => {
  savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { value: win, configurable: true, writable: true });
});

afterAll(() => {
  if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

describe("composeOpenUIActionMessage", () => {
  // 只有人类可读消息：原样返回（去掉首尾空白），不加任何围栏
  test("无表单时只返回去掉首尾空白的消息", () => {
    const text = composeOpenUIActionMessage({
      type: "continue_conversation",
      params: {},
      humanFriendlyMessage: "  继续分析  ",
    });
    expect(text).toBe("继续分析");
  });

  // 表单值必须随消息带上，否则模型无法知道用户选了什么；格式固定为 json 围栏
  test("表单值追加为 json 围栏且与消息空行分隔", () => {
    const text = composeOpenUIActionMessage({
      type: "continue_conversation",
      params: {},
      humanFriendlyMessage: "应用筛选",
      formState: { region: "华东", limit: 3 },
    });
    expect(text).toBe('应用筛选\n\n```json\n{\n  "region": "华东",\n  "limit": 3\n}\n```');
  });

  // 空表单对象等同于没有表单：不能给模型留一个空围栏
  test("空表单对象不追加围栏", () => {
    const text = composeOpenUIActionMessage({
      type: "continue_conversation",
      params: {},
      humanFriendlyMessage: "继续",
      formState: {},
    });
    expect(text).toBe("继续");
    expect(text).not.toContain("```json");
  });

  // 消息与表单都为空时返回空串，调用方据此跳过发送
  test("消息与表单都为空时返回空串", () => {
    expect(composeOpenUIActionMessage({ type: "continue_conversation", params: {}, humanFriendlyMessage: "   " })).toBe(
      "",
    );
    expect(
      composeOpenUIActionMessage({
        type: "continue_conversation",
        params: {},
        humanFriendlyMessage: "",
        formState: {},
      }),
    ).toBe("");
  });
});

describe("openExternalUrl", () => {
  // http(s) 之外一律不开窗：模型可以输出任意字符串，javascript:/data: 必须在这里拦掉
  test("拒绝非 http(s) 与非字符串输入", () => {
    const open = spyOn(win, "open").mockImplementation(() => null);
    try {
      openExternalUrl("javascript:alert(1)");
      openExternalUrl("data:text/html,<script>alert(1)</script>");
      openExternalUrl("mailto:a@b.com");
      openExternalUrl("not a url");
      openExternalUrl(undefined);
      openExternalUrl(42);
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  // 合法外链以新标签页打开，并带上 noopener/noreferrer（与 Markdown 链接策略一致）
  test("http(s) 链接以新标签页打开", () => {
    const open = spyOn(win, "open").mockImplementation(() => null);
    try {
      openExternalUrl("https://example.com/report?id=1");
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith("https://example.com/report?id=1", "_blank", "noopener,noreferrer");
    } finally {
      open.mockRestore();
    }
  });
});
