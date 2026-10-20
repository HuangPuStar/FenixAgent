import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import type { ComposerExternalEvent, ComposerExternalSubscribe } from "../chat/composer/composer-effects";
import { ACPMain } from "../chat/shell/ACPMain";
import { ChatInterface } from "../chat/shell/ChatInterface";
import type {
  UserInputQueueEnqueueRequest,
  UserInputQueueItemView,
  UserInputQueueView,
} from "../chat/shell/chat-interface-types";
import type { ChatStateSnapshot, ContentBlock, SessionStateSnapshot } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 待发送队列（peri steer）的交互测试：入队 vs 直发的分流、单发/全发/取回三条动作、取回回填的
 * 覆盖条件、失败提示与重试，以及能力位为假时的完整回退。
 *
 * 只测行为与数据流（不是 UI 结构断言）：判定「提交去哪了」看端口调用，判定「条目从哪来」看注入的
 * 队列投影——组件不得持有第二份队列状态，因此投影不变时界面就不该变。
 *
 * 草稿注入走 `subscribeExternal` 的 `suggested-prompt`（仓库既有做法，见 `chat-composer.test.tsx`）：
 * happy-dom 下构造出来的事件拿不到 React 的 targetInst，受控输入无法用真实按键模拟。
 */

const window = initializeHappyDomWindow(new Window());
// biome-ignore lint/suspicious/noExplicitAny: 测试环境把 happy-dom 的 DOM/浏览器全局注入 globalThis（与同目录用例同源）
Object.assign(globalThis as any, {
  window,
  document: window.document,
  navigator: window.navigator,
  FileReader: window.FileReader,
  getComputedStyle: window.getComputedStyle.bind(window),
  ResizeObserver: window.ResizeObserver,
  HTMLElement: window.HTMLElement,
  customElements: window.customElements,
  requestAnimationFrame: window.requestAnimationFrame.bind(window),
  cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
  /** React 19 的 act 环境标记 */
  IS_REACT_ACT_ENVIRONMENT: true,
});

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const host = window.document.createElement("div");
  // happy-dom 的 appendChild 要求同源 Node 类型（与 DOM lib 的 Node 声明不同名）
  window.document.body.appendChild(host as unknown as Parameters<typeof window.document.body.appendChild>[0]);
  container = host as unknown as HTMLDivElement;
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

// ── 快照与投影构造 ──

/** 会话快照；`loading` 非空即「turn 运行中」（`ChatInterface` 的 isLoading）。 */
function sessionState(loading: boolean, canCancel = loading): SessionStateSnapshot {
  return {
    acpSessionId: "ses_queue_test",
    sessionStatus: "ready",
    status: loading ? "responding" : "idle",
    loading: loading ? { kind: "session/respond", since: 0 } : null,
    canCancel,
    structuredMessages: [],
    pendingQuestions: new Map(),
  };
}

function chatState(): ChatStateSnapshot {
  return {
    sessions: [],
    activeSessionId: "ses_queue_test",
    permissions: [],
    capabilities: null,
    modelState: null,
    modeState: null,
    availableCommands: [],
    sessionListLoaded: true,
    tokenUsage: null,
  };
}

/** 队列单项投影（`originalDraft` 缺省表示服务端没带草稿）。 */
function item(state: UserInputQueueItemView["state"], inputId: string, content: string, originalDraft?: string) {
  return { inputId, content, originalDraft, state } satisfies UserInputQueueItemView;
}

function queueView(items: UserInputQueueItemView[], enabled = true): UserInputQueueView {
  return { enabled, generation: "gen-1", revision: 1, activeRequestId: null, items };
}

// ── 端口替身与挂载 ──

interface QueuePorts {
  /** 每次出站调用的实参留痕，断言「这次提交去哪了」 */
  sent: ContentBlock[][];
  enqueued: UserInputQueueEnqueueRequest[];
  dispatched: string[][];
  takenBack: string[];
}

