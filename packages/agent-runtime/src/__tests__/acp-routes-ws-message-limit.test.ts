// src/__tests__/acp-routes-ws-message-limit.test.ts
//
// 1.4 W6a 补齐 §6.2 缺口：`isOverWsLimit`（routes/acp/index.ts:37）的判定数学由 machine 的
// `file-ws-payload.test.ts` 覆盖，但 `MAX_WS_MESSAGE_SIZE` 的三个调用点（:184 机器接入、
// :344 前端 YJS、:416 外部 relay）此前零覆盖。本文件覆盖**调用点契约**：
//   1) 三条通道都在把帧交给下游之前调用尺寸检查，且上限传的是 10MB；
//   2) 判定为超限时以 1009 关闭连接，不把帧交给下游处理函数；
//   3) 判定为合规时不误关连接；object 帧以原对象交给检查（D12：仅查字符串会漏掉已 parse 的帧）。
//
// 守卫生效路径取宿主注入的 FileWsPort 替身（W6 裁定 2「能走 port 替身就走 port」）：替身记录每次
// 检查的入参与上限，并按下游方法是否被调用来验证「超限帧没有漏进处理函数」。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAcpRoutes } from "../routes/acp";
import { bindFileWsPort, type FileWsPort, resetFileWsPort } from "../server/services/file-ws-port";
import { initializeAgentRuntimeModuleConfig } from "../server/testing";
import { createStubAgentRuntimeAuthGuardPlugin, createStubAuthenticateRequest } from "./guard-stubs";

/** 三条通道共用的上限（routes/acp/index.ts:26 的 `MAX_WS_MESSAGE_SIZE`，10MB）。 */
const MAX_WS_MESSAGE_SIZE = 10 * 1024 * 1024;

// 路由工厂 + 宿主依赖替身：与 acp-routes-auth.test.ts 同一装配口径（认证替身只提供构造路由所需形状）。
const acpRoute = createAcpRoutes({
  authGuardPlugin: createStubAgentRuntimeAuthGuardPlugin(),
  authenticateRequest: createStubAuthenticateRequest(),
});

/** Elysia 未公开 WS hooks 的形状：这里只定位「方法 + 路径」并取 message 处理函数。 */
interface WsRouteView {
  readonly method: string;
  readonly path: string;
  readonly hooks?: { readonly message?: (ws: unknown, data: unknown) => void };
}

/** 取指定 WS 路径的 message 处理函数；路径不存在即失败（路由重命名应当让本用例报错而非静默跳过）。 */
function wsMessageHandler(path: string): (ws: unknown, data: unknown) => void {
  const view = (acpRoute.routes as unknown as readonly WsRouteView[]).find(
    (route) => route.method === "WS" && route.path === path,
  );
  const handler = view?.hooks?.message;
  if (!handler) throw new Error(`未找到 WS 路径 ${path} 的 message 处理函数`);
  return handler;
}

/** 尺寸检查替身：记录入参与上限，并按 `overLimit` 给判定；下游方法只记账不实现。 */
interface SizeCheckSpy {
  /** 每次 `checkWsMessageSize` / `checkParsedObjectSize` 的入参与上限。 */
  readonly calls: { data: unknown; maxPayloadBytes: number }[];
  /** 被触达的下游处理方法名（超限帧应当一条都不出现）。 */
  readonly downstream: string[];
}

function stubSizeCheckPort(overLimit: boolean): SizeCheckSpy {
  const calls: { data: unknown; maxPayloadBytes: number }[] = [];
  const downstream: string[] = [];
  const record =
    (name: string) =>
    (..._args: unknown[]): void => {
      downstream.push(name);
    };
  const port: FileWsPort = {
    checkWsMessageSize: (message, maxPayloadBytes) => {
      calls.push({ data: message, maxPayloadBytes });
      return overLimit;
    },
    checkParsedObjectSize: (data, maxPayloadBytes) => {
      calls.push({ data, maxPayloadBytes });
      return overLimit;
    },
    estimateWsMessageBytes: () => 0,
    formatFileWsCloseLog: () => {
      downstream.push("formatFileWsCloseLog");
      return "<stub file-ws close log>";
    },
    handleFileWsOpen: record("handleFileWsOpen"),
    handleFileWsMessage: record("handleFileWsMessage"),
    handleFileWsClose: record("handleFileWsClose"),
    parseFileWsMessage: () => {
      downstream.push("parseFileWsMessage");
      return [];
    },
  };
  bindFileWsPort(port);
  return { calls, downstream };
}

