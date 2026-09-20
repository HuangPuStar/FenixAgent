// web/__tests__/agent-knowledge-bases-page-states.test.tsx
// 知识库页创建弹窗里「表单选项加载失败」的持久态与重试（任务 1.3 §1.3(6) 收口缺口）。
//
// 缺口原状：`getFormOptions()` 失败只写 `console.error`，创建弹窗的解析配置区照常渲染但所有下拉为空，
// 用户看到的是「没有可选的嵌入模型」——把「请求挂了」读成「系统就是没有模型」，也没有恢复入口。
// 被钉住的三条只在运行时的状态流转里成立，读源码断言不到：
//   1. 失败且无选项时整区接管为 `role="alert"` 的持久错误态，配置区文案必须消失（不是叠在一起）；
//   2. 重试按钮真的重新发起 `getFormOptions`（只重置本地 state 不算），成功后退回正常配置区；
//   3. 401/403（`request()` 已归一为 `UNAUTHORIZED`）复用无权限态且**不给**重试按钮。
//
// 环境：happy-dom + react-dom/client（与同批 prod-view / workflow / channel 的组件用例同款）。
// mock 口径是本批约定的「模块作用域 `mock.module` 提供替身 + afterEach `mock.restore()`」：
//   - `react-i18next`：**自己注册替身**（本包两个用例共用 `registerReactI18nextStub`），替身不另抄
//     翻译表——`useTranslation` 委托给 provider 传入的真实实例（本用例注入的就是挂本包字典那份，
//     `createInstance` + 本包字典），字典与断言取的 `TEXT` 同源。必须自己注册的原因：实测 `mock.module`
//     一旦注册就是**进程级**且不可撤销，同批 channel / mcp 文件注册的是 `t: (key) => key` 的替身；
//     替身细节（provider 语义、`t` 的稳定引用）见 `react-i18next-stub.ts`；
//   - `sonner`：toast 需要宿主 Toaster 订阅，本用例只需观察失败反馈没有退化成弹窗；
//   - `@fenix/identity/web`：其实现依赖宿主别名（`@/src/api/request`），包内测试不可运行，注入组织与
//     会话上下文即可（页面据此判断 canManage）；
//   - `@tanstack/react-router`：页面用 `useNavigate` / `useSearch` 读写 `?kbId=`，脱离 RouterProvider
//     会抛错；本用例不需要真实路由跳转，只提供替身；
//   - `@fenix/ui-components/config/FormDialog`：Radix 弹窗内容在 happy-dom 下不挂载（实测：portal 容器
//     建立、内容为空；同批 skill 用例对 FormDialog / ConfirmDialog 做同样替换），替身透传 children，
//     被替换的是弹窗自身的呈现，不是本用例观察的失败态与重试接线。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { KNOWLEDGE_NS, knowledgeResources } from "../i18n";
import { registerReactI18nextStub } from "./react-i18next-stub";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

mock.module("@fenix/identity/web", () => ({
  // 组织角色必须写字面量：mock 工厂在模块求值期（早于本文件正文）执行，引用正文里的 const 会命中 TDZ。
  useOrg: () => ({ org: { id: "org-current", name: "本组织" }, role: "owner" }),
  useSession: () => ({ data: null }),
}));

/**
 * 路由并集替身里的 `Link`：渲染成可点的 `<a>`。
 * `params` / `search` 等参数化跳转属性不透传——本批用例只断言链接可点，不断言跳转目标。
 */
function RouterLink({ to, children, className }: { to?: string; children?: ReactNode; className?: string }) {
  return createElement("a", { href: to, className }, children);
}

/*
 * `@tanstack/react-router` 替身必须是**跨包并集**，不能只列本用例用到的出口：
 * bun 1.4.2 下 `mock.module` 的命名空间在被首个 import 解析后就固定下来，而 `bun test packages/`
 * 在单进程里跑完全部包——只登记 `useNavigate` / `useSearch` 时，之后加载的跨包组件（如 workflow 的
 * `WorkflowVersions`、task 的 `TasksPanel`）会在链接期抛
 * `SyntaxError: Export named 'Link' not found`，表现为整批用例 0.05ms 全红。
 * 并集口径 = 全仓库 packages 内真实出现过的路由出口（`useNavigate` / `useSearch` / `useLocation` /
 * `useParams` / `Link`）；后续文件注册同一份并集，因此谁先注册结果都一致。
 */
mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
  Link: RouterLink,
}));