interface MountOptions {
  loading?: boolean;
  /** 运行中是否可中断（决定常驻位是停止按钮还是发送按钮） */
  canCancel?: boolean;
  supportsQueue?: boolean;
  queue?: UserInputQueueView | null;
  /** 出站是否未送达（模拟 socket 未就绪）；计数递减，为 0 起按成功处理 */
  failEnqueue?: number;
  failDispatch?: number;
  failTakeback?: number;
}

/** 挂载 ChatInterface，注入队列端口与外部输入通道；返回值用于驱动与断言。 */
function mount(options: MountOptions = {}): {
  ports: QueuePorts;
  /** 向输入岛注入草稿（`suggested-prompt`：替换正文，用于制造「输入框非空」） */
  setDraft: (text: string) => void;
} {
  const ports: QueuePorts = { sent: [], enqueued: [], dispatched: [], takenBack: [] };
  let emitExternal: ((event: ComposerExternalEvent) => void) | undefined;
  const subscribeExternal: ComposerExternalSubscribe = (handler) => {
    emitExternal = handler;
    return () => {
      emitExternal = undefined;
    };
  };
  let failEnqueue = options.failEnqueue ?? 0;
  let failDispatch = options.failDispatch ?? 0;
  let failTakeback = options.failTakeback ?? 0;

  act(() => {
    root.render(
      <ChatInterface
        agentId="env_queue_test"
        rcsSessionId="rcs_queue_test"
        sessionState={sessionState(options.loading ?? false, options.canCancel ?? options.loading ?? false)}
        chatState={chatState()}
        onSendPrompt={async (blocks) => {
          ports.sent.push(blocks);
        }}
        onCancel={() => {}}
        onCreateSession={async () => {}}
        onRespondPermission={() => {}}
        onRespondQuestion={() => {}}
        availableCommands={[]}
        availableModes={[]}
        currentModeId={null}
        onSetMode={() => {}}
        supportsModeSelection={false}
        supportsImages={false}
        modelName={undefined}
        onNotice={() => {}}
        subscribeExternal={subscribeExternal}
        supportsUserInputQueue={options.supportsQueue ?? true}
        userInputQueue={options.queue ?? queueView([])}
        onEnqueueUserInput={(request) => {
          if (failEnqueue > 0) {
            failEnqueue -= 1;
            return false;
          }
          ports.enqueued.push(request);
          return true;
        }}
        onDispatchUserInputs={(inputIds) => {
          if (failDispatch > 0) {
            failDispatch -= 1;
            return false;
          }
          ports.dispatched.push(inputIds);
          return true;
        }}
        onTakebackUserInput={(inputId) => {
          if (failTakeback > 0) {
            failTakeback -= 1;
            return false;
          }
          ports.takenBack.push(inputId);
          return true;
        }}
      />,
    );
  });

  return {
    ports,
    setDraft: (text) => {
      act(() => emitExternal?.({ type: "suggested-prompt", prompt: text }));
    },
  };
}

const textarea = () => container.querySelector<HTMLTextAreaElement>("textarea");
const queueRegion = () => container.querySelector('[data-slot="user-input-queue"]');
const queueItems = () => Array.from(container.querySelectorAll<HTMLLIElement>('[data-slot="user-input-queue-item"]'));
const queueAlerts = () => Array.from(container.querySelectorAll('[data-slot="user-input-queue-error"]'));

/** 按 `data-slot` 找按钮（同一 slot 出现多个时取第 index 个）。 */
function button(slot: string, index = 0): HTMLButtonElement {
  const node = container.querySelectorAll<HTMLButtonElement>(`[data-slot="${slot}"]`)[index];
  if (!node) throw new Error(`未找到按钮 ${slot}#${index}`);
  return node;
}

const hasButton = (slot: string) => container.querySelector(`[data-slot="${slot}"]`) !== null;
const click = (target: HTMLElement): void => act(() => target.click());

/** 在输入框上派发回车（React 合成事件经容器委托到冒泡的 keydown）。 */
function pressEnter(): void {
  const box = textarea();
  if (!box) throw new Error("未渲染输入框");
  act(() => {
    box.focus();
    box.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }) as unknown as KeyboardEvent);
  });
}

