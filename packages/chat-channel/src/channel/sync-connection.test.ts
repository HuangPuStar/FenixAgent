// packages/chat-channel/src/channel/sync-connection.test.ts
// 连接级同步 runtime 的创建语义：并发首帧只 attach 一次，失败后允许下一帧重试。

import { describe, expect, test } from "bun:test";
import { createClient } from "./connection-test-helpers";
import type { SyncConnection } from "./connection-types";
import { ensureGatewaySyncConnection } from "./sync-connection";

function fakeSyncConnection(): SyncConnection {
  return {
    onInboundBytes: async () => {},
    acceptNormalizedEvent: () => {},
    acceptUserMessage: () => {},
    dispose: () => {},
  };
}

describe("ensureGatewaySyncConnection", () => {
  // 两个并发首帧共享同一在途 attach：只创建一份 runtime，两个调用拿到同一实例。
  test("shares one in-flight attach between concurrent first frames", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    let attachCalls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const attach = async (): Promise<SyncConnection> => {
      attachCalls += 1;
      await gate;
      return connection;
    };

    const first = ensureGatewaySyncConnection(entry, attach);
    const second = ensureGatewaySyncConnection(entry, attach);
    expect(attachCalls).toBe(1);

    release();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toBe(connection);
    expect(secondResult).toBe(connection);
    expect(entry.syncConnection).toBe(connection);
  });

  // attach 初始化失败（返回 undefined）后清空在途登记，下一帧可以重新创建。
  test("retries attach after an initialization failure", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    let attempts = 0;
    const attach = async (): Promise<SyncConnection | undefined> => {
      attempts += 1;
      return attempts === 1 ? undefined : connection;
    };

    expect(await ensureGatewaySyncConnection(entry, attach)).toBeUndefined();
    expect(entry.syncConnection).toBeUndefined();
    expect(await ensureGatewaySyncConnection(entry, attach)).toBe(connection);
    expect(attempts).toBe(2);
  });

  // attach 抛错同样清理登记，不会被后续帧永久复用为失败的 Promise。
  test("clears the in-flight entry when attach rejects", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    let attempts = 0;
    const attach = async (): Promise<SyncConnection> => {
      attempts += 1;
      if (attempts === 1) throw new Error("attach failed");
      return connection;
    };

    await expect(ensureGatewaySyncConnection(entry, attach)).rejects.toThrow("attach failed");
    expect(await ensureGatewaySyncConnection(entry, attach)).toBe(connection);
    expect(attempts).toBe(2);
  });

  // 已创建的 runtime 直接复用，不再进入 attach（例如首帧已建立后其他帧到达）。
  test("reuses an existing connection without attaching again", async () => {
    const entry = createClient();
    const connection = fakeSyncConnection();
    entry.syncConnection = connection;
    let attachCalls = 0;

    const result = await ensureGatewaySyncConnection(entry, async () => {
      attachCalls += 1;
      return fakeSyncConnection();
    });

    expect(result).toBe(connection);
    expect(attachCalls).toBe(0);
  });
});
