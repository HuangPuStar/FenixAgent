// web/__tests__/mcp-page-states.test.tsx
// MCP 目录与详情弹窗的加载状态渲染用例（§1.3(6) 的统一口径）：目录的加载失败 / 无权限，以及
// 编辑器弹窗的详情读取失败，必须落在**可区分且可恢复**的界面上，而不是静默停在空态或空表单上。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为是「详情读不到时窗口不会把空表单当已加载」
// 「提交在修好前不可用」「点重试真的重新拉取并恢复表单」「401/403 不给重试按钮」——这些取决于
// effect 的状态流转（`reloadKey` 自增重触发、`detailError` 参与 `hideSubmit`）与分支顺序，
// 源码里出现 `setDetailError` 或 `role="alert"` 字样并不等于运行时走到了那一行。
//
// 环境：happy-dom + react-dom/client（与同批 prod-view / skill / workflow 的组件用例同款）。
// 跨包依赖只 mock 三类会把真实副作用或不可运行实现带进用例的东西：
//   - `@fenix/identity/web`：其组织上下文依赖宿主别名（`@/src/api/request`），包内测试无法解析；
//     本用例只需要一个当前组织 id 用来判定资源归属。
//   - `react-i18next`：**必须自己注册替身**。bun 1.4.2 的 `mock.module` 会跨文件残留，同进程里已有
//     文件注册过 `t: (key) => key` 的替身，不注册就会被它顶掉、断言里出现 i18n key 回显。
//     替身里的 `t` 必须是**模块级稳定引用**：弹窗的详情加载 effect 把 `t` 写进了依赖数组，
//     每次渲染换一个新的 `t` 会让 effect 反复重跑（实测后端请求会打满 5s 超时）。
//   - `sonner`：toast 需要宿主 Toaster 订阅，本用例不观察它。
//   - `@fenix/ui-components/config/FormDialog`：真实组件是 Radix Dialog，而 `bun test packages/` 单进程里
//     更早的文件已经用最小替身注册过它（bun 1.4.2 的替换是进程级、且真实组件需要 portal 才能挂载），
//     本文件自带同签名替身，`hideSubmit` 与按钮文案的口径见声明处注释。
// Radix 弹窗/下拉在 happy-dom 下还需要把 DOM 构造器与 rAF 挂在 globalThis 上——React 与 Radix 读
// 全局而不是 `window.*`，缺失会直接在 effect 里抛 `ReferenceError`；这些注入在 afterAll 还原，
// 避免污染同进程的其它测试文件。

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = new Window();
const globals = globalThis as Record<string, unknown>;
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;

/**
 * happy-dom 提供的 DOM 构造器与全局函数，按需注入到 globalThis 并在 afterAll 还原。
 *
 * 名单是实测得出的最小集：Radix 的 Dialog / DismissableLayer / FocusScope / Select 分别用到
 * `MutationObserver`、`DocumentFragment`、`NodeFilter`、`CustomEvent` 与 HTML* 元素的 `instanceof`
 * 判断；`requestAnimationFrame` 与 `getComputedStyle` 只存在于 Window 原型上，需要显式绑定。
 */
const DOM_GLOBALS = [
  "CustomEvent",
  "DOMRect",
  "DocumentFragment",
  "Element",
  "Event",
  "EventTarget",
  "FocusEvent",
  "HTMLElement",
  "HTMLAnchorElement",
  "HTMLButtonElement",
  "HTMLFormElement",
  "HTMLInputElement",
  "HTMLLabelElement",
  "HTMLSelectElement",
  "HTMLTextAreaElement",
  "InputEvent",
  "KeyboardEvent",
  "MouseEvent",
  "MutationObserver",
  "Node",
  "NodeFilter",
  "PointerEvent",
  "ResizeObserver",
  "SVGElement",
] as const;

const originalGlobals = new Map<string, unknown>([
  ...DOM_GLOBALS.map((key) => [key, globals[key]] as const),
  ["requestAnimationFrame", globals.requestAnimationFrame],
  ["cancelAnimationFrame", globals.cancelAnimationFrame],
  ["getComputedStyle", globals.getComputedStyle],
  ["addEventListener", globals.addEventListener],
  ["removeEventListener", globals.removeEventListener],
]);

for (const key of DOM_GLOBALS) {
  globals[key] = (win as unknown as Record<string, unknown>)[key];
}
globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
globals.getComputedStyle = win.getComputedStyle.bind(win);
globals.addEventListener = win.addEventListener.bind(win);
globals.removeEventListener = win.removeEventListener.bind(win);

