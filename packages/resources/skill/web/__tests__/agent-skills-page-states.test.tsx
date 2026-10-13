// web/__tests__/agent-skills-page-states.test.tsx
// 技能页加载与写入状态的关键交互用例（§1.3(6) 的统一口径）：本包浏览器出口 `AgentSkillsPage` 的
// loading / error / retry / 无权限 / 成功反馈必须落在**可区分且可恢复**的界面上。
//
// 为什么用真实渲染而不是读源码断言：被钉住的行为是「失败请求不会退化成空态」「重试按钮真的重新发起
// 请求」「401/403 不给重试按钮」「更新/删除成功有可见反馈」——这些取决于 useRequest 的状态流转、
// 分支顺序与回调接线，源码里出现 `toast.success` 字样并不等于运行时走到了那一行。
//
// 环境：happy-dom + react-dom/client（与同批 prod-view / memory / workflow 的组件用例同款）。
// 跨包依赖只 mock 三类会把真实副作用带进用例的东西：
//   - `sonner`：toast 需要宿主 Toaster 订阅，这里只记录调用。
//   - `@fenix/ui-components` 的两个弹窗：Radix 弹窗内容在 happy-dom 下不挂载（实测：portal 容器
//     建立、内容为空），因此用同签名替身驱动「确认删除 / 提交表单」这两条数据流——被替换的是弹窗
//     自身的呈现，不是本用例观察的 toast 与列表刷新接线。
//   - `react-i18next`：与同批已过验的 prod-view / workflow 用例同款——模块作用域提供替身，并在
//     afterEach 调 `mock.restore()`。**不得**依赖真实实例：bun 1.4.2 下 `mock.module` 会跨文件残留
//     （`packages/agent-runtime/web/__tests__/file-picker-panel.test.tsx` 在模块作用域注册了
//     `t: (key) => key`、`I18nextProvider` 直通的 react-i18next 替身），同进程后续文件拿到的是替身
//     而不是真实实例，症状就是断言里直接出现 i18n key 回显、按文案取不到按钮。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const toastSuccessCalls: string[] = [];
const toastErrorCalls: string[] = [];

// 替身给的是跨包并集（success / error / info / warning / message）：bun 1.4.2 下 `mock.module`
// 的命名空间会被同进程后续文件复用，只给本用例用到的两个方法会让之后加载的组件取到 undefined。
mock.module("sonner", () => ({
  toast: {
    success: (message: string) => {
      toastSuccessCalls.push(message);
    },
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
    info: () => {},
    warning: () => {},
    message: () => {},
  },
}));

/**
 * 替身翻译表：只列断言用到的键，其余回显 key 便于定位漏登记的键。
 *
 * 取值必须与本包 en 字典（下方 `TEXT`）逐字一致：断言拿 `TEXT` 做期望、替身表出实际文案，两者不一致
 * 会立刻失败——因此这张表不是「另抄一份文案」，而是把「键已登记」和「分支真的渲染了这句文案」两件事
 * 绑在一起。字典本身的完整性（en/zh 键集与插值对齐）由 `skill-i18n.test.ts` 静态守护。
 */
const MOCK_TRANSLATIONS: Record<string, string> = {
  empty: "Your skill library is empty",
  "accessDenied.title": "No permission to view skills",
  "accessDenied.description":
    "Your account is not allowed to view this organization's skill library. Sign in with an account that has access, or ask your organization administrator to grant it.",
  "loadState.title": "Could not load skills",
  "loadState.retry": "Try again",
  "btn.edit": "Edit",
  "btn.delete": "Delete",
  "btn.createSkill": "Add Skill",
  "toast.skillUpdated": "Skill updated",
  "toast.skillDeleted": "Skill deleted",
};

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
  // 替身下不再有 Provider 语义（组件直接从替身取 `t`），导出直通版本只为保持模块面完整。
  I18nextProvider: ({ children }: { children?: ReactNode }) => children,
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      let result = MOCK_TRANSLATIONS[key] ?? key;
      for (const [name, value] of Object.entries(opts ?? {})) {
        result = result.replace(`{{${name}}}`, String(value));
      }
      return result;
    },
  }),
}));

afterEach(() => {
  mock.restore();
});

import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { OrgSessionProvider } from "@fenix/web-runtime/contexts/org-session";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { skillResources } from "../i18n";
import { AgentSkillsPage } from "../pages/agent-panel/pages/AgentSkillsPage";
import type { SkillInfo } from "../pages/agent-panel/pages/agent-skills-types";

const dialogProbe = (label: string, onClick: () => void) =>
  createElement("button", { type: "button", "data-testid": label, onClick }, label);

mock.module("@fenix/ui-components/config/ConfirmDialog", () => ({
  /** 同签名替身：打开时渲染一个可点击的确认按钮，把 `onConfirm` 这条接线暴露出来。 */
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open ? dialogProbe("confirm-dialog", onConfirm) : null,
}));

