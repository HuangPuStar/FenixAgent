import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { NotFoundError } from "../errors";
import { closeAllFileEventsClients, type FileEventsAuth, handleFileEventsOpen } from "../routes/web/file-events";
import { publishFileEvent } from "../services/file-event-queue";
import { resetAllStubs, stubEnvironmentService } from "../test-utils/helpers";
import type { WsConnection } from "../transport/ws-types";

// file-events 端点的 handler 层测试（参照 file-ws-handler.test.ts 模式）：
// 薄壳与 Elysia 无关，handler 直接接收 mock WS；getOwnedEnvironment 经 preload
// mock 的 services/environment stub 注入（stubEnvironmentService），不触真实 DB。

const ENV_OK = "env-ok";
const ENV_FORBIDDEN = "env-forbidden";
const AUTH: FileEventsAuth = { userId: "user-1", organizationId: "org-1" };

function createMockWs(): WsConnection & { _messages: string[] } {
  const messages: string[] = [];
  const ws = {
    readyState: 1,
    send: mock((data: string) => {
      messages.push(data);
    }),
    close: mock(() => {}),
    _messages: messages,
  } as unknown as WsConnection & { _messages: string[] };
  return ws;
}

/** 等待 handler 的异步订阅与队列微任务 flush 完成 */
async function flushAsync() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** 解析该连接收到的全部帧 */
function parsedFrames(ws: WsConnection & { _messages: string[] }): Record<string, unknown>[] {
  return ws._messages.map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(() => {
  resetAllStubs();
  closeAllFileEventsClients();
  // 默认：ENV_OK 可订阅，ENV_FORBIDDEN 无权限（NotFoundError 语义）
  stubEnvironmentService({
    getOwnedEnvironment: async (envId: string) => {
      if (envId === ENV_FORBIDDEN) {
        throw new NotFoundError("环境不存在");
      }
      return { id: envId };
    },
  });
});

afterEach(() => {
  closeAllFileEventsClients();
});

describe("file-events 端点 handler", () => {
  // 合法订阅后，事件经队列按环境 fan-out 下发到该连接的 WS 帧。
  test("delivers published file_changed frames to a subscribed client", async () => {
    const ws = createMockWs();
    const client = handleFileEventsOpen(ws, AUTH, 10);

    await client!.handleMessage({ type: "subscribe", environments: [ENV_OK] });
    await flushAsync();
    publishFileEvent(ENV_OK, { type: "file_changed", path: "a.txt", kind: "write", source: "user" });
    await flushAsync();

    expect(parsedFrames(ws)).toContainEqual({
      type: "file_changed",
      environment_id: ENV_OK,
      path: "a.txt",
      kind: "write",
      source: "user",
    });

    client!.close();
  });

  // 订阅不存在的/无权限的环境时，必须显式回 subscribe_error(forbidden)，而不是静默忽略。
  test("replies subscribe_error forbidden for an unauthorized environment", async () => {
    const ws = createMockWs();
    const client = handleFileEventsOpen(ws, AUTH, 10);

    await client!.handleMessage({ type: "subscribe", environments: [ENV_FORBIDDEN] });
    await flushAsync();

    expect(parsedFrames(ws)).toContainEqual({
      type: "subscribe_error",
      environment_id: ENV_FORBIDDEN,
      code: "forbidden",
    });

    client!.close();
  });

  // 活跃连接数达上限时新连接被 close(1013)（服务级独立池，与 YJS 分池）；释放后恢复可用。
  test("closes with 1013 when the client limit is reached, and recovers after release", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const ws3 = createMockWs();
    const ws4 = createMockWs();

    const client1 = handleFileEventsOpen(ws1, AUTH, 2);
    const client2 = handleFileEventsOpen(ws2, AUTH, 2);
    expect(client1).not.toBeNull();
    expect(client2).not.toBeNull();

    expect(handleFileEventsOpen(ws3, AUTH, 2)).toBeNull();
    expect(ws3.close).toHaveBeenCalledWith(1013, "too many clients");

    client1!.close();
    expect(handleFileEventsOpen(ws4, AUTH, 2)).not.toBeNull();
  });

  // 未认证连接在 open 时被 close(4003)，不占用连接槽位。
  test("rejects unauthenticated clients with close 4003", () => {
    const ws = createMockWs();
    expect(handleFileEventsOpen(ws, null, 10)).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4003, "unauthorized");
  });

  // 断开后必须取消全部订阅：后续发布不再送达，新客户端可正常重新订阅（队列无泄漏）。
  test("cancels all subscriptions on close so no events are delivered afterwards", async () => {
    const ws = createMockWs();
    const client = handleFileEventsOpen(ws, AUTH, 10);

    await client!.handleMessage({ type: "subscribe", environments: [ENV_OK] });
    await flushAsync();
    publishFileEvent(ENV_OK, { type: "file_changed", path: "before.txt", kind: "write", source: "user" });
    await flushAsync();
    expect(parsedFrames(ws)).toHaveLength(1);

    client!.close();
    publishFileEvent(ENV_OK, { type: "file_changed", path: "after.txt", kind: "write", source: "user" });
    await flushAsync();
    expect(parsedFrames(ws)).toHaveLength(1);

    // 同一环境可被新连接重新订阅（说明断开时队列订阅已清除）
    const ws2 = createMockWs();
    const client2 = handleFileEventsOpen(ws2, AUTH, 10);
    await client2!.handleMessage({ type: "subscribe", environments: [ENV_OK] });
    await flushAsync();
    publishFileEvent(ENV_OK, { type: "file_changed", path: "again.txt", kind: "write", source: "user" });
    await flushAsync();
    expect(parsedFrames(ws2)).toHaveLength(1);

    client2!.close();
  });

  // 同一环境重复订阅被去重：事件只下发一次，不会因重复帧产生双发。
  test("deduplicates repeated subscription to the same environment", async () => {
    const ws = createMockWs();
    const client = handleFileEventsOpen(ws, AUTH, 10);

    await client!.handleMessage({ type: "subscribe", environments: [ENV_OK, ENV_OK] });
    await flushAsync();
    publishFileEvent(ENV_OK, { type: "file_changed", path: "dedup.txt", kind: "write", source: "user" });
    await flushAsync();

    expect(parsedFrames(ws).filter((f) => f.type === "file_changed")).toHaveLength(1);

    client!.close();
  });

  // 非法订阅帧（类型不符 / 非 JSON）被忽略并记录日志，不关闭连接、不回错误帧。
  test("ignores malformed subscribe frames without closing the connection", async () => {
    const ws = createMockWs();
    const client = handleFileEventsOpen(ws, AUTH, 10);

    await client!.handleMessage("not-json{");
    await client!.handleMessage({ type: "unknown", environments: [ENV_OK] });
    await flushAsync();

    expect(parsedFrames(ws)).toHaveLength(0);
    expect(ws.close).not.toHaveBeenCalled();

    client!.close();
  });
});