/** 用例断言到的键，按实际文案取值；未登记的键回显自身，便于快速发现漏登记的断言目标。 */
const MOCK_TRANSLATIONS: Record<string, string> = {
  empty: "暂无 MCP 插件",
  emptyHint: "点击「新建服务器」创建第一个 MCP 插件",
  emptySearch: "没有匹配的 MCP 插件",
  emptySearchHint: "换个关键词或切换筛选范围",
  "formDialog.save": "保存",
  "formDialog.cancel": "取消",
  "loadState.retry": "重试",
  "loadState.title": "无法加载插件目录",
  "loadState.unauthorizedTitle": "无权查看插件目录",
  "loadState.unauthorizedHint": "当前账号或所属组织已无权访问 MCP 插件，重试不会改变结果。",
  "dialog.editTitle": "编辑 MCP 服务器",
  "dialog.loadDetailFailed": "无法读取该服务器的配置",
  "dialog.loadDetailFailedHint": "现在保存只会再报一次校验错误，请重试或关闭后重新打开。",
};

/**
 * 翻译替身。必须是模块级稳定引用——弹窗的加载 effect 把 `t` 写进依赖数组，不稳定会让它反复重跑。
 * 插值按 `{{var}}` 还原，与真实 i18next 口径一致。
 */
function translate(key: string, opts?: Record<string, unknown>): string {
  let result = MOCK_TRANSLATIONS[key] ?? key;
  for (const [name, value] of Object.entries(opts ?? {})) {
    result = result.replace(`{{${name}}}`, String(value));
  }
  return result;
}

/**
 * `react-i18next` 替身的跨包并集出口：`useTranslation` 由本文件自带翻译表，
 * 其余出口给同签名直通版本——bun 1.4.2 下 `mock.module` 的命名空间会被同进程后续文件复用，
 * 缺少 `I18nextProvider` 会让之后加载的组件（如 identity 的弹窗）在渲染期直接抛错。
 */
const REACT_I18NEXT_UNION = {
  I18nextProvider: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children,
};

mock.module("react-i18next", () => ({
  ...REACT_I18NEXT_UNION,
  useTranslation: () => ({ t: translate }),
}));

// 替身给的是跨包并集（success / error / info / warning / message）：bun 1.4.2 下 `mock.module`
// 的命名空间会被同进程后续文件复用，只给本用例用到的三个方法会让之后加载的组件取到 undefined。
mock.module("sonner", () => ({
  toast: { error: () => {}, success: () => {}, info: () => {}, warning: () => {}, message: () => {} },
}));

// 替身给的是跨包并集：`useOrg` 供本用例判归属，`useSession` 是 knowledge 页面的出口——
// bun 1.4.2 下命名空间会被同进程后续文件复用，缺出口会在链接期抛 `Export named 'useSession' not found`。
mock.module("@fenix/identity/web", () => ({
  // 组织 id 必须写字面量：mock 工厂在模块求值期执行，引用正文里的 const 会命中 TDZ。
  useOrg: () => ({ org: { id: "org-current", name: "本组织" }, role: "owner" }),
  useSession: () => ({ data: null }),
}));

/**
 * `@fenix/ui-components/config/FormDialog` 的同签名替身（跨文件污染的**收口点**，不只是文案替身）。
 *
 * 真实组件是 Radix Dialog，其呈现依赖 portal 与全局 DOM；`bun test packages/` 单进程跑完所有包，
 * 同进程里更早加载的文件（skill / knowledge 的弹窗用例）已经用「打开时透传 children，关掉时返回 null」
 * 之类的最小替身注册过这个模块——bun 1.4.2 的 `mock.module` 替换是**进程级**的，本文件页面在测试期
 * import 它时拿到的就是那份替身：实测弹窗内容整块消失，`role="alert"` 与提交按钮都断言不到。
 * 反向委托给真实组件同样不可行：真实组件的 `useTranslation` 绑定在**首次被求值**的那一刻，
 * 同进程里 `packages/ui-components` 的 barrel 用例会先用真实 `react-i18next`（含 demo 初始化好的
 * 真实字典）求值它，此后本文件的翻译替身对它无效，按钮会渲染成真实字典里的英文。
 * 因此替身**自带呈现**且口径与真实组件一致：打开时渲染标题、children 与取消/提交两个按钮；
 * 提交按钮在 `hideSubmit` 为真时不可达（正是本用例的关键回归点）、标签优先用调用方传入的
 * `submitLabel`，否则回落到本文件的翻译表。被替换的只是 Radix 外壳，失败态、重试接线与提交入口
 * 可达性仍由页面真实逻辑决定。
 */
