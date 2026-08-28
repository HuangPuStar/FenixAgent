// web/src/__tests__/use-task-views.test.tsx
// 切片 2：Peri Task 前端视图的数据流测试。
//
// 覆盖：
// - computePeriTaskViews 纯函数：排序（非终态在前 → updatedAt 降序 → taskOrder
//   稳定）、未同步（子树缺失 → loaded=false）、非法字段 allowlist 收敛、引用稳定；
// - useTaskViews hook：经 DocHub 共享 Session Doc 订阅任务更新、内容未变时
//   snapshot.tasks 引用稳定（配合 React.memo 不触发无关重渲染）、无关 Session
//   Doc 子树变化不触发任务快照重算、切换会话不串扰。
//
// 不写纯 UI 结构断言：列表/卡片的展示状态由组件内部收敛，此处只验证数据流。

import { describe, expect, test } from "bun:test";
import type { PeriTaskViewProjection } from "@fenix/chat-channel";
import { upsertPeriTaskView } from "@fenix/chat-channel";
// createSessionDoc 属聚合层服务端能力，经 server 子路径导入（双入口边界）
import { createChatDoc, createSessionDoc } from "@fenix/chat-channel/server";
import { Window } from "happy-dom";
import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Y from "yjs";
import { computePeriTaskViews, useTaskViews } from "../hooks/use-task-views";
import { createSessionDocBinding, replaceDocHubUpdate, type SharedDocBinding } from "../yjs/doc-hub";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 设置最小 DOM 环境（react-dom/client 模块加载时需要 window；与
// use-chat-state-hook.test.tsx 同款处理，仅在本文件作用域内生效）
const win = new Window();
const g = globalThis as Record<string, unknown>;
if (!g.window) g.window = win;
if (!g.document) g.document = win.document;
if (!g.navigator) g.navigator = win.navigator;

/** 构造完整 PeriTaskViewProjection（缺省字段给安全默认，overrides 覆盖） */
function makeTask(overrides: Partial<PeriTaskViewProjection> & { taskId: string }): PeriTaskViewProjection {
  const { taskId, ...rest } = overrides;
  return {
    taskId,
    kind: "subagent",
    taskSubtype: null,
    title: `task-${taskId}`,
    summary: null,
    status: "running",
    turnId: null,
    isBackground: false,
    startedAt: "2026-08-18T00:00:00.000Z",
    completedAt: null,
    updatedAt: "2026-08-18T00:00:00.000Z",
    detailAvailability: "preview",
    ...rest,
  };
}

/** 构造已补齐 v4 结构的 Session Doc（root.tasks / root.taskOrder 存在） */
function seedSessionDoc(): Y.Doc {
  return createSessionDoc("rcs-task-test", null).ydoc;
}