mock.module("@fenix/ui-components/config/FormDialog", () => ({
  /** 同签名替身：透传 children（表单字段与校验分支照常渲染），并暴露 `onSubmit`。 */
  FormDialog: ({ open, onSubmit, children }: { open: boolean; onSubmit?: () => void; children?: ReactNode }) =>
    open
      ? createElement(
          "div",
          null,
          children,
          dialogProbe("form-dialog-submit", () => onSubmit?.()),
        )
      : null,
}));

/**
 * 用例期望的文案全部取自本包字典：字典改了用例跟着改，不会出现「界面换了文案、断言还是旧的」。
 * 期望值与替身表 `MOCK_TRANSLATIONS` 必须一致，否则断言立刻失败。
 */
const TEXT = skillResources.en;

/** 本组织私有技能，带 update 动作（决定详情页的下载 / 公开开关 / 删除入口是否出现）。 */
const skill: SkillInfo = {
  id: "skill-1",
  name: "deploy-helper",
  description: "部署辅助",
  scope: { organizationId: "org-current", visibility: "private" },
  access: { actions: ["read", "update"] },
};

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = initializeHappyDomWindow(new Window());
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

/** 每次请求都交给 handler 决定响应；用例据此表达「第一次失败、第二次成功」这类序列。 */
let handler: (url: string, init?: RequestInit) => StubResponse | Promise<StubResponse>;
/** 列表请求次数（重试/写入后是否真的重新发起请求，只能靠它证明）。 */
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

/** `/web/*` 的失败信封：真实后端恒为 `{ success: false, error: { code, message } }`。 */
function failure(code: string, message: string, status: number): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

function listSuccess(skills: SkillInfo[]): StubResponse {
  return { status: 200, body: { success: true, data: { skills } } };
}

/** 技能详情：更新表单的初值来自它，content 必须非空否则表单校验会先拦下提交。 */
function detailSuccess(): StubResponse {
  return {
    status: 200,
    body: { success: true, data: { name: skill.name, description: skill.description, content: "# deploy-helper" } },
  };
}

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url === "/web/config/skills" && (init?.method ?? "GET") === "GET") listCalls += 1;
    return jsonResponse(await handler(url, init));
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;
/** 失败用例会经过页面的 `console.error`；这里收集而不是打印，既保持输出可读，又能断言「错误没被吞掉」。 */
const consoleErrorCalls: unknown[][] = [];
let restoreConsoleError: () => void;

beforeEach(() => {
  listCalls = 0;
  toastSuccessCalls.length = 0;
  toastErrorCalls.length = 0;
  consoleErrorCalls.length = 0;
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrorCalls.push(args);
  };
  restoreConsoleError = () => {
    console.error = originalConsoleError;
  };
  restoreFetch = stubFetch();
  // 详情请求与写入请求在本用例里默认成功；列表端点由各用例覆盖。
  handler = (url) => (url === "/web/config/skills" ? listSuccess([skill]) : detailSuccess());
  // happy-dom 自建 Window 的元素类型与全局 DOM 类型不同源，按同批用例的做法一次性收窄
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  restoreFetch();
  restoreConsoleError();
});

/**
 * 组织/会话上下文改为挂**真实** `OrgSessionProvider`（§1.6 T7）：页面现在经
 * `@fenix/web-runtime/contexts/org-session` 取组织 id，该契约是纯 React context、包内可直接解析，
 * 因此不再需要 mock 平台实现（`@fenix/identity/web`）——那条替身同时是 `special-dependency` 台账里
 * 最后一批资源包站点的镜像，随本任务的台账削减一并退场。
 * 取值与旧替身等价：`organizationId` 与 `skill.scope.organizationId` 一致（否则本组织技能会被判成共享
 * 来源），`isOwner` 对应旧的 `role: "owner"`，`userId` 对应旧的 `useSession()` 空会话。
 */
const ORG_SESSION = { organizationId: "org-current", userId: null, isOwner: true, pending: false };

/** 渲染并等待 useRequest 的 promise 链与随后的 React 重渲染落定。 */
async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(OrgSessionProvider, { value: ORG_SESSION }, createElement(AgentSkillsPage)));
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

/** 按可见文本找按钮；找不到返回 undefined，便于断言「这个按钮不该存在」。 */
function buttonByText(label: string): HTMLButtonElement | undefined {
  for (const button of container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as HTMLButtonElement;
  }
  return;
}

/** 按 data-testid 找弹窗替身暴露的按钮。 */
function buttonByTestId(testId: string): HTMLButtonElement | undefined {
  return (container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement | null) ?? undefined;
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click();
  });
  await settle();
}

function alertRegion(): Element | null {
  return container.querySelector('[role="alert"]');
}