interface FormDialogStubProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children?: ReactNode;
  onSubmit?: () => void;
  submitLabel?: string;
  cancelLabel?: string;
  loading?: boolean;
  disabled?: boolean;
  hideSubmit?: boolean;
}

mock.module("@fenix/ui-components/config/FormDialog", () => ({
  FormDialog: ({
    open,
    onOpenChange,
    title,
    children,
    onSubmit,
    submitLabel,
    cancelLabel,
    loading,
    disabled,
    hideSubmit,
  }: FormDialogStubProps) =>
    open
      ? createElement(
          "div",
          { role: "dialog" },
          createElement("h2", null, title),
          createElement(
            "form",
            {
              onSubmit: (event: { preventDefault: () => void }) => {
                event.preventDefault();
                onSubmit?.();
              },
            },
            createElement("div", null, children),
            createElement(
              "button",
              { type: "button", onClick: () => onOpenChange(false) },
              cancelLabel ?? translate("formDialog.cancel"),
            ),
            hideSubmit
              ? null
              : createElement(
                  "button",
                  { type: "submit", disabled: loading || disabled },
                  loading ? translate("formDialog.saving") : (submitLabel ?? translate("formDialog.save")),
                ),
          ),
        )
      : null,
}));

afterEach(() => {
  mock.restore();
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

import type { McpServerInfo } from "@fenix/web-runtime/types/config";

const ACTIVE_ORG_ID = "org-current";

/**
 * 被测组件一律**动态导入**：React DOM 与 Radix 在模块求值期就会读取 `document` 与 DOM 构造器，
 * 而静态 `import` 会被提升到本文件正文（DOM 注入）之前求值——实测表现为弹窗 portal 挂不上去、
 * body 里只剩挂载容器。同批的 workflow 用例同样是动态导入组件。
 */
async function importMcpPage() {
  return (await import("../pages/agent-panel/pages/AgentMcpPage")).AgentMcpPage;
}

async function importMcpDialog() {
  return (await import("../pages/agent-panel/pages/agent-mcp-dialog")).AgentMcpDialog;
}

// ── fetch 桩：唯一的外部数据源，按队列依次给出响应，便于断言「重试是否真的又发了一次请求」 ──
type StubResponse = { status: number; body: unknown };

let responses: StubResponse[] = [];
let fetchCalls: string[] = [];
let restoreFetch: (() => void) | null = null;

function stubFetch(): void {
  const original = globalThis.fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(typeof input === "string" ? input : input.toString());
    // 队列耗尽后复用最后一条，避免断言之外的附带请求把用例拖进「无响应」状态
    const next = responses[Math.min(fetchCalls.length - 1, responses.length - 1)];
    return jsonResponse(next);
  }) as typeof fetch;
}

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

/** `/web` 列表信封：servers 为空即目录空态。 */
function listSuccess(servers: McpServerInfo[]): StubResponse {
  return { status: 200, body: { success: true, data: { servers } } };
}

/** 本组织私有、带 update 动作的 MCP：`canWriteMcp` 为真，因此弹窗初始不是只读态。 */
const writableServer: McpServerInfo = {
  id: "mcp-1",
  name: "shared",
  type: "remote",
  enabled: true,
  summary: "共享 MCP",
  scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
  access: { actions: ["read", "update"] },
};

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  responses = [];
  fetchCalls = [];
  stubFetch();
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例（workflow）的做法一次性收窄
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
});