describe("computePeriTaskViews 纯函数", () => {
  // 子树缺失（Session Doc 快照未到达）→ loaded=false 且空任务列表，
  // 不得因读取未创建的 Y 类型而抛错
  test("未同步的 Session Doc 返回 loaded=false", () => {
    const doc = new Y.Doc();
    const snapshot = computePeriTaskViews(doc);
    expect(snapshot.loaded).toBe(false);
    expect(snapshot.tasks).toHaveLength(0);
  });

  // 排序：非终态在前 → 组内 updatedAt 降序 → taskOrder 稳定（创建顺序）
  test("排序：非终态在前，组内按 updatedAt 降序，taskOrder 为最终稳定序", () => {
    const doc = seedSessionDoc();
    act(() => {
      // 创建顺序 A,B,C,D；updatedAt 刻意与创建顺序无关
      upsertPeriTaskView(doc, makeTask({ taskId: "A", status: "completed", updatedAt: "2026-08-18T01:00:00.000Z" }));
      upsertPeriTaskView(doc, makeTask({ taskId: "B", status: "running", updatedAt: "2026-08-18T03:00:00.000Z" }));
      upsertPeriTaskView(doc, makeTask({ taskId: "C", status: "running", updatedAt: "2026-08-18T02:00:00.000Z" }));
      upsertPeriTaskView(doc, makeTask({ taskId: "D", status: "failed", updatedAt: "2026-08-18T04:00:00.000Z" }));
    });
    const snapshot = computePeriTaskViews(doc);
    expect(snapshot.loaded).toBe(true);
    // 非终态组 [B,C]（updatedAt 降序）+ 终态组 [D,A]（updatedAt 降序）
    expect(snapshot.tasks.map((t) => t.taskId)).toEqual(["B", "C", "D", "A"]);
  });

  // updatedAt 相同时保持 taskOrder 相对顺序（稳定排序，不臆造顺序）
  test("updatedAt 相同按 taskOrder 稳定排序", () => {
    const doc = seedSessionDoc();
    const ts = "2026-08-18T01:00:00.000Z";
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "first", updatedAt: ts }));
      upsertPeriTaskView(doc, makeTask({ taskId: "second", updatedAt: ts }));
    });
    const snapshot = computePeriTaskViews(doc);
    expect(snapshot.tasks.map((t) => t.taskId)).toEqual(["first", "second"]);
  });

  // 非法时间戳降级为 0（排在组尾），不拒绝整个任务
  test("非法 updatedAt 降级排序，不丢弃任务", () => {
    const doc = seedSessionDoc();
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "bad", status: "completed", updatedAt: "not-a-date" }));
      upsertPeriTaskView(doc, makeTask({ taskId: "ok", status: "completed", updatedAt: "2026-08-18T01:00:00.000Z" }));
    });
    const snapshot = computePeriTaskViews(doc);
    expect(snapshot.tasks.map((t) => t.taskId)).toEqual(["ok", "bad"]);
  });

  // 非法 status / subtype / detailAvailability 一律 allowlist 收敛到安全默认，
  // 不向 UI 泄漏原始值（篡改/旧快照防御）
  test("非法字段收敛到安全默认", () => {
    const doc = seedSessionDoc();
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "T1" }));
    });
    // 直接改 Y.Map 模拟被篡改/损坏的 Doc 数据（绕过 writer 的合法值）
    const map = (doc.getMap("root").get("tasks") as Y.Map<Y.Map<unknown>>).get("T1")!;
    act(() => {
      map.set("status", "bogus-status");
      map.set("taskSubtype", "bogus-subtype");
      map.set("detailAvailability", "bogus-detail");
      map.set("kind", "bogus-kind");
      map.set("title", 42);
      map.set("summary", 12345);
      map.set("updatedAt", 999);
    });
    const [task] = computePeriTaskViews(doc).tasks;
    expect(task.status).toBe("running");
    expect(task.taskSubtype).toBeNull();
    expect(task.detailAvailability).toBe("unavailable");
    expect(task.kind).toBe("subagent");
    expect(task.title).toBe("");
    expect(task.summary).toBeNull();
    expect(task.updatedAt).toBe("");
  });

  // 引用稳定：内容未变时重复调用返回同一数组引用（配合 React.memo 的关键契约）
  test("内容未变时返回稳定引用", () => {
    const doc = seedSessionDoc();
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "A" }));
      upsertPeriTaskView(doc, makeTask({ taskId: "B", status: "completed" }));
    });
    const first = computePeriTaskViews(doc);
    const second = computePeriTaskViews(doc);
    expect(first.tasks).toBe(second.tasks);
    expect(first.loaded).toBe(true);
  });

  // 数据变化后引用更新（稳定引用 ≠ 缓存永不失效）
  test("数据变化后快照更新且引用变化", () => {
    const doc = seedSessionDoc();
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "A" }));
    });
    const before = computePeriTaskViews(doc);
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "B" }));
    });
    const after = computePeriTaskViews(doc);
    expect(before.tasks).not.toBe(after.tasks);
    expect(after.tasks.map((t) => t.taskId)).toEqual(["A", "B"]);
  });

  // tasks 有而 taskOrder 缺失的异常数据：补齐尾部，投影不丢失
  test("tasks 中 order 缺失的条目补齐尾部", () => {
    const doc = seedSessionDoc();
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "A" }));
      upsertPeriTaskView(doc, makeTask({ taskId: "B" }));
    });
    // 模拟旧快照/损坏：清空 taskOrder 后重新只登记 B
    act(() => {
      const order = doc.getMap("root").get("taskOrder") as Y.Array<string>;
      order.delete(0, order.length);
      order.push(["B"]);
    });
    const snapshot = computePeriTaskViews(doc);
    // B 在 order 中排前，A 补齐尾部（不丢任务）
    expect(snapshot.tasks.map((t) => t.taskId)).toEqual(["B", "A"]);
  });
});