mock.module("@fenix/ui-components/config/FormDialog", () => ({
  /** 同签名替身：打开时透传 children（表单字段与失败态照常渲染），关掉时什么都不渲染。 */
  FormDialog: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? children : null),
}));

mock.module("@fenix/ui-components/config/ConfirmDialog", () => ({
  ConfirmDialog: () => null,
}));

/**
 * 用例期望的文案全部取自本包字典；渲染走真实 i18next 实例并挂同一份字典，
 * 因此「字典已登记该键」与「该分支真的渲染了这句文案」被绑在一起。
 */
const TEXT = knowledgeResources.en;

/**
 * 渲染用的真实 i18next 实例：挂本包 en 字典，与断言取的是同一份资源。
 * `resources` 的形状必须是 `{ [语言]: { [命名空间]: 字典 } }`——少一层语言维度时 `t()` 会静默回退为
 * 回显 key（实测：写成 `{ [KNOWLEDGE_NS]: 字典 }` 时断言拿到的全是 key）。
 */
const i18n = createInstance();
void i18n.init({
  lng: "en",
  fallbackLng: "en",
  defaultNS: KNOWLEDGE_NS,
  initAsync: false,
  resources: { en: { [KNOWLEDGE_NS]: knowledgeResources.en } },
});

/** 被测页面统一包在 i18n provider 里渲染（页面内的 `useTranslation(NS.KNOWLEDGE)` 据此取字典）。 */
function withI18n(node: ReactElement): ReactElement {
  return createElement(I18nextProvider, { i18n }, node);
}

// `react-i18next` 替身：本包两个组件用例共用 `registerReactI18nextStub`（语义与理由见该文件），
// 必须在被测页面被 import 之前注册——`bun test packages/` 单进程里同批文件注册的是
// `t: (key) => key` 的替身，不自己注册就会拿到 key 回显。
registerReactI18nextStub(i18n);

const toastErrors: string[] = [];

// 替身给的是跨包并集（success / error / info / warning / message）：bun 1.4.2 下 `mock.module`
// 的命名空间会被同进程后续文件复用，只给本用例用到的两个方法会让之后加载的组件取到 undefined。
mock.module("sonner", () => ({
  toast: {
    error: (message: string) => {
      toastErrors.push(message);
    },
    success: () => {},
    info: () => {},
    warning: () => {},
    message: () => {},
  },
}));

afterEach(() => {
  mock.restore();
});

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = new Window({ url: "https://localhost:3000" });
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;
// Radix 组件（Select / Tabs 等）在挂载期读一批标准 DOM 全局，happy-dom 只把它们挂在 Window 实例上、
// 不会同步到 globalThis；`getComputedStyle` 是实例方法，必须绑定到该 Window。
// （同批 channel 用例同一处理：缺哪个就会在 commit 阶段抛 ReferenceError。）
const DOM_GLOBALS = [
  "HTMLElement",
  "HTMLDivElement",
  "HTMLInputElement",
  "HTMLTextAreaElement",
  "SVGElement",
  "Element",
  "Node",
  "Text",
  "DocumentFragment",
  "ShadowRoot",
  "DOMRect",
  "DOMTokenList",
  "CustomEvent",
  "Event",
  "KeyboardEvent",
  "MouseEvent",
  "FocusEvent",
  "InputEvent",
  "MutationObserver",
  "ResizeObserver",
];
for (const key of DOM_GLOBALS) {
  const value = (win as unknown as Record<string, unknown>)[key];
  if (value !== undefined) g[key] = value;
}
g.getComputedStyle = win.getComputedStyle.bind(win);

const { AgentKnowledgeBasesPage } = await import("../pages/agent-panel/pages/AgentKnowledgeBasesPage");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

const LIST_URL = "/web/knowledgeBases";
const FORM_OPTIONS_URL = "/web/knowledgeBases/form-options";

let formOptionsResponses: StubResponse[] = [];
let formOptionsCalls = 0;
let listCalls = 0;