/** 取输入岛发送按钮：运行中且队列可用时，常驻的发送位被停止按钮占用，入队入口另有一格。 */
function submitButton(): HTMLButtonElement {
  return hasButton("chat-composer-queue-send") ? button("chat-composer-queue-send") : button("chat-composer-send");
}

describe("待发送队列（peri steer）", () => {
  // 能力位为假时队列区完全不出现，即使投影里已有条目（旧 agent 上不能冒出无主的待发送区）
  test("能力位为假时不渲染队列区，运行中提交维持被忽略", () => {
    const { ports, setDraft } = mount({
      loading: true,
      supportsQueue: false,
      queue: queueView([item("queued", "in-1", "第一条")]),
    });
    setDraft("运行中提交");

    expect(queueRegion()).toBeNull();
    // 运行中且队列不可用：连入队入口都不该出现（发送位仍是停止按钮）
    expect(hasButton("chat-composer-queue-send")).toBe(false);
    pressEnter();
    expect(ports.enqueued.length).toBe(0);
    expect(ports.sent.length).toBe(0);
  });

  // 队列非空但能力位为假：提交仍走直发，不被投影里的条目劫持
  test("能力位为假时队列非空也维持直发", () => {
    const { ports, setDraft } = mount({ supportsQueue: false, queue: queueView([item("queued", "in-1", "第一条")]) });
    setDraft("直发内容");

    click(submitButton());
    expect(ports.sent.length).toBe(1);
    expect(ports.sent[0]?.[0]).toMatchObject({ type: "text", text: "直发内容" });
    expect(ports.enqueued.length).toBe(0);
  });

  // 能力位为真但会话未协商队列（enabled=false）：同样回退直发，避免把提交投进服务端不认的队列
  test("队列 enabled 为假时回退直发", () => {
    const { ports, setDraft } = mount({ supportsQueue: true, queue: queueView([], false) });
    setDraft("直发内容");

    expect(queueRegion()).toBeNull();
    pressEnter();
    expect(ports.sent.length).toBe(1);
    expect(ports.enqueued.length).toBe(0);
  });

  // 空闲且队列为空：提交直发（旧路径的基线，证明回车/按钮在测试环境里确实会触发提交）
  test("队列为空且空闲时提交直发 send_prompt", () => {
    const { ports, setDraft } = mount({ supportsQueue: true, queue: queueView([]) });
    setDraft("直发内容");

    expect(hasButton("chat-composer-queue-send")).toBe(false);
    pressEnter();
    expect(ports.sent.length).toBe(1);
    expect(ports.enqueued.length).toBe(0);
  });

  // 运行中提交不打断执行：走 enqueue_user_input，且带上用户原始草稿供取回回填
  test("运行中提交入队而不打断执行", () => {
    const { ports, setDraft } = mount({ loading: true, queue: queueView([]) });
    setDraft("运行中提交");

    click(submitButton());
    expect(ports.enqueued.length).toBe(1);
    expect(ports.enqueued[0]?.content[0]).toMatchObject({ type: "text", text: "运行中提交" });
    expect(ports.enqueued[0]?.originalDraft).toBe("运行中提交");
    expect(ports.sent.length).toBe(0);
  });

  // 运行中的回车与按钮同源：也不打断，直接入队
  test("运行中回车同样入队", () => {
    const { ports, setDraft } = mount({ loading: true, queue: queueView([]) });
    setDraft("回车入队");

    pressEnter();
    expect(ports.enqueued.length).toBe(1);
    expect(ports.sent.length).toBe(0);
  });

  // 队列非空（即使当前空闲）：提交继续入队，不越过队首插队直发
  test("队列非空时提交入队，不越过队首插队", () => {
    const { ports, setDraft } = mount({ queue: queueView([item("queued", "in-1", "第一条")]) });
    setDraft("排到队尾");

    click(submitButton());
    expect(ports.enqueued.length).toBe(1);
    expect(ports.sent.length).toBe(0);
  });

  // 取消已发出的运行中（不可中断）：常驻位是禁用的停止按钮，入队入口仍可用且不误触中断
  test("运行中不可中断时仍能入队", () => {
    const { ports, setDraft } = mount({ loading: true, canCancel: false, queue: queueView([]) });
    setDraft("工具执行中提交");

    const stop = container.querySelector<HTMLButtonElement>('[data-slot="chat-composer-send"]');
    expect(stop?.getAttribute("aria-label")).toBe("Stop");
    expect(stop?.disabled).toBe(true);

    click(button("chat-composer-queue-send"));
    expect(ports.enqueued.length).toBe(1);
    expect(ports.sent.length).toBe(0);
  });

  // 队列区按服务端状态机呈现：queued 可操作，dispatching/claimed 显示发送中且无按钮，unknown 只读
  test("队列区展示条目状态并只给可操作项按钮", () => {
    mount({
      queue: queueView([
        item("queued", "in-1", "等待中"),
        item("dispatching", "in-2", "派发中"),
        item("claimed", "in-3", "已认领"),
        item("unknown", "in-4", "脏数据"),
      ]),
    });

    const region = queueRegion();
    expect(region).not.toBeNull();
    expect(region?.getAttribute("aria-label")).toBe("Pending");
    expect(queueItems().map((node) => node.dataset.state)).toEqual(["queued", "dispatching", "claimed", "unknown"]);
    // 只有 queued 那一项有两个操作按钮（单发 + 取回）
    expect(container.querySelectorAll('[data-slot="user-input-queue-dispatch-one"]').length).toBe(1);
    expect(container.querySelectorAll('[data-slot="user-input-queue-takeback"]').length).toBe(1);
    expect(container.textContent).toContain("Sending…");
    expect(container.textContent).toContain("Unknown state");
  });

  // 单发只发这一条；全发只带 state=queued 的项（dispatching/claimed 已在派发中，不得重复提交）
  test("单发与全发分别携带正确的 inputId", () => {
    const { ports } = mount({
      queue: queueView([
        item("queued", "in-1", "第一条"),
        item("claimed", "in-2", "发送中"),
        item("queued", "in-3", "第三条"),
      ]),
    });

    click(button("user-input-queue-dispatch-one"));
    expect(ports.dispatched).toEqual([["in-1"]]);

    click(button("user-input-queue-dispatch-all"));
    expect(ports.dispatched).toEqual([["in-1"], ["in-1", "in-3"]]);
  });

  // 取回回填：输入框为空时把原始草稿还回去，并发出 takeback 控制面动作；
  // 服务端没带 originalDraft 时回退到可展示文本，不能把草稿还成空串
  test("取回在输入框为空时回填原始草稿", () => {
    const { ports } = mount({ queue: queueView([item("queued", "in-1", "摘要文本", "用户原始草稿")]) });
    click(button("user-input-queue-takeback"));
    expect(ports.takenBack).toEqual(["in-1"]);
    expect(textarea()?.value).toBe("用户原始草稿");

    act(() => root.unmount());
    root = createRoot(container);
    mount({ queue: queueView([item("queued", "in-1", "摘要文本")]) });
    click(button("user-input-queue-takeback"));
    expect(textarea()?.value).toBe("摘要文本");
  });

  // 取回不覆盖：用户已经重新打了字时保留现草稿（覆盖等于丢草稿）
  test("取回不覆盖已输入的草稿", () => {
    const { ports, setDraft } = mount({ queue: queueView([item("queued", "in-1", "摘要文本", "用户原始草稿")]) });
    setDraft("我正在重新写");

    click(button("user-input-queue-takeback"));
    expect(ports.takenBack).toEqual(["in-1"]);
    expect(textarea()?.value).toBe("我正在重新写");
  });

  // 出站失败（socket 未就绪）：给出可重试提示，重试重放同一动作并成功后清掉提示
  test("动作未送达时给出可重试提示，重试重放同一动作", () => {
    const { ports } = mount({ queue: queueView([item("queued", "in-1", "第一条")]), failDispatch: 1 });

    click(button("user-input-queue-dispatch-one"));
    expect(ports.dispatched.length).toBe(0);
    expect(queueAlerts().length).toBe(1);
    expect(queueAlerts()[0]?.textContent).toContain("did not reach the server");

    click(button("user-input-queue-retry"));
    expect(ports.dispatched).toEqual([["in-1"]]);
    expect(queueAlerts().length).toBe(0);
  });

  // 取回未送达时不得回填：条目还在队里，回填会让同一条草稿出现两份
  test("取回未送达时不回填草稿", () => {
    const { ports } = mount({
      queue: queueView([item("queued", "in-1", "摘要文本", "用户原始草稿")]),
      failTakeback: 1,
    });

    click(button("user-input-queue-takeback"));
    expect(ports.takenBack.length).toBe(0);
    expect(textarea()?.value).toBe("");
    expect(queueAlerts().length).toBe(1);
  });

  // 入队未送达时队列区仍要出现提示与重试入口（否则第一条入队失败完全无声）
  test("入队未送达时给出提示并支持重试", () => {
    const { ports, setDraft } = mount({ loading: true, queue: queueView([]), failEnqueue: 1 });
    setDraft("会失败的一条");

    click(submitButton());
    expect(ports.enqueued.length).toBe(0);
    expect(queueRegion()).not.toBeNull();
    expect(queueAlerts().length).toBe(1);

    click(button("user-input-queue-retry"));
    expect(ports.enqueued.length).toBe(1);
    expect(queueAlerts().length).toBe(0);
  });

  // 失败提示可关闭，且不改变队列内容（提示只是瞬时态，不是队列状态）
  test("失败提示可关闭", () => {
    mount({ queue: queueView([item("queued", "in-1", "第一条")]), failDispatch: 1 });

    click(button("user-input-queue-dispatch-one"));
    expect(queueAlerts().length).toBe(1);
    click(button("user-input-queue-dismiss"));
    expect(queueAlerts().length).toBe(0);
    expect(queueItems().length).toBe(1);
  });

  // 投影驱动：同一份投影不因用户操作在本地增删条目（界面等 Y.Doc 回推收敛）
  test("动作不改变队列条目（投影是唯一事实源）", () => {
    mount({ queue: queueView([item("queued", "in-1", "第一条")]) });

    click(button("user-input-queue-dispatch-one"));
    click(button("user-input-queue-takeback"));
    expect(queueItems().map((node) => node.dataset.inputId)).toEqual(["in-1"]);
  });

  // ACPMain 的透传：宿主注入的队列端口与投影缺一行透传就会被静默丢弃（类型依旧通过）
  test("ACPMain 透传队列端口与投影", () => {
    const dispatched: string[][] = [];
    act(() => {
      root.render(
        <ACPMain
          agentId="env_queue_test"
          rcsSessionId="rcs_queue_test"
          sessionState={sessionState(false)}
          chatState={chatState()}
          onSendPrompt={() => {}}
          onCancel={() => {}}
          onCreateSession={() => {}}
          onLoadSession={() => {}}
          onResumeSession={() => {}}
          onRenameSession={() => {}}
          onDeleteSession={() => {}}
          onRespondPermission={() => {}}
          onRespondQuestion={() => {}}
          supportsLoadSession={true}
          availableCommands={[]}
          projectEntries={() => []}
          onNotice={() => {}}
          supportsUserInputQueue={true}
          userInputQueue={queueView([item("queued", "in-1", "第一条")])}
          onEnqueueUserInput={() => true}
          onDispatchUserInputs={(inputIds) => {
            dispatched.push(inputIds);
            return true;
          }}
          onTakebackUserInput={() => true}
        />,
      );
    });

    expect(queueItems().length).toBe(1);
    click(button("user-input-queue-dispatch-all"));
    expect(dispatched).toEqual([["in-1"]]);
  });
});