afterEach(async () => {
  act(() => {
    root.unmount();
  });
  // Radix 的 FocusScope 在卸载时用 `setTimeout(…, 0)` 延迟派发 AUTOFOCUS_ON_UNMOUNT，DismissableLayer
  // 也有同类的延迟清理。不在这里把这几拍跑完，它们会落在 afterAll 还原 DOM 全局之后，用宿主 Event
  // 构造器去 dispatch 一个 happy-dom 事件，抛出的 TypeError 会变成「测试之间的未处理错误」并中断
  // 后续测试文件（实测：整包 20 个文件只剩 268 条用例、round47 直接加载失败）。
  for (let i = 0; i < 2; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  win.document.body.replaceChildren();
  restoreFetch?.();
  restoreFetch = null;
});

/** 渲染并等待请求链（fetch → unwrap → setState）与随后的 React 重渲染落定。 */
async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    root.render(node);
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 弹窗经 Radix portal 渲染到 document.body，因此断言一律读 body 而不是挂载容器。 */
function text(): string {
  return win.document.body.textContent ?? "";
}

function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of win.document.body.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  return;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function alertRegion(): Element | null {
  return win.document.body.querySelector('[role="alert"]');
}

describe("AgentMcpPage 目录加载状态", () => {
  // 目录加载失败必须落在持久错误分支（role="alert" + 可点重试），不能退化成「暂无 MCP 插件」空态——
  // 空态会让用户以为组织里真的没有资源，而不是请求失败。
  test("目录加载失败渲染错误分支而不是空态，且重试真的重新发起请求", async () => {
    responses = [
      { status: 500, body: { success: false, error: { code: "SERVER_ERROR", message: "服务器内部错误" } } },
      listSuccess([writableServer]),
    ];
    const AgentMcpPage = await importMcpPage();
    await render(createElement(AgentMcpPage));

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain("无法加载插件目录");
    expect(text()).toContain("服务器内部错误");
    expect(text()).not.toContain("暂无 MCP 插件");

    const retry = buttonByText("重试");
    expect(retry).toBeDefined();
    await click(retry as HTMLButtonElement);

    // 重试后：第二次响应成功，目录渲染出资源，错误分支消失
    expect(fetchCalls.length).toBe(2);
    expect(text()).toContain("shared");
    expect(alertRegion()).toBeNull();
  });

  // 401/403 归一为 UNAUTHORIZED 后单列无权限分支：说明原因但不给重试按钮——重试一个被永久拒绝的
  // 请求只会让用户以为「再点点就好了」。
  test("目录 403 走无权限分支且不给重试按钮", async () => {
    responses = [{ status: 403, body: { success: false, error: { message: "请求缺少组织上下文" } } }];
    const AgentMcpPage = await importMcpPage();
    await render(createElement(AgentMcpPage));

    expect(text()).toContain("无权查看插件目录");
    expect(text()).toContain("重试不会改变结果");
    expect(buttonByText("重试")).toBeUndefined();
    expect(text()).not.toContain("暂无 MCP 插件");
  });
});

describe("AgentMcpDialog 详情加载状态", () => {
  // 详情读不到时必须进入持久错误态：给出说明与重试，并在修好前收起提交入口。
  // 否则窗口停在空表单上，用户点保存只会再收到一条「名称必填」。
  test("详情加载失败渲染持久错误提示并在修复前收起提交按钮", async () => {
    responses = [{ status: 500, body: { success: false, error: { code: "SERVER_ERROR", message: "boom" } } }];
    const AgentMcpDialog = await importMcpDialog();
    await render(createElement(AgentMcpDialog, { target: writableServer, onClose: () => {}, onSaved: () => {} }));

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain("无法读取该服务器的配置");
    expect(text()).toContain("现在保存只会再报一次校验错误");
    // 关键回归点：`hideSubmit` 由 `detailError` 参与决定，错误期提交入口必须不可达
    expect(buttonByText("保存")).toBeUndefined();
    // 错误态仍给出重试入口（与目录的 403 分支区别所在）
    expect(buttonByText("重试")).toBeDefined();
  });

  // 重试必须真的重新拉取详情并恢复表单：只断言按钮存在无法发现「按钮接到错误回调」。
  test("点重试重新拉取详情，成功后错误消失并恢复可提交表单", async () => {
    responses = [
      { status: 500, body: { success: false, error: { code: "SERVER_ERROR", message: "boom" } } },
      {
        status: 200,
        body: {
          success: true,
          data: {
            name: "shared",
            scope: { organizationId: ACTIVE_ORG_ID, visibility: "private" },
            access: { actions: ["read", "update"] },
            config: { type: "remote", url: "https://example.com/mcp" },
          },
        },
      },
    ];
    const AgentMcpDialog = await importMcpDialog();
    await render(createElement(AgentMcpDialog, { target: writableServer, onClose: () => {}, onSaved: () => {} }));

    const retry = buttonByText("重试");
    expect(retry).toBeDefined();
    await click(retry as HTMLButtonElement);

    // 第二次详情响应成功：错误分支消失、表单按返回值回填、提交入口恢复
    expect(fetchCalls.length).toBe(2);
    expect(alertRegion()).toBeNull();
    expect(buttonByText("保存")).toBeDefined();
    const nameField = [...win.document.body.querySelectorAll("input")].find(
      (input) => (input as unknown as HTMLInputElement).value === "shared",
    );
    expect(nameField).toBeDefined();
  });
});
