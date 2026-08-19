import { describe, expect, test } from "bun:test";
import { CardEventEmitter } from "../lib/card-renderer/emitter";
import { buildProviderInlineTestPayload, getProviderColor } from "../pages/agent-panel/pages/agent-models-utils";

describe("CardEventEmitter", () => {
  // 同一事件的多个订阅者应按订阅关系接收原始载荷。
  test("向全部订阅者分发载荷", () => {
    const emitter = new CardEventEmitter();
    const received: string[] = [];

    emitter.on("select", (payload) => received.push(`first:${String(payload)}`));
    emitter.on("select", (payload) => received.push(`second:${String(payload)}`));
    emitter.emit("select", "site-1");

    expect(received).toEqual(["first:site-1", "second:site-1"]);
  });

  // 取消订阅后，仅该处理器停止接收事件，其他订阅关系不受影响。
  test("取消订阅只移除对应处理器", () => {
    const emitter = new CardEventEmitter();
    const received: string[] = [];
    const removedHandler = (payload: unknown) => received.push(`removed:${String(payload)}`);

    const unsubscribe = emitter.on("change", removedHandler);
    emitter.on("change", (payload) => received.push(`retained:${String(payload)}`));
    unsubscribe();
    emitter.emit("change", 42);
    emitter.off("unknown", removedHandler);

    expect(received).toEqual(["retained:42"]);
  });

  // 未订阅事件和销毁后的事件均应安全忽略，避免清理流程抛错或泄漏旧监听器。
  test("忽略未订阅事件并在销毁后清空监听器", () => {
    const emitter = new CardEventEmitter();
    let calls = 0;

    emitter.emit("missing");
    emitter.on("close", () => {
      calls += 1;
    });
    emitter.destroy();
    emitter.emit("close");

    expect(calls).toBe(0);
  });
});

describe("Provider 纯转换工具", () => {
  // 品牌名称匹配应忽略大小写，未知名称回退为稳定的默认灰色。
  test("解析品牌色并处理未知名称", () => {
    expect(getProviderColor("My OpenAI Proxy")).toBe("#10a37f");
    expect(getProviderColor("QWEN")).toBe("#615ced");
    expect(getProviderColor("custom-provider")).toBe("#64748b");
  });

  // 仅空白凭据不能进入连通性请求，非空输入保持原样以避免意外修改用户配置。
  test("构建连通性请求时排除空白字段", () => {
    expect(
      buildProviderInlineTestPayload({
        apiKey: "   ",
        baseURL: "",
        protocol: "anthropic",
      }),
    ).toEqual({ apiKey: undefined, baseURL: undefined, protocol: "anthropic" });
    expect(
      buildProviderInlineTestPayload({
        apiKey: " key-with-space ",
        baseURL: " https://proxy.example.com ",
        protocol: "openai",
      }),
    ).toEqual({
      apiKey: " key-with-space ",
      baseURL: " https://proxy.example.com ",
      protocol: "openai",
    });
  });
});