describe("AgentSkillsPage 列表加载状态", () => {
  // 加载失败必须落在持久错误分支：既要有可读的失败原因，又不能退化成「技能库为空」把用户引向创建。
  test("加载失败落在持久错误分支而不是空态，且重试真的重新发起请求", async () => {
    handler = (url) =>
      url === "/web/config/skills" && listCalls === 1 ? failure("SERVER_ERROR", "boom", 500) : listSuccess([skill]);

    await render();

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain(TEXT.loadState.title);
    expect(text()).toContain("boom");
    expect(text()).not.toContain(TEXT.empty);
    // 失败必须留下诊断上下文：页面经由 console.error 记录，不能只把错误吞进空态。
    expect(consoleErrorCalls.length).toBeGreaterThan(0);

    const retry = buttonByText(TEXT.loadState.retry);
    expect(retry).toBeDefined();
    await click(retry as HTMLButtonElement);

    expect(listCalls).toBe(2);
    expect(text()).toContain(skill.name);
    expect(alertRegion()).toBeNull();
  });

  // 403 走无权限分支：本包后端把授权拒绝映射为 `FORBIDDEN`，只认 `UNAUTHORIZED` 会漏掉它。
  test("403 FORBIDDEN 走无权限分支，且不给无意义的重试按钮", async () => {
    handler = () => failure("FORBIDDEN", "当前主体无权查看该资源", 403);

    await render();

    expect(alertRegion()).not.toBeNull();
    expect(text()).toContain(TEXT.accessDenied.title);
    expect(text()).toContain(TEXT.accessDenied.description);
    expect(buttonByText(TEXT.loadState.retry)).toBeUndefined();
    // 无权限时不渲染目录，也不显示创建/导入入口（点了同样会被拒）
    expect(buttonByText(TEXT.btn.createSkill)).toBeUndefined();
  });

  // 401 是同一分支的另一个来源（request 层对无 code 的 401/403 归一为 UNAUTHORIZED）。
  test("401 UNAUTHORIZED 走同一无权限分支", async () => {
    handler = () => failure("UNAUTHORIZED", "请求缺少组织上下文", 401);

    await render();

    expect(text()).toContain(TEXT.accessDenied.title);
    expect(buttonByText(TEXT.loadState.retry)).toBeUndefined();
  });

  // 骨架态要带 `aria-busy`，加载完成后不能常驻：常驻会让读屏用户把已完成的页面当成持续更新中的区域。
  test("加载中带 aria-busy，加载完成后不再常驻", async () => {
    let releaseList!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseList = resolve;
    });
    handler = async (url) => {
      if (url === "/web/config/skills") {
        await gate;
        return listSuccess([skill]);
      }
      return detailSuccess();
    };

    // 本用例要看「fetch 还没落定」的那一帧，因此不走 `render()` 的等待链，Provider 需自行包上。
    await act(async () => {
      root.render(createElement(OrgSessionProvider, { value: ORG_SESSION }, createElement(AgentSkillsPage)));
    });

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await act(async () => {
      releaseList();
    });
    await settle();

    expect(text()).toContain(skill.name);
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("AgentSkillsPage 写入反馈", () => {
  // 更新成功后必须有可见反馈，否则用户只能从「对话框关了」推断保存是否生效。
  test("更新成功后给出 toast 反馈并刷新列表", async () => {
    const methods: string[] = [];
    handler = (url, init) => {
      if (url === "/web/config/skills") return listSuccess([skill]);
      methods.push(init?.method ?? "GET");
      return detailSuccess();
    };

    await render();
    const listCallsBeforeSave = listCalls;
    await click(buttonByText(TEXT.btn.edit) as HTMLButtonElement);

    const submit = buttonByTestId("form-dialog-submit");
    expect(submit).toBeDefined();
    await click(submit as HTMLButtonElement);

    expect(methods).toContain("PUT");
    expect(toastSuccessCalls).toContain(TEXT.toast.skillUpdated);
    expect(listCalls).toBe(listCallsBeforeSave + 1);
  });

  // 删除是不可逆操作：成功后必须有可见反馈，否则用户只能从「列表少了一条」猜结果。
  test("删除成功后给出 toast 反馈并刷新列表", async () => {
    const methods: string[] = [];
    handler = (url, init) => {
      if (url === "/web/config/skills") return listSuccess([skill]);
      const method = init?.method ?? "GET";
      methods.push(method);
      return method === "DELETE" ? { status: 200, body: { success: true, data: null } } : detailSuccess();
    };

    await render();
    const listCallsBeforeDelete = listCalls;
    await click(buttonByText(TEXT.btn.delete) as HTMLButtonElement);

    const confirm = buttonByTestId("confirm-dialog");
    expect(confirm).toBeDefined();
    await click(confirm as HTMLButtonElement);

    expect(methods).toContain("DELETE");
    expect(toastSuccessCalls).toContain(TEXT.toast.skillDeleted);
    expect(listCalls).toBe(listCallsBeforeDelete + 1);
  });
});
