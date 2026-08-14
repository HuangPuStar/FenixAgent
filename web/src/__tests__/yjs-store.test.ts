// web/src/__tests__/yjs-store.test.ts
// 验证 createYjsStore 的 snapshot 去重行为：
//   消息内容变化、tool_call output/status 变化、permission/loading/streaming 变化必通知；
//   快照未变时不额外通知；不参与 snapshot 的字段变化不通知。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createYjsStore, stableKey } from "@fenix/acp-server";
import * as Y from "yjs";

// ── 辅助类型和函数 ──

interface TestSnapshot {
  messages: Array<{ role: string; content: string; seq: number; ts: number }>;
  status: string;
  loading: { kind: string; label?: string; since: number } | null;
  streaming: { text: string; reasoning: string } | null;
  tools: Map<string, { name: string; status: string; output?: unknown }>;
  permissions: Array<{ id: string; status: string }>;
  isSwitching: boolean;
}

/** 从 Y.Doc 计算 TestSnapshot（模拟 computeSessionSnapshot 的核心逻辑） */
function computeTestSnapshot(ydoc: Y.Doc): TestSnapshot {
  const meta = ydoc.getMap("meta");
  const messages = ydoc.getArray("messages");
  const streaming = ydoc.getMap("streaming");
  const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
  const permissions = ydoc.getArray("permissions");

  const rawLoading = meta.get("loading") as Record<string, unknown> | null;

  return {
    messages: (messages.toArray() as Y.Map<unknown>[]).map((m) => ({
      role: (m.get("role") as string) || "",
      content: (m.get("content") as string) || "",
      seq: (m.get("seq") as number) || 0,
      ts: (m.get("ts") as number) || 0,
    })),
    status: (meta.get("status") as string) || "idle",
    loading: rawLoading
      ? {
          kind: rawLoading.kind as string,
          label: rawLoading.label as string | undefined,
          since: rawLoading.since as number,
        }
      : null,
    streaming: streaming.size
      ? {
          text: (streaming.get("text") as string) || "",
          reasoning: (streaming.get("reasoning") as string) || "",
        }
      : null,
    tools: new Map(
      Array.from(tools.entries()).map(([k, v]) => [
        k,
        {
          name: (v.get("name") as string) || "",
          status: (v.get("status") as string) || "running",
          output: v.get("output"),
        },
      ]),
    ),
    permissions: (permissions.toArray() as Y.Map<unknown>[]).map((p) => ({
      id: (p.get("id") as string) || "",
      status: (p.get("status") as string) || "pending",
    })),
    isSwitching: (meta.get("isSwitching") as boolean) || false,
  };
}

/** 使用 stableKey 作为领域去重函数 */
function getTestSnapshotKey(s: TestSnapshot): string {
  return stableKey(s);
}

function getInitialTestSnapshot(): TestSnapshot {
  return {
    messages: [],
    status: "idle",
    loading: null,
    streaming: null,
    tools: new Map(),
    permissions: [],
    isSwitching: false,
  };
}

/** 在 Y.Doc 中写入消息 */
function writeMessage(ydoc: Y.Doc, role: string, content: string, seq: number) {
  ydoc.transact(() => {
    const messages = ydoc.getArray("messages");
    const msg = new Y.Map<unknown>();
    msg.set("role", role);
    msg.set("content", content);
    msg.set("seq", seq);
    msg.set("ts", Date.now());
    messages.push([msg]);
  });
}

/** 在 Y.Doc 中写入 tool_call */
function writeTool(ydoc: Y.Doc, id: string, name: string, status: string, output?: unknown) {
  ydoc.transact(() => {
    const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
    const tool = new Y.Map<unknown>();
    tool.set("name", name);
    tool.set("status", status);
    if (output !== undefined) tool.set("output", output);
    tool.set("startedAt", Date.now());
    tools.set(id, tool);
  });
}

/** 在 Y.Doc 中设置 loading 状态 */
function setLoading(ydoc: Y.Doc, kind: string) {
  ydoc.transact(() => {
    ydoc.getMap("meta").set("loading", { kind, since: Date.now() });
  });
}

/** 在 Y.Doc 中设置 streaming */
function setStreaming(ydoc: Y.Doc, text: string, reasoning: string) {
  ydoc.transact(() => {
    ydoc.getMap("streaming").set("text", text);
    ydoc.getMap("streaming").set("reasoning", reasoning);
  });
}