function jsonResponse({ status, body }: StubResponse): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Map([["content-type", "application/json"]]),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    if (method === "GET" && url.startsWith(FORM_OPTIONS_URL)) {
      const next = formOptionsResponses[Math.min(formOptionsCalls, formOptionsResponses.length - 1)];
      formOptionsCalls += 1;
      return jsonResponse(next);
    }
    if (method === "GET" && url === LIST_URL) {
      listCalls += 1;
      // 列表为空：本用例只观察创建弹窗的选项分支，不牵扯选中详情与轮询
      return jsonResponse({ status: 200, body: { success: true, data: [] } });
    }
    throw new Error(`用例未登记的请求：${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 失败信封：后端业务错误走 200 + success:false，传输层错误走非 2xx。 */
function failure(code: string, message: string, status = 200): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

/** 401/403：request 层把它归一为 UNAUTHORIZED，页面据此走无权限态（不给重试）。 */
function unauthorized(status: number): StubResponse {
  return { status, body: { success: false, error: { code: "UNAUTHORIZED", message: `请求失败 (${status})` } } };
}

/** 选项拉取成功：三个列表给空数组即可，本用例只关心「配置区是否恢复成正常态」。 */
function formOptionsSuccess(): StubResponse {
  return {
    status: 200,
    body: { success: true, data: { embeddingModels: [], chunkMethods: [], pipelines: [] } },
  };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;
/** 失败路径会经过页面的 `console.error`；收集而不是打印，既保持输出可读，又能断言诊断上下文留痕。 */
const consoleErrorCalls: unknown[][] = [];
let restoreConsoleError: () => void;

beforeEach(() => {
  formOptionsResponses = [];
  formOptionsCalls = 0;
  listCalls = 0;
  toastErrors.length = 0;
  consoleErrorCalls.length = 0;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
  restoreConsoleError = () => {
    console.error = originalConsoleError;
  };
  restoreFetch = stubFetch();
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例的做法一次性收窄
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  restoreFetch();
  restoreConsoleError();
});

/** 渲染并等待 useRequest 的 promise 链与随后的 React 重渲染落定。 */
async function render(): Promise<void> {
  await act(async () => {
    root.render(withI18n(createElement(AgentKnowledgeBasesPage)));
  });
  await settle();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function text(): string {
  return container.textContent ?? "";
}

/** 按可见文案找按钮；找不到返回 undefined，正是「无权限态不给重试按钮」的断言依据。 */
function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  return;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await settle();
}

function alertRegions(): Element[] {
  return [...container.querySelectorAll('[role="alert"]')];
}

/** 打开创建弹窗：选项请求在页面挂载时已发出，弹窗打开后即可看到对应的失败或正常态。 */
async function openCreateDialog(): Promise<void> {
  await click(buttonByText(TEXT.btn.create) as HTMLButtonElement);
}

describe("知识库创建弹窗的表单选项失败态", () => {
  // 失败且无选项：配置区必须整区接管为可重试的持久错误态，而不是留下一个「没有可选模型」的空表单；
  // 重试要真的重新发起 getFormOptions，成功后退回正常配置区。
  test("选项加载失败整区接管并可重试，重试成功后恢复配置区", async () => {
    formOptionsResponses = [failure("SERVER_ERROR", "boom", 500), formOptionsSuccess()];
    await render();

    expect(formOptionsCalls).toBe(1);
    expect(listCalls).toBe(1);
    await openCreateDialog();

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.loadFailure.formOptions);
    expect(text()).toContain("boom");
    expect(text()).toContain(TEXT.loadFailure.hint);
    // 配置区文案必须让位（不是与错误态叠在一起）
    expect(text()).not.toContain(TEXT.form.configLockedAfterCreate);
    // 失败只落持久错误区，不再额外弹 toast：同一次失败报两遍会让用户以为连续挂了两回
    expect(toastErrors).toEqual([]);
    // 诊断上下文必须留痕（console.error），不能静默降级
    expect(consoleErrorCalls.length).toBeGreaterThan(0);

    await click(buttonByText(TEXT.actions.retry) as HTMLButtonElement);

    expect(formOptionsCalls).toBe(2);
    expect(alertRegions().length).toBe(0);
    expect(text()).toContain(TEXT.form.configLockedAfterCreate);
    // 重试只重取选项，不重取知识库列表
    expect(listCalls).toBe(1);
  });

  // 401/403：复用无权限态、不给重试按钮，同样不得渲染成「没有可选模型」的空表单。
  test("选项加载无权限时复用无权限态且不提供重试按钮", async () => {
    formOptionsResponses = [unauthorized(403)];
    await render();
    await openCreateDialog();

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.accessDenied.title);
    expect(text()).toContain(TEXT.accessDenied.description);
    expect(buttonByText(TEXT.actions.retry)).toBeUndefined();
    expect(text()).not.toContain(TEXT.form.configLockedAfterCreate);
  });
});
