// web/src/__tests__/doc-hub.test.ts
// DocHub（SP-B1 / 根因 B1）引用计数与单写入口测试：
// 同一会话的 Chat/Session doc 在页面内全局唯一（引用计数管理生命周期），
// WS update 经 applyDocHubUpdate 单写一次即对全部绑定 store 可见。

import { describe, expect, test } from "bun:test";
import { createYjsStore } from "@fenix/chat-channel";
import * as Y from "yjs";
import { applyDocHubUpdate, createChatDocBinding, createSessionDocBinding } from "../yjs/doc-hub";

describe("DocHub 引用计数与 doc 单例", () => {
  // 同一会话多次绑定共享同一份 doc 实例：页面内副本数从 4 降为 2 的前提
  test("同 key 重复 acquire 返回同一 doc 实例", () => {
    const b1 = createChatDocBinding("rcs-1");
    const b2 = createChatDocBinding("rcs-1");
    expect(b2.ydoc).toBe(b1.ydoc);
    expect(b2.ownsDoc).toBe(false);
    // 释放一次（4 次绑定中释放 2 次）后 doc 仍存活
    b1.cleanup();
    b2.cleanup();
  });

  // 引用计数归零才销毁：单个绑定释放不得摧毁其他绑定方正使用的 doc
  test("部分 release 时 doc 不销毁，归零后销毁", () => {
    const b1 = createChatDocBinding("rcs-2");
    const b2 = createChatDocBinding("rcs-2");
    const doc = b1.ydoc;
    b1.cleanup();
    expect(doc.isDestroyed).toBe(false);
    b2.cleanup();
    expect(doc.isDestroyed).toBe(true);
  });

  // 不同会话 doc 隔离：切换会话后旧 doc 销毁、新 doc 独立（会话数据不串扰）
  test("不同 key 的 doc 相互隔离", () => {
    const b1 = createChatDocBinding("rcs-a");
    const b2 = createChatDocBinding("rcs-b");
    expect(b1.ydoc).not.toBe(b2.ydoc);
    b1.cleanup();
    expect(b2.ydoc.isDestroyed).toBe(false);
    b2.cleanup();
  });

  // release 幂等：未登记的重复 release 不得误删后续重新 acquire 的 entry
  test("多余 release 幂等且不影响重新 acquire", () => {
    const b1 = createChatDocBinding("rcs-3");
    b1.cleanup();
    b1.cleanup(); // 多余 release：静默忽略
    const b2 = createChatDocBinding("rcs-3");
    expect(b2.ydoc.isDestroyed).toBe(false);
    b2.cleanup();
  });
});

describe("applyDocHubUpdate 单写入口", () => {
  // chat:/session: 前缀路由：update 落到对应共享 doc，绑定双方内容一致
  test("按 docName 前缀路由到共享 Chat/Session doc", () => {
    const chatBinding = createChatDocBinding("rcs-w");
    const sessionBinding = createSessionDocBinding("rcs-w");

    const chatSrc = new Y.Doc();
    chatSrc.getMap("root").set("marker", "chat-payload");
    applyDocHubUpdate("rcs-w", "chat:rcs-w", Y.encodeStateAsUpdate(chatSrc));

    const sessionSrc = new Y.Doc();
    sessionSrc.getMap("root").set("marker", "session-payload");
    applyDocHubUpdate("rcs-w", "session:rcs-w", Y.encodeStateAsUpdate(sessionSrc));

    expect(chatBinding.ydoc.getMap("root").get("marker")).toBe("chat-payload");
    expect(sessionBinding.ydoc.getMap("root").get("marker")).toBe("session-payload");

    chatBinding.cleanup();
    sessionBinding.cleanup();
  });

  // 无活跃绑定的会话：静默丢弃不抛错（副本纯投影，重连后服务端重发快照恢复）
  test("未 acquire 的会话 no-op 不抛错", () => {
    const src = new Y.Doc();
    src.getMap("root").set("marker", 1);
    expect(() => applyDocHubUpdate("rcs-missing", "chat:rcs-missing", Y.encodeStateAsUpdate(src))).not.toThrow();
  });

  // 未知前缀 docName：与既有 hook 路由行为一致，忽略
  test("未知前缀 docName 忽略", () => {
    const b = createChatDocBinding("rcs-u");
    const src = new Y.Doc();
    src.getMap("root").set("marker", 1);
    expect(() => applyDocHubUpdate("rcs-u", "other:rcs-u", Y.encodeStateAsUpdate(src))).not.toThrow();
    expect(b.ydoc.getMap("root").get("marker")).toBeUndefined();
    b.cleanup();
  });
});

describe("共享 doc 与 YjsStore 协作", () => {
  // 两个 store 绑定同一份 hub doc：apply 一次即双方可见（消除双写的正确性基础）
  test("applyDocHubUpdate 一次，两个绑定 store 均重算快照", async () => {
    const snapshotOf = (ydoc: Y.Doc) => String(ydoc.getMap("root").get("marker") ?? "");
    const storeA = createYjsStore(snapshotOf, "");
    const storeB = createYjsStore(snapshotOf, "");
    // 每次 switchDoc 独立 acquire（与 hook 内绑定工厂语义一致），引用计数 = 2
    storeA.switchDoc("hub", () => createChatDocBinding("rcs-store"));
    storeB.switchDoc("hub", () => createChatDocBinding("rcs-store"));

    // 同一源 doc 连续演化后整体 encode：两次 apply 的最终值由同一 client 的
    // op 顺序决定（避免跨 client 同 key 冲突解析的不确定性）
    const src = new Y.Doc();
    src.getMap("root").set("marker", "v1");
    applyDocHubUpdate("rcs-store", "chat:rcs-store", Y.encodeStateAsUpdate(src));

    // applyUpdate 路径走宏任务合并重算：等待调度落地后两个 store 快照一致
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeA.getSnapshot()).toBe("v1");
    expect(storeB.getSnapshot()).toBe("v1");

    // 单个 store destroy（StrictMode 场景之一）不摧毁共享 doc，另一方继续可见后续更新
    storeA.destroy();
    src.getMap("root").set("marker", "v2");
    applyDocHubUpdate("rcs-store", "chat:rcs-store", Y.encodeStateAsUpdate(src));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(storeB.getSnapshot()).toBe("v2");

    storeB.destroy();
  });
});
