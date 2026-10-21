import { afterEach, describe, expect, test } from "bun:test";
import { createPublicError, encodeYjsReplaceFrame, encodeYjsUpdateFrame } from "@fenix/chat-channel";
import { act } from "react";
import * as Y from "yjs";
import {
  FakeWebSocket,
  installFakeWebSocket,
  legacySockets,
  renderRuntime,
  restoreFakeWebSocket,
  runtimeGlobal,
  syncErrorFrame,
  syncSockets,
  win,
} from "./helpers/chat-panel-runtime-fixture";

afterEach(restoreFakeWebSocket);

/** 使用真实二进制帧更新 DocHub，以免仅控制帧让恢复测试出现假阳性。 */
function deliverDoc(socket: FakeWebSocket, docName: string, generation: string, replace = false) {
  const doc = new Y.Doc();
  const encode = replace ? encodeYjsReplaceFrame : encodeYjsUpdateFrame;
  act(() => socket.onmessage?.({ data: encode(docName, generation, Y.encodeStateAsUpdate(doc)) } as MessageEvent));
  doc.destroy();
}

describe("ChatPanel 历史恢复证明", () => {
  // 历史快照未送达时暴露缺失文档；重试期间保持门禁，直到缺失文档重新交付才解除。
  test("历史同步未完成：重试保持缺失状态并在快照到达后解除", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const docName = `chat:${harness.latest.current!.rcsSessionKey!}`;
    const socket = FakeWebSocket.instances[0];
    expect(socket).toBeDefined();

    act(() => {
      socket?.onmessage?.({
        data: JSON.stringify({
          type: "yjs:history-incomplete",
          generation: "generation-recovered",
          docs: [docName],
          reason: "too_large",
          bytes: 9_440_845,
          limitBytes: 8 * 1024 * 1024,
        }),
      } as MessageEvent);
    });
    expect(harness.latest.current?.historyRecovery?.docs).toEqual([docName]);
    expect(harness.latest.current?.historyRecovery?.bytes).toBe(9_440_845);

    act(() => harness.latest.current?.retryHistoryRecovery());
    // 重试只重建连接，不能提前清空历史缺失状态或解除上方发送门禁。
    expect(harness.latest.current?.historyRecovery?.docs).toEqual([docName]);
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);

    const retrySocket = FakeWebSocket.instances[1];
    act(() => retrySocket?.open());
    expect(harness.latest.current?.historyRecovery).not.toBeNull();

    // 本次重试未拿到快照就断开：重试入口必须恢复可用，历史缺失状态不能解除。
    act(() => retrySocket?.closeFromServer(1006, "connection_lost"));
    expect(harness.latest.current?.historyRecovery).not.toBeNull();
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);

    act(() => harness.latest.current?.retryHistoryRecovery());
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(3);
    const secondRetrySocket = FakeWebSocket.instances[2];
    act(() => secondRetrySocket?.open());

    deliverDoc(secondRetrySocket!, docName, "generation-recovered");
    // 握手期间穿插的实时 update 不能证明缺失快照已恢复，门禁必须保持不变。
    expect(harness.latest.current?.historyRecovery).not.toBeNull();
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);

    act(() => {
      secondRetrySocket?.onmessage?.({
        data: JSON.stringify({ type: "yjs:sync-complete", docs: [docName], generation: "generation-recovered" }),
      } as MessageEvent);
    });
    expect(harness.latest.current?.historyRecovery).toBeNull();
    expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);

    harness.unmount();
  });

  // 同步回退 + 旧历史缺失时发送被阻止；重试未完成前门禁保持，缺失文档重新交付后才放开。
  test("历史恢复重试期间保持发送门禁，完整快照到达后解除", () => {
    installFakeWebSocket();
    const storage = win.localStorage;
    const hadLocalStorage = Object.hasOwn(globalThis, "localStorage");
    runtimeGlobal.localStorage = storage;
    storage.setItem("active_org_id", "org-1");
    const harness = renderRuntime();
    const docName = `chat:${harness.latest.current!.rcsSessionKey!}`;
    try {
      const legacy = legacySockets()[0];
      const sync = syncSockets()[0];
      expect(legacy).toBeDefined();
      expect(sync).toBeDefined();

      act(() => {
        legacy?.onmessage?.({
          data: JSON.stringify({
            type: "yjs:history-incomplete",
            generation: "generation-recovered",
            docs: [docName],
            reason: "backpressure",
            bytes: 0,
            limitBytes: 8 * 1024 * 1024,
          }),
        } as MessageEvent);
      });
      act(() => sync?.open());
      act(() => {
        sync?.onmessage?.({ data: syncErrorFrame() } as MessageEvent);
      });
      expect(harness.latest.current?.syncChat.legacyFallback).toBe(true);
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);

      act(() => harness.latest.current?.retryHistoryRecovery());
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      expect(harness.latest.current?.historyRecoveryRetrying).toBe(true);
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);
      expect(legacySockets()).toHaveLength(2);

      const retrySocket = legacySockets()[1];
      act(() => retrySocket?.open());
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);

      deliverDoc(retrySocket!, docName, "generation-recovered");
      // 实时 update 不是恢复证明：缺失文档未确认交付前不能放开发送门禁。
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);

      act(() => {
        retrySocket?.onmessage?.({
          data: JSON.stringify({ type: "yjs:sync-complete", docs: [docName], generation: "generation-recovered" }),
        } as MessageEvent);
      });
      expect(harness.latest.current?.historyRecovery).toBeNull();
      expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);
      expect(harness.latest.current?.syncDegradedBlocked).toBe(false);
    } finally {
      storage.removeItem("active_org_id");
      if (!hadLocalStorage) Reflect.deleteProperty(runtimeGlobal, "localStorage");
      harness.unmount();
    }
  });

  // 同一 socket 先失败后补齐合法差量时，显式成功证明必须恢复门禁与草稿发送。
  test("同连接超时失败后同代完成解除发送与草稿门禁", async () => {
    installFakeWebSocket();
    const hadLocalStorage = Object.hasOwn(globalThis, "localStorage");
    runtimeGlobal.localStorage = win.localStorage;
    win.localStorage.setItem("active_org_id", "org-1");
    const harness = renderRuntime();
    try {
      const legacy = legacySockets()[0]!;
      const sync = syncSockets()[0]!;
      act(() => {
        legacy.open();
        sync.open();
      });
      act(() => sync.onmessage?.({ data: syncErrorFrame() } as MessageEvent));
      const key = harness.latest.current!.rcsSessionKey!;
      const docName = `chat:${key}`;
      const session = new Y.Doc();
      session.getMap("root").set("session", new Y.Map([["sessionId", "ses-current"]]));
      act(() =>
        legacy.onmessage?.({
          data: encodeYjsUpdateFrame(`session:${key}`, "generation-current", Y.encodeStateAsUpdate(session)),
        } as MessageEvent),
      );
      await act(async () => {
        await Bun.sleep(10);
      });
      session.destroy();
      const content = [{ type: "text", text: "保留的草稿" }];
      act(() => harness.latest.current?.callbacks.onSendPrompt(content));
      const prompt = legacy.sent
        .filter((raw): raw is string => typeof raw === "string")
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .find((frame) => frame.action === "send_prompt")!;
      act(() =>
        legacy.onmessage?.({
          data: JSON.stringify({
            type: "action_error",
            commandId: prompt.commandId,
            error: createPublicError("ACTION.VERSION_CONFLICT"),
          }),
        } as MessageEvent),
      );
      act(() =>
        legacy.onmessage?.({
          data: JSON.stringify({
            type: "yjs:history-incomplete",
            generation: "generation-current",
            docs: [docName],
            reason: "too_large",
            bytes: 9_440_845,
            limitBytes: 8 * 1024 * 1024,
          }),
        } as MessageEvent),
      );
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);
      act(() => harness.latest.current?.retryPreservedPrompt());
      const before = legacy.sent.length;
      await act(async () => {
        await Bun.sleep(510);
      });
      const delta = new Y.Doc();
      act(() =>
        legacy.onmessage?.({
          data: encodeYjsUpdateFrame(docName, "generation-current", Y.encodeStateAsUpdate(delta)),
        } as MessageEvent),
      );
      delta.destroy();
      expect(harness.latest.current?.syncDegradedBlocked).toBe(true);
      act(() =>
        legacy.onmessage?.({
          data: JSON.stringify({ type: "yjs:sync-complete", generation: "generation-current", docs: [docName] }),
        } as MessageEvent),
      );
      expect(harness.latest.current?.historyRecovery).toBeNull();
      expect(harness.latest.current?.syncDegradedBlocked).toBe(false);
      act(() => harness.latest.current?.retryPreservedPrompt());
      expect(legacy.sent.length).toBeGreaterThan(before);
      const recovered = legacy.sent
        .filter((raw): raw is string => typeof raw === "string")
        .map((raw) => JSON.parse(raw) as Record<string, unknown>)
        .filter((frame) => frame.action === "send_prompt")
        .at(-1);
      expect(recovered?.content).toEqual(content);
      expect(recovered?.sessionId).toBe("ses-current");
    } finally {
      win.localStorage.removeItem("active_org_id");
      if (!hadLocalStorage) Reflect.deleteProperty(runtimeGlobal, "localStorage");
      harness.unmount();
    }
  });

  // 每次重试自身都可能超过服务端握手窗口，仍只能由当前连接、同代且覆盖全部缺失文档的证明恢复。
  test("连续慢重试忽略异代覆盖不足与旧连接证明，合法完成仍可恢复", async () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const key = harness.latest.current!.rcsSessionKey!;
    const docs = [`chat:${key}`, `session:${key}`];
    const generation = "generation-retry";
    let current = legacySockets()[0]!;
    const incomplete = {
      type: "yjs:history-incomplete",
      docs,
      generation,
      reason: "too_large",
      bytes: 9_440_845,
      limitBytes: 8 * 1024 * 1024,
    };
    const completion = (covered: string[], candidate = generation) =>
      JSON.stringify({ type: "yjs:sync-complete", docs: covered, generation: candidate });
    try {
      act(() => current.open());
      for (let round = 0; round < 2; round++) {
        act(() => current.onmessage?.({ data: JSON.stringify(incomplete) } as MessageEvent));
        const stale = current.onmessage;
        act(() => harness.latest.current?.retryHistoryRecovery());
        current = legacySockets().at(-1)!;
        act(() => current.open());
        await act(async () => {
          await Bun.sleep(510);
        });
        act(() => current.onmessage?.({ data: JSON.stringify(incomplete) } as MessageEvent));
        for (const docName of docs) {
          const delta = new Y.Doc();
          act(() =>
            current.onmessage?.({
              data: encodeYjsUpdateFrame(docName, generation, Y.encodeStateAsUpdate(delta)),
            } as MessageEvent),
          );
          delta.destroy();
        }
        expect(harness.latest.current?.historyRecovery).not.toBeNull();
        act(() => current.onmessage?.({ data: completion(docs, "wrong-generation") } as MessageEvent));
        expect(harness.latest.current?.historyRecovery).not.toBeNull();
        act(() => current.onmessage?.({ data: completion([docs[0]!]) } as MessageEvent));
        expect(harness.latest.current?.historyRecovery).not.toBeNull();
        act(() => stale?.({ data: completion(docs) } as MessageEvent));
        expect(harness.latest.current?.historyRecovery).not.toBeNull();
        act(() => current.onmessage?.({ data: completion(["chat:other-session"]) } as MessageEvent));
        expect(harness.latest.current?.historyRecovery).not.toBeNull();
        act(() => current.onmessage?.({ data: completion([docs[1]!]) } as MessageEvent));
        expect(harness.latest.current?.historyRecovery).toBeNull();
        expect(harness.latest.current?.historyRecoveryRetrying).toBe(false);
        act(() => stale?.({ data: JSON.stringify(incomplete) } as MessageEvent));
        expect(harness.latest.current?.historyRecovery).toBeNull();
      }
    } finally {
      harness.unmount();
    }
  });

  // 世代缺失或为空时没有合法的完整交付证明，不能因为 undefined 相等而恢复权限。
  test.each([undefined, ""])("缺失或空世代 %s 的完成通知不能绕过 Doc 交付", (generation) => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const socket = legacySockets()[0]!;
    const docName = `chat:${harness.latest.current!.rcsSessionKey!}`;
    try {
      act(() => socket.open());
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({
            type: "yjs:history-incomplete",
            docs: [docName],
            reason: "backpressure",
            bytes: 0,
            limitBytes: 8 * 1024 * 1024,
          }),
        } as MessageEvent),
      );
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({ type: "yjs:sync-complete", docs: [docName], generation }),
        } as MessageEvent),
      );
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      deliverDoc(socket, docName, "valid-generation");
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({ type: "yjs:sync-complete", docs: [docName], generation }),
        } as MessageEvent),
      );
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      act(() =>
        socket.onmessage?.({
          data: JSON.stringify({ type: "yjs:sync-complete", docs: [docName], generation: "valid-generation" }),
        } as MessageEvent),
      );
      expect(harness.latest.current?.historyRecovery).toBeNull();
    } finally {
      harness.unmount();
    }
  });

  // 部分完成后发生投影换代时，旧文档证明必须失效，不能拼接两代结果解除门禁。
  test("旧 chat 证明不能与换代后的 session 证明拼齐缺失集合", () => {
    installFakeWebSocket();
    const harness = renderRuntime();
    const [chat, session] = [
      `chat:${harness.latest.current!.rcsSessionKey!}`,
      `session:${harness.latest.current!.rcsSessionKey!}`,
    ];
    const first = legacySockets()[0]!;
    const completion = (socket: FakeWebSocket, docs: string[], generation: string) =>
      act(() =>
        socket.onmessage?.({ data: JSON.stringify({ type: "yjs:sync-complete", docs, generation }) } as MessageEvent),
      );
    try {
      act(() => first.open());
      deliverDoc(first, chat!, "generation-1");
      deliverDoc(first, session!, "generation-1");
      act(() =>
        first.onmessage?.({
          data: JSON.stringify({
            type: "yjs:history-incomplete",
            docs: [chat, session],
            generation: "generation-1",
            reason: "too_large",
            bytes: 9_440_845,
            limitBytes: 8 * 1024 * 1024,
          }),
        } as MessageEvent),
      );
      act(() => harness.latest.current?.retryHistoryRecovery());
      const retry = legacySockets().at(-1)!;
      act(() => retry.open());
      completion(retry, [chat!], "generation-1");
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      deliverDoc(retry, chat!, "generation-2", true);
      deliverDoc(retry, session!, "generation-2", true);
      completion(retry, [session!], "generation-2");
      expect(harness.latest.current?.historyRecovery).not.toBeNull();
      completion(retry, [chat!], "generation-2");
      expect(harness.latest.current?.historyRecovery).toBeNull();
    } finally {
      harness.unmount();
    }
  });
});
