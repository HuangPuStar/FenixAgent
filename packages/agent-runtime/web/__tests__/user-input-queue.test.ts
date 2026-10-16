// 待发送队列（peri steer）在 agent-runtime 侧的两段契约：出站动作的形状，以及 Session Doc 投影的读取。
//
// 为什么钉这两段：
//   ① 出站 —— 三个控制面 action 的名字与字段由前端产生，写错不会报错，只会让服务端静默忽略
//      （用户看到「点了没反应」）。端口是纯函数，直接对字面量断言最省事。
//   ② 读取 —— 队列是服务端唯一事实源，前端投影必须按状态机收窄（delivered/withdrawn 剔除、
//      未知 state 收敛为 unknown、空草稿归一为缺省），否则会出现幽灵条目或取回回填空串。
// 能力位的两道门（能力位 + enabled）在此一并钉住：任一为假都必须落到未启用快照，让提交回退直发。

import { describe, expect, test } from "bun:test";
import {
  applyUserInputQueueEvent,
  getSessionRoot,
  initSessionDocStructure,
  type NormalizedUserInputQueueEvent,
  PERI_USER_INPUT_QUEUE_CAPABILITY,
  readUserInputQueue,
  setUserInputQueueState,
  type UserInputQueueItemProjection,
  type UserInputQueueSnapshot,
} from "@fenix/chat-channel";
import * as Y from "yjs";
import { createUserInputQueueSendPorts } from "../agent-panel/chat-panel-user-input-queue";
import { computeUserInputQueue } from "../hooks/use-user-input-queue";

/** 建一个带队列投影位的 Session Doc（结构与快照恢复补齐后一致）。 */
function newSessionDoc(): Y.Doc {
  const ydoc = new Y.Doc();
  initSessionDocStructure(ydoc);
  return ydoc;
}

/** 写入 agent 能力位（读取侧在缺显式 enabled 时的兜底来源）。 */
function setCapability(ydoc: Y.Doc, value: unknown): void {
  const agent = getSessionRoot(ydoc).get("agent") as Y.Map<unknown>;
  const capabilities = new Y.Map<unknown>();
  capabilities.set(PERI_USER_INPUT_QUEUE_CAPABILITY, value);
  agent.set("capabilities", capabilities);
}

/** 队列项（`state` 故意收宽为 string，才能构造契约外的脏数据）。 */
function rawItem(inputId: string, content: string, originalDraft: string, state: string): UserInputQueueItemProjection {
  return { inputId, content, originalDraft, state: state as UserInputQueueItemProjection["state"] };
}

/** 队列全量快照事件（构造器补齐 NormalizedEvent 的基类字段，避免在断言处做强转）。 */
function queueChanged(items: UserInputQueueItemProjection[], overrides: Partial<UserInputQueueSnapshot> = {}) {
  const snapshot: UserInputQueueSnapshot = {
    generation: "gen-1",
    revision: 1,
    activeRequestId: null,
    items,
    ...overrides,
  };
  return { type: "user_input_queue_changed", update: {}, content: null, snapshot } as NormalizedUserInputQueueEvent;
}

/** delivered 事件（服务端摘除已进入 transcript 的用户输入）。 */
function delivered(inputId: string) {
  return {
    type: "user_input_delivered",
    update: {},
    content: null,
    generation: "gen-1",
    input_id: inputId,
  } as NormalizedUserInputQueueEvent;
}

describe("待发送队列出站端口", () => {
  // 三个 action 的字段名必须逐字对齐服务端契约：入队带 inputId/content/originalDraft，不带 sessionId
  test("入队携带前端生成的 inputId 与原始草稿", () => {
    const sent: Record<string, unknown>[] = [];
    const ports = createUserInputQueueSendPorts((data) => {
      sent.push(data);
      return true;
    });

    expect(
      ports.onEnqueueUserInput({
        content: [{ type: "text", text: "你好" }],
        originalDraft: "你好",
      }),
    ).toBe(true);

    expect(sent).toHaveLength(1);
    const action = sent[0];
    expect(action?.action).toBe("enqueue_user_input");
    expect(action?.content).toEqual([{ type: "text", text: "你好" }]);
    expect(action?.originalDraft).toBe("你好");
    expect(typeof action?.inputId).toBe("string");
    // 每条入队都必须是新的 UUID（同一 id 会被服务端按幂等判重，第二条提交直接消失）
    ports.onEnqueueUserInput({ content: [], originalDraft: undefined });
    expect(sent[1]?.inputId).not.toBe(sent[0]?.inputId);
    expect(sent).toHaveLength(2);
    // 契约口径：队列控制面按连接会话路由，不携带 sessionId
    expect(action?.sessionId).toBeUndefined();
  });

  // 单发与全发是同一个 action：一个 id 即单发，全部 queued id 即全发
  test("派发携带 inputIds 数组", () => {
    const sent: Record<string, unknown>[] = [];
    const ports = createUserInputQueueSendPorts((data) => {
      sent.push(data);
      return true;
    });

    ports.onDispatchUserInputs(["in-1"]);
    ports.onDispatchUserInputs(["in-1", "in-3"]);

    expect(sent).toEqual([
      { action: "dispatch_user_inputs", inputIds: ["in-1"] },
      { action: "dispatch_user_inputs", inputIds: ["in-1", "in-3"] },
    ]);
  });

  // 取回按 inputId 寻址；出站失败必须原样返回 false，渲染层据此给可重试提示
  test("取回携带 inputId，出站失败原样返回 false", () => {
    const sent: Record<string, unknown>[] = [];
    const ports = createUserInputQueueSendPorts((data) => {
      sent.push(data);
      return false;
    });

    expect(ports.onTakebackUserInput("in-9")).toBe(false);
    expect(sent).toEqual([{ action: "takeback_user_input", inputId: "in-9" }]);
  });
});