/** 在 Y.Doc 中添加 permission */
function addPermission(ydoc: Y.Doc, id: string, status: string) {
  ydoc.transact(() => {
    const perms = ydoc.getArray("permissions");
    const p = new Y.Map<unknown>();
    p.set("id", id);
    p.set("status", status);
    perms.push([p]);
  });
}

// ── 测试 ──

describe("createYjsStore snapshot 去重", () => {
  let ydoc: Y.Doc;
  let store: ReturnType<typeof createYjsStore<TestSnapshot>>;
  let notifyCount: number;

  beforeEach(() => {
    ydoc = new Y.Doc();
    notifyCount = 0;
    store = createYjsStore<TestSnapshot>(computeTestSnapshot, getInitialTestSnapshot(), getTestSnapshotKey);
    store.switchDoc("test", () => ({ ydoc }));

    // 订阅计数：每次 React 通知时递增
    store.subscribe(() => {
      notifyCount++;
    });
  });

  afterEach(() => {
    store.destroy();
  });

  // 首次 switchDoc 后通知一次（初始快照），这里清除计数以便后续测试从零开始
  function resetNotifyCount() {
    notifyCount = 0;
  }

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.1: 消息 content 改变（messages.length 不变）必通知
  // ────────────────────────────────────────────────────────────────────────
  test("消息 content 改变（messages.length 不变）必通知", () => {
    // 写入初始消息
    writeMessage(ydoc, "assistant", "hello", 0);
    resetNotifyCount();

    // 修改同一条消息的 content（length 不变）
    ydoc.transact(() => {
      const msg = ydoc.getArray("messages").get(0) as Y.Map<unknown>;
      msg.set("content", "hello world updated");
    });

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().messages[0].content).toBe("hello world updated");
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.2: tool_call output 改变必通知
  // ────────────────────────────────────────────────────────────────────────
  test("tool_call output 改变必通知", () => {
    writeTool(ydoc, "t1", "read_file", "running");
    resetNotifyCount();

    // 更新 tool output
    ydoc.transact(() => {
      const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
      tools.get("t1")!.set("output", { content: "file data" });
    });

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().tools.get("t1")?.output).toEqual({ content: "file data" });
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.3: tool_call status 改变必通知
  // ────────────────────────────────────────────────────────────────────────
  test("tool_call status 改变必通知", () => {
    writeTool(ydoc, "t1", "read_file", "running");
    resetNotifyCount();

    // 更新 tool status
    ydoc.transact(() => {
      const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
      tools.get("t1")!.set("status", "done");
    });

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().tools.get("t1")?.status).toBe("done");
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.4: loading 状态改变必通知
  // ────────────────────────────────────────────────────────────────────────
  test("loading 状态改变必通知", () => {
    resetNotifyCount();

    setLoading(ydoc, "session/respond");

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().loading?.kind).toBe("session/respond");
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.5: streaming 内容改变必通知
  // ────────────────────────────────────────────────────────────────────────
  test("streaming 内容改变必通知", () => {
    resetNotifyCount();

    setStreaming(ydoc, "chunk1", "");

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().streaming?.text).toBe("chunk1");

    // 追加 streaming 文本
    resetNotifyCount();
    ydoc.transact(() => {
      const cur = ydoc.getMap("streaming").get("text") as string;
      ydoc.getMap("streaming").set("text", `${cur}chunk2`);
    });

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().streaming?.text).toBe("chunk1chunk2");
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.6: permission 状态改变必通知
  // ────────────────────────────────────────────────────────────────────────
  test("permission 状态改变必通知", () => {
    addPermission(ydoc, "p1", "pending");
    resetNotifyCount();

    // 更新 permission 状态
    ydoc.transact(() => {
      const perms = ydoc.getArray("permissions");
      const p = perms.get(0) as Y.Map<unknown>;
      p.set("status", "approved");
    });

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().permissions[0].status).toBe("approved");
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.7: 快照未变时不通知（去重验证）
  // ────────────────────────────────────────────────────────────────────────
  test("快照未变时不通知（去重验证）", () => {
    writeMessage(ydoc, "user", "hello", 0);
    resetNotifyCount();

    // 对不参与 snapshot 的字段做写入（这里用 meta 中一个 snapshot 不读取的字段）
    ydoc.transact(() => {
      ydoc.getMap("meta").set("_internal", "debug-value");
    });

    // _internal 不在 computeTestSnapshot 中读取，应该不通知
    expect(notifyCount).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.8: 多次更新但快照 key 不变时不触发额外通知
  // ────────────────────────────────────────────────────────────────────────
  test("多次写入相同内容不重复通知", () => {
    writeMessage(ydoc, "user", "hello", 0);
    resetNotifyCount();

    // 将消息 content 设为相同值
    ydoc.transact(() => {
      const msg = ydoc.getArray("messages").get(0) as Y.Map<unknown>;
      msg.set("content", "hello"); // 已经是 "hello"，设置相同值
    });

    // stableKey 比较结果相同，不应通知
    expect(notifyCount).toBe(0);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.9: stableKey 处理 Map 按 key 排序
  // ────────────────────────────────────────────────────────────────────────
  test("stableKey 处理 Map 按 key 排序", () => {
    writeTool(ydoc, "b-tool", "read_file", "running");
    writeTool(ydoc, "a-tool", "write_file", "running");
    resetNotifyCount();

    // 同时更新两个 tool，验证序列化使用排序后的 key
    ydoc.transact(() => {
      const tools = ydoc.getMap("tools") as Y.Map<Y.Map<unknown>>;
      tools.get("a-tool")!.set("status", "done");
      tools.get("b-tool")!.set("status", "done");
    });

    expect(notifyCount).toBe(1);
  });

  // ────────────────────────────────────────────────────────────────────────
  // 7.3.10: 添加新消息到已有消息列表必通知
  // ────────────────────────────────────────────────────────────────────────
  test("添加新消息到已有消息列表必通知", () => {
    writeMessage(ydoc, "user", "hello", 0);
    resetNotifyCount();

    writeMessage(ydoc, "assistant", "hi there", 1);

    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().messages.length).toBe(2);
  });
});

// ────────────────────────────────────────────────────────────────────────
// applyUpdate（WS 路径）合并重算行为
// 回放/流式高峰时同一 tick 的多次 applyUpdate 应合并为一次重算，
// 且重算在宏任务中执行（不阻塞 WS 接收栈）；快照最终正确。
// ────────────────────────────────────────────────────────────────────────

describe("createYjsStore applyUpdate 合并重算", () => {
  let ydoc: Y.Doc;
  let store: ReturnType<typeof createYjsStore<TestSnapshot>>;
  let notifyCount: number;

  beforeEach(() => {
    ydoc = new Y.Doc();
    notifyCount = 0;
    store = createYjsStore<TestSnapshot>(computeTestSnapshot, getInitialTestSnapshot(), getTestSnapshotKey);
    store.switchDoc("test", () => ({ ydoc }));
    store.subscribe(() => {
      notifyCount++;
    });
    notifyCount = 0;
  });

  afterEach(() => {
    store.destroy();
  });

  /** 用独立源 doc 编码一条消息的 update，模拟 WS 增量帧 */
  function encodeMessageUpdate(role: string, content: string, seq: number): Uint8Array {
    const src = new Y.Doc();
    writeMessage(src, role, content, seq);
    return Y.encodeStateAsUpdate(src);
  }

  /** 等待宏任务队列中的合并重算执行完毕 */
  function flushRecompute(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 20));
  }

  // 同一 tick 连续 applyUpdate 多条 update，合并为一次重算/通知；
  // 快照内容为全部 update 应用后的最终状态（无遗漏）
  test("同一 tick 多条 applyUpdate 合并为一次通知，快照内容完整", async () => {
    store.applyUpdate(encodeMessageUpdate("user", "hello", 0));
    store.applyUpdate(encodeMessageUpdate("assistant", "hi there", 1));

    // 宏任务重算前：快照仍是旧值（重算未执行），通知尚未发出
    expect(notifyCount).toBe(0);

    await flushRecompute();

    expect(notifyCount).toBe(1);
    // 两条 update 来自不同源 doc（不同 client id），Yjs 按 client/clock 排序，
    // 合并顺序不保证，按内容集合断言（不依赖下标顺序）
    const contents = store
      .getSnapshot()
      .messages.map((m) => m.content)
      .sort();
    expect(contents).toEqual(["hello", "hi there"]);
  });

  // 本地事务（origin 非 applyUpdate）保持同步重算语义：
  // 切换 load_session 后服务端回放与本地写入并存时，本地写入立即可见
  test("本地事务仍同步通知，不受 applyUpdate 合并调度影响", async () => {
    store.applyUpdate(encodeMessageUpdate("user", "hello", 0));

    ydoc.transact(() => {
      const messages = ydoc.getArray("messages");
      const msg = new Y.Map<unknown>();
      msg.set("role", "assistant");
      msg.set("content", "sync reply");
      msg.set("seq", 1);
      msg.set("ts", Date.now());
      messages.push([msg]);
    });

    // 本地事务立即通知
    expect(notifyCount).toBe(1);
    expect(store.getSnapshot().messages).toHaveLength(2);

    // 随后宏任务重算执行，快照仍为最终状态（本地 + WS 内容合并无回退）
    await flushRecompute();
    expect(store.getSnapshot().messages).toHaveLength(2);
  });

  // switchDoc 切换后：pending 的合并重算被取消，新 doc 立即呈现空快照；
  // 旧 doc 的迟到调度不会把内容写入新快照（同栈内可取消，仅一次通知）
  test("switchDoc 取消 pending 重算，新 doc 同步呈现初始快照", async () => {
    store.applyUpdate(encodeMessageUpdate("user", "stale", 0));

    const nextDoc = new Y.Doc();
    store.switchDoc("other", () => ({ ydoc: nextDoc }));

    // 渲染期同步重算：立即得到新 doc 的空快照；同栈取消生效，仅 switchDoc 自身通知一次
    expect(store.getSnapshot().messages).toHaveLength(0);
    expect(notifyCount).toBe(1);

    await flushRecompute();

    // 旧 doc 的迟到重算被新 doc 状态覆盖（幂等，不产生错误内容）
    expect(store.getSnapshot().messages).toHaveLength(0);
  });

  // destroy 后 applyUpdate 与迟到调度均不崩溃，且不通知已清空的 listener
  test("destroy 后 applyUpdate 安全，且不再通知", async () => {
    store.applyUpdate(encodeMessageUpdate("user", "hello", 0));
    store.destroy();

    const snapshotBefore = store.getSnapshot();
    store.applyUpdate(encodeMessageUpdate("assistant", "late", 1));
    await flushRecompute();

    // destroy 后快照冻结、无新通知（notifyCount 保持 destroy 前计数）
    expect(store.getSnapshot()).toBe(snapshotBefore);
    expect(notifyCount).toBe(0);
  });

  // 异步路径去重：applyUpdate 应用同一份 update（同 client+clock，Yjs 幂等重放），
  // 重算 key 不变 → 0 次通知
  test("applyUpdate 内容未变时异步重算后仍不通知", async () => {
    const update = encodeMessageUpdate("user", "hello", 0);
    store.applyUpdate(update);
    await flushRecompute();
    expect(notifyCount).toBe(1);

    // 重放同一份 update（服务端重发/幂等帧场景）：Yjs 检测到已存在，内容不变
    store.applyUpdate(update);
    await flushRecompute();

    expect(notifyCount).toBe(1);
  });

  // 慢路径降频：重算耗时超预算后，下一次 applyUpdate 的通知延迟到 50ms 窗口
  test("重算超预算后切换到慢路径（50ms 窗口合并）", async () => {
    // 用 busy-loop 模拟高成本重算（稳定超过 12ms 预算）
    let simulateSlow = false;
    const slowStore = createYjsStore<TestSnapshot>(
      (doc) => {
        if (simulateSlow) {
          const deadline = performance.now() + 20;
          while (performance.now() < deadline) {
            /* busy loop */
          }
        }
        return computeTestSnapshot(doc);
      },
      getInitialTestSnapshot(),
      getTestSnapshotKey,
    );
    slowStore.switchDoc("slow", () => ({ ydoc: new Y.Doc() }));
    let lastNotifyAt = 0;
    slowStore.subscribe(() => {
      lastNotifyAt = performance.now();
    });

    // 第一次 applyUpdate：快路径立即重算，耗时超预算 → 进入慢路径
    simulateSlow = true;
    slowStore.applyUpdate(encodeMessageUpdate("user", "hello", 0));
    await flushRecompute();

    // 第二次 applyUpdate：走 50ms 慢路径窗口，通知应显著晚于宏任务
    const t0 = performance.now();
    slowStore.applyUpdate(encodeMessageUpdate("assistant", "hi", 1));
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (lastNotifyAt >= t0) {
          clearInterval(timer);
          resolve();
        }
      }, 2);
    });
    expect(lastNotifyAt - t0).toBeGreaterThanOrEqual(40);

    slowStore.destroy();
  });
});
