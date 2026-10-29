// LangBot 适配器目录的配置收敛回归：Service API 不补 manifest 默认值，默认值、隐式开关与枚举缺省
// 一旦丢失，创建出来的 Bot 会缺键直接启动失败。

import { describe, expect, test } from "bun:test";
import {
  BUILTIN_ADAPTERS,
  buildAdapterConfig,
  findBuiltinAdapter,
} from "../../web/pages/agent-panel/components/adapter-catalog";

const onebot = findBuiltinAdapter("onebot-v11")!;
const dingtalk = findBuiltinAdapter("dingtalk-omni")!;
const qqofficial = findBuiltinAdapter("qqofficial-omni")!;

describe("LangBot 适配器目录", () => {
  // 目录必须覆盖平台支持的内置适配器，且不能把依赖公网回调的两种重新带入。
  test("内置目录覆盖十种适配器且排除 webhook 回调型", () => {
    expect(BUILTIN_ADAPTERS.map((adapter) => adapter.id)).toEqual([
      "telegram-omni",
      "lark-omni",
      "slack-omni",
      "discord-omni",
      "wecom-omni",
      "wecombot-omni",
      "dingtalk-omni",
      "kook-omni",
      "qqofficial-omni",
      "onebot-v11",
    ]);
    expect(findBuiltinAdapter("officialaccount-omni")).toBeUndefined();
    expect(findBuiltinAdapter("wecomcs-omni")).toBeUndefined();
  });

  // OneBot 的 connection_mode 是必填枚举；用户未选时用 reverse_ws 兜底，否则上游拒绝启动。
  test("枚举字段未选择时提交目录默认值", () => {
    const built = buildAdapterConfig(onebot, { "access-token": "secret-token" });
    expect(built.missing).toEqual([]);
    expect(built.config).toEqual({ connection_mode: "reverse_ws", "access-token": "secret-token" });
  });

  // 用户显式选择正向连接时以选择为准，并带上手填的 ws_url。
  test("枚举字段显式选择时覆盖默认值", () => {
    const built = buildAdapterConfig(onebot, {
      connection_mode: "forward_ws",
      ws_url: "ws://127.0.0.1:3001",
      "access-token": "secret-token",
    });
    expect(built.config).toEqual({
      connection_mode: "forward_ws",
      ws_url: "ws://127.0.0.1:3001",
      "access-token": "secret-token",
    });
  });

  // 可选文本留空必须省略，否则编辑模式会把空串合并进 LangBot 的现有配置。
  test("可选文本留空时省略且不报缺", () => {
    const built = buildAdapterConfig(onebot, { "access-token": "secret-token", ws_url: "   " });
    expect(built.config).not.toHaveProperty("ws_url");
    expect(built.missing).toEqual([]);
  });

  // 必填密钥缺失必须报缺，否则会创建出无法启动的 Bot。
  test("必填密钥缺失时报告缺失字段", () => {
    const built = buildAdapterConfig(onebot, { connection_mode: "reverse_ws" });
    expect(built.missing.map((field) => field.key)).toEqual(["access-token"]);
  });

  // 可见布尔项按目录默认值提交（钉钉 markdown_card 默认开），未操作也不能丢。
  test("可见布尔字段未操作时提交默认值", () => {
    const built = buildAdapterConfig(dingtalk, { client_id: "id", client_secret: "secret" });
    expect(built.config).toEqual({
      client_id: "id",
      client_secret: "secret",
      markdown_card: true,
      card_auto_layout: true,
    });
  });

  // 隐式布尔项不渲染但必须始终提交：QQ 官方 API 的三个开关缺一个上游就会取不到值。
  test("隐式布尔字段始终按默认值提交", () => {
    const built = buildAdapterConfig(qqofficial, { appid: "app", secret: "secret" });
    expect(built.config).toEqual({
      appid: "app",
      secret: "secret",
      "enable-markdown-rendering": false,
      "enable-webhook": false,
      "enable-stream-reply": false,
    });
  });
});