describe("待发送队列读取投影", () => {
  // 结构缺失（旧快照 / 未装配）按未启用处理：前端不得凭猜测开启入队交互
  test("结构缺失时返回未启用快照", () => {
    const ydoc = new Y.Doc();
    expect(computeUserInputQueue(ydoc)).toMatchObject({ enabled: false, items: [] });
  });

  // 能力位与 enabled 同时为真才启用：显式 enabled=false 必须能压住能力位兜底
  test("能力位兜底与显式开关的优先级", () => {
    const fallback = newSessionDoc();
    setCapability(fallback, true);
    expect(readUserInputQueue(fallback).enabled).toBe(true);
    expect(computeUserInputQueue(fallback).enabled).toBe(true);

    const suppressed = newSessionDoc();
    setCapability(suppressed, true);
    setUserInputQueueState(suppressed, { enabled: false });
    expect(computeUserInputQueue(suppressed).enabled).toBe(false);

    const unnamed = newSessionDoc();
    setCapability(unnamed, "yes");
    expect(computeUserInputQueue(unnamed).enabled).toBe(false);
  });

  // 展示投影的收窄：delivered/withdrawn 剔除、unknown 保留但不可操作、空草稿归一为缺省
  test("投影剔除终态项并把空草稿归一为缺省", () => {
    const ydoc = newSessionDoc();
    setUserInputQueueState(ydoc, { enabled: true });
    applyUserInputQueueEvent(
      ydoc,
      queueChanged([
        rawItem("in-1", "第一条", "第一条", "queued"),
        rawItem("in-2", "第二条", "", "dispatching"),
        rawItem("in-3", "第三条", "草稿", "delivered"),
        rawItem("in-4", "第四条", "草稿", "withdrawn"),
        rawItem("in-5", "第五条", "", "claimed"),
      ]),
    );

    const view = computeUserInputQueue(ydoc);
    expect(view.enabled).toBe(true);
    expect(view.generation).toBe("gen-1");
    expect(view.revision).toBe(1);
    expect(view.items.map((item) => [item.inputId, item.state])).toEqual([
      ["in-1", "queued"],
      ["in-2", "dispatching"],
      ["in-5", "claimed"],
    ]);
    // 空草稿按「没有草稿」处理：取回时回退可展示文本，不把空串写回输入框
    expect(view.items[0]?.originalDraft).toBe("第一条");
    expect(view.items[1]?.originalDraft).toBeUndefined();
  });

  // 契约外的脏 state 收敛为 unknown（可见但不可操作），不因一条脏数据让整块区域消失
  test("未知 state 收敛为 unknown", () => {
    const ydoc = newSessionDoc();
    setUserInputQueueState(ydoc, { enabled: true });
    applyUserInputQueueEvent(ydoc, queueChanged([rawItem("in-1", "第一条", "第一条", "weird")]));

    expect(computeUserInputQueue(ydoc).items[0]?.state).toBe("unknown");
  });

  // 缓存只在队列子树变化时失效：读两次要拿到稳定引用，写入后必须看到新值（否则界面停在旧队列）
  test("子树变化后重派生，未变化时引用稳定", () => {
    const ydoc = newSessionDoc();
    setUserInputQueueState(ydoc, { enabled: true });
    applyUserInputQueueEvent(ydoc, queueChanged([rawItem("in-1", "第一条", "", "queued")]));

    const first = computeUserInputQueue(ydoc);
    expect(computeUserInputQueue(ydoc)).toBe(first);
    expect(first.items).toHaveLength(1);

    // delivered 由服务端事件摘除：投影必须立刻反映，等不到下一次全量快照
    applyUserInputQueueEvent(ydoc, delivered("in-1"));
    const second = computeUserInputQueue(ydoc);
    expect(second).not.toBe(first);
    expect(second.items).toHaveLength(0);
  });

  // 无关子树（如 session）变化不得让队列投影重派生：队列区渲染成本与消息流解耦
  test("无关子树变化不使队列投影失效", () => {
    const ydoc = newSessionDoc();
    setUserInputQueueState(ydoc, { enabled: true });
    const first = computeUserInputQueue(ydoc);

    (getSessionRoot(ydoc).get("session") as Y.Map<unknown>).set("status", "running");

    expect(computeUserInputQueue(ydoc)).toBe(first);
  });
});
