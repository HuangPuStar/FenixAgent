import { describe, expect, mock, test, afterEach } from "bun:test";

import { setHermesClientGetter } from "../services/channel-provider";
import { listChannelProviders, getChannelProvider } from "../services/channel-provider";

describe("channel provider registry", () => {
  afterEach(() => {
    setHermesClientGetter(null);
  });

  test("listChannelProviders 无 Hermes 时返回全部 disabled", () => {
    setHermesClientGetter(() => null);
    const providers = listChannelProviders();
    expect(providers.every((provider) => provider.status === "disabled")).toBe(true);
    expect(providers).toHaveLength(2);
  });

  test("getChannelProvider returns descriptor for known type and undefined otherwise", () => {
    expect(getChannelProvider("wechat")).toBeDefined();
    expect(getChannelProvider("unknown")).toBeUndefined();
  });
});

describe("channel provider with Hermes connected", () => {
  afterEach(() => {
    setHermesClientGetter(null);
  });

  test("Hermes 已连接时对应平台为 enabled", () => {
    setHermesClientGetter(() => ({
      getStatus: () => ({
        connected: true,
        url: "ws://127.0.0.1:8642/messaging",
        platforms: ["feishu"],
        reconnecting: false,
        lastConnectedAt: 1715184000000,
      }),
    }) as any);

    const providers = listChannelProviders();
    const wechat = providers.find((p) => p.type === "wechat");
    const feishu = providers.find((p) => p.type === "feishu");
    expect(wechat?.status).toBe("disabled");
    expect(feishu?.status).toBe("enabled");
  });
});