describe("useTaskViews hook 生命周期", () => {
  // 每个测试独立创建 harness（root 一旦 unmount 不可复用）
  type TaskSnapshot = { tasks: readonly PeriTaskViewProjection[]; loaded: boolean };
  function createHarness() {
    const latest = { value: null as TaskSnapshot | null };
    function Probe({ rcsSessionId }: { rcsSessionId: string }) {
      const { state } = useTaskViews(rcsSessionId);
      latest.value = state;
      return null;
    }
    const container = win.document.createElement("div");
    const root: Root = createRoot(container as unknown as HTMLElement);
    return {
      latest,
      render: (rcsSessionId: string) =>
        act(() => {
          root.render(createElement(StrictMode, null, createElement(Probe, { rcsSessionId })));
        }),
      unmount: () =>
        act(() => {
          root.unmount();
        }),
    };
  }

  // 等待派生重算调度落地（Yjs observe → store 通知 → useSyncExternalStore）
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }

  /** 经 DocHub 绑定共享 Session Doc 并注入 v4 骨架；返回 doc 与显式释放（引用计数配对） */
  function seedSharedSession(rcsSessionId: string): { doc: Y.Doc; release: () => void } {
    const binding: SharedDocBinding = createSessionDocBinding(rcsSessionId);
    act(() => {
      Y.applyUpdate(binding.ydoc, Y.encodeStateAsUpdate(createSessionDoc(rcsSessionId, null).ydoc));
    });
    return { doc: binding.ydoc, release: binding.cleanup };
  }

  // hook 从共享 Session Doc 订阅任务：任务写入后快照跟随更新
  test("订阅共享 Session Doc，任务写入后快照更新", async () => {
    const { doc, release } = seedSharedSession("rcs-task-hook-a");
    const h = createHarness();
    h.render("rcs-task-hook-a");
    await flush();
    // 空任务：loaded=true（v4 骨架已同步），tasks 为空
    expect(h.latest.value?.loaded).toBe(true);
    expect(h.latest.value?.tasks).toHaveLength(0);

    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "T1", status: "running", title: "Subagent 探索" }));
    });
    await flush();
    expect(h.latest.value?.tasks.map((t) => t.taskId)).toEqual(["T1"]);
    expect(h.latest.value?.tasks[0].title).toBe("Subagent 探索");

    // 内容未变时（flush 触发重算但 doc 无更新）引用稳定
    const ref = h.latest.value!.tasks;
    await flush();
    expect(h.latest.value?.tasks).toBe(ref);

    h.unmount();
    release();
  });

  // 无关 Session Doc 子树变化不触发任务快照重算（订阅只针对 tasks/taskOrder）
  test("无关子树更新不改变任务快照引用", async () => {
    const { doc, release } = seedSharedSession("rcs-task-hook-b");
    const h = createHarness();
    h.render("rcs-task-hook-b");
    await flush();
    act(() => {
      upsertPeriTaskView(doc, makeTask({ taskId: "T1" }));
    });
    await flush();
    const ref = h.latest.value!.tasks;

    // session 子树（如标题）变化：任务快照引用必须保持稳定
    act(() => {
      (doc.getMap("root").get("session") as Y.Map<unknown>).set("title", "改名");
    });
    await flush();
    expect(h.latest.value?.tasks).toBe(ref);

    h.unmount();
    release();
  });

  // 首帧 replace 会替换 DocHub 内的 Y.Doc；hook 必须重新绑定新 Session Doc，不能继续监听已销毁的旧 doc
  test("DocHub 全量替换后重新绑定并读取任务", async () => {
    const rcsSessionId = "rcs-task-hook-replace";
    const h = createHarness();
    h.render(rcsSessionId);
    await flush();

    const session = createSessionDoc(rcsSessionId, null).ydoc;
    upsertPeriTaskView(session, makeTask({ taskId: "replaced-task", title: "后台任务" }));
    const chat = createChatDoc(rcsSessionId, null).ydoc;
    act(() => {
      replaceDocHubUpdate(rcsSessionId, `chat:${rcsSessionId}`, "gen-1", Y.encodeStateAsUpdate(chat));
      replaceDocHubUpdate(rcsSessionId, `session:${rcsSessionId}`, "gen-1", Y.encodeStateAsUpdate(session));
    });
    await flush();

    expect(h.latest.value?.tasks.map((task) => task.taskId)).toEqual(["replaced-task"]);
    h.unmount();
  });

  // 切换会话：旧会话任务不串扰，新会话快照正确跟随（DocHub 引用计数配对）
  test("切换会话时快照跟随新 doc，旧任务不串扰", async () => {
    const { doc: docA, release: releaseA } = seedSharedSession("rcs-task-hook-c");
    const h = createHarness();
    h.render("rcs-task-hook-c");
    await flush();
    act(() => {
      upsertPeriTaskView(docA, makeTask({ taskId: "old-task" }));
    });
    await flush();
    expect(h.latest.value?.tasks.map((t) => t.taskId)).toEqual(["old-task"]);

    // 切到 B：绑定新 doc（无任务），旧 doc 任务不可见
    const { doc: docB, release: releaseB } = seedSharedSession("rcs-task-hook-d");
    h.render("rcs-task-hook-d");
    await flush();
    expect(h.latest.value?.tasks).toHaveLength(0);

    // B 写入任务后可见
    act(() => {
      upsertPeriTaskView(docB, makeTask({ taskId: "new-task" }));
    });
    await flush();
    expect(h.latest.value?.tasks.map((t) => t.taskId)).toEqual(["new-task"]);

    h.unmount();
    releaseA();
    releaseB();
  });
});