/** 假 WS：只实现处理函数会触达的面（`adaptWs` 用到的 send / sendBinary / close / readyState）。 */
interface FakeWs {
  readonly closes: { code?: number; reason?: string }[];
  data: Record<string, unknown>;
  send(data: string | Uint8Array): void;
  sendBinary(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  readonly readyState: number;
}

function createFakeWs(): FakeWs {
  const closes: { code?: number; reason?: string }[] = [];
  return {
    closes,
    data: {},
    send: () => {},
    sendBinary: () => {},
    close: (code, reason) => {
      closes.push({ code, reason });
    },
    readyState: 1,
  };
}

describe("/acp WS 通道的消息尺寸上限（路由级）", () => {
  beforeEach(() => {
    // 内含 resetAllStubs；本文件不依赖替身会话（不触发 open 路径），但仍保持与既有路由用例一致的复位口径。
    initializeAgentRuntimeModuleConfig();
  });

  afterEach(() => {
    resetFileWsPort();
  });

  // 三条通道的超限帧都必须先被尺寸检查拦下并 close 1009，且不得触达任何下游处理方法——
  // 这正是「补检查」要防的退化：漏检会让 10MB 上限静默失效（uWS 全局上限已放宽到 32MB）。
  for (const { path, channel } of [
    { path: "/acp/ws", channel: "机器接入" },
    { path: "/acp/yjs/:agentId", channel: "前端 YJS" },
    { path: "/acp/relay/:agentId", channel: "外部 relay" },
  ]) {
    test(`${channel}通道超限帧以 1009 关闭且不落下游`, () => {
      const spy = stubSizeCheckPort(true);
      const ws = createFakeWs();
      const oversize = "x".repeat(MAX_WS_MESSAGE_SIZE + 1);

      wsMessageHandler(path)(ws, oversize);

      expect(ws.closes).toEqual([{ code: 1009, reason: "message too large" }]);
      expect(spy.calls.length).toBeGreaterThan(0);
      expect(spy.calls.every((call) => call.maxPayloadBytes === MAX_WS_MESSAGE_SIZE)).toBe(true);
      expect(spy.downstream).toEqual([]);
    });
  }

  // 判定为合规时不得关连接：否则上限检查会退化成「一律拒绝」。wsId 缺省时下游会被跳过，
  // 因此这里断言的是守卫面的行为，下游投递由各自的 handler 用例覆盖。
  test("合规帧不关连接且尺寸检查按 10MB 判定", () => {
    const spy = stubSizeCheckPort(false);
    const ws = createFakeWs();

    wsMessageHandler("/acp/ws")(ws, JSON.stringify({ jsonrpc: "2.0", method: "ping" }));

    expect(ws.closes).toEqual([]);
    expect(spy.calls.map((call) => call.maxPayloadBytes)).toEqual([MAX_WS_MESSAGE_SIZE, MAX_WS_MESSAGE_SIZE]);
  });

  // object 帧（Elysia 已把 `{` 开头的单行 JSON parse 成对象）必须原样交给解析后检查：
  // 只做字符串检查会漏掉这类帧，真实上限会静默从 10MB 变成 uWS 的 32MB（D12 残留）。
  test("object 帧以原对象交给解析后尺寸检查", () => {
    const spy = stubSizeCheckPort(true);
    const ws = createFakeWs();
    const objectFrame = { jsonrpc: "2.0", method: "session/update", params: { pad: "x" } };

    wsMessageHandler("/acp/yjs/:agentId")(ws, objectFrame);

    expect(spy.calls.some((call) => call.data === objectFrame)).toBe(true);
    expect(ws.closes).toEqual([{ code: 1009, reason: "message too large" }]);
    expect(spy.downstream).toEqual([]);
  });
});
