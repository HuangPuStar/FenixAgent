// 定时任务侧栏面板（TasksPanel）列表滚动容器的高度约束守卫。
//
// 覆盖的用户报告：「ArtifactsPanel 切到 Tasks 模式后，任务一多就滚不动、也看不到滚动条」
// （同一成因已在 Chat 侧栏会话列表上复现并修复）。
// 根因：任务列表的 ScrollArea 根是列向 flex 的子项（`flex-1`），此前缺 `min-h-0`，
// CSS 的自动最小尺寸（`min-height: auto`）会把它撑到**整个列表的内容高度**，视口于是与内容等高、
// 永远没有可滚动溢出，而外层 `overflow-hidden` 只是把超出部分裁掉。
//
// 为什么在这里只断言类约定：happy-dom 没有排版引擎，无法断言「视口 clientHeight < scrollHeight」。
// 真实滚动行为由仓库外的 headless Chrome 工装量测（读数见交付报告）：
// 修复前——可用高 437.5px、40 条任务时 ScrollArea 根高 2460px，视口 clientHeight == scrollHeight == 2460，
// 滚轮与 `scrollTop` 赋值均无效、Radix 滑块不挂载；修复后——根 410.5px，视口 411:2460，
// 滚轮 0→300、程序化 0→2049、hover 后滑块挂载且可拖。
// 本文件守住的是让它成立的唯一前置条件 —— 该 flex 子项不得依赖 `min-height: auto`。
//
// 装配沿用同目录 `task-list-states.test.tsx`（真实组件 + happy-dom + fetch 桩）：跨包依赖不 mock，
// 只换掉会把副作用或上下文依赖带进用例的三处 —— `react-i18next` / `sonner` / `@tanstack/react-router`
// （面板顶部的 `<Link>` 需要路由上下文）。替身取**跨包并集**而非本用例用到的子集，理由见那些文件的说明。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// 最小 DOM：react-dom/client 在模块加载期就需要 window / document / navigator
const win = new Window();
const g = globalThis as Record<string, unknown>;
g.window = win;
g.document = win.document;
g.navigator = win.navigator;

mock.module("react-i18next", () => ({
  I18nextProvider: ({ children }: { children?: unknown }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
  Trans: ({ children }: { children?: unknown }) => children,
  // 用例只断言类约定，文案回显 key 即可
  useTranslation: () => ({ t: (key: string) => key }),
}));

mock.module("sonner", () => ({
  toast: { error: () => {}, success: () => {}, info: () => {}, warning: () => {}, message: () => {} },
}));

function RouterLink({ to, children, className }: { to?: string; children?: ReactNode; className?: string }) {
  return createElement("a", { href: to, className }, children);
}

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => () => {},
  useSearch: () => ({}),
  useLocation: () => ({ pathname: "/", search: "", hash: "", state: null, key: "default" }),
  useParams: () => ({}),
  Link: RouterLink,
}));

afterEach(() => {
  mock.restore();
});

const { TasksPanel } = await import("../pages/agent-panel/TasksPanel");

/** 造出「条数多于面板可用高度」的列表：数量本身不影响本文件的类约定断言，只用于贴近真实场景。 */
function createTasks(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    id: `task-${index}`,
    name: `定时任务 ${index}`,
    description: null,
    cron: "*/5 * * * *",
    timezone: null,
    enabled: index % 3 !== 0,
    timeoutSeconds: 300,
    agentId: null,
    type: "http" as const,
    definition: { url: "https://example.com/hook", method: "POST" as const },
    lastRunAt: null,
    nextRunAt: null,
    lastStatus: "success",
    createdAt: 1767225600,
    updatedAt: 1767225600,
  }));
}

let itemCount = 40;
let restoreFetch: () => void;

function stubFetch(): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = url.startsWith("/web/config/agents")
      ? { success: true, data: { agents: [] } }
      : { success: true, data: { items: createTasks(itemCount), total: itemCount, page: 1, pageSize: 50 } };
    return {
      ok: true,
      status: 200,
      statusText: "200",
      headers: new Map([["content-type", "application/json"]]),
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  restoreFetch = stubFetch();
  container = win.document.createElement("div") as unknown as HTMLElement;
  // happy-dom 的 appendChild 要求同源 Node 类型（与 DOM lib 的 Node 声明不同名）
  win.document.body.appendChild(container as unknown as Parameters<typeof win.document.body.appendChild>[0]);
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
});

/** 渲染面板并等待 useRequest 的 promise 链与随后的重渲染落定。 */
async function renderPanel(): Promise<void> {
  await act(async () => {
    root.render(createElement(TasksPanel, { agentId: "agent-1" }));
  });
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** 取任务列表所在的滚动容器（面板内唯一的 ScrollArea 根）。 */
function findScrollArea(): HTMLElement | null {
  return container.querySelector('[data-slot="scroll-area"]') as HTMLElement | null;
}

describe("TasksPanel 列表滚动容器", () => {
  // 条数远超面板高度时，滚动容器必须带 min-h-0，否则会被内容撑高、丧失滚动能力
  test("任务列表的 ScrollArea 根带 min-h-0（不依赖 min-height: auto）", async () => {
    itemCount = 40;
    await renderPanel();
    const scrollArea = findScrollArea();
    expect(scrollArea).not.toBeNull();
    expect(scrollArea?.classList.contains("min-h-0")).toBe(true);
    // 顺带确认它确实还是那个「撑满剩余高度」的 flex 子项，避免断言落在一个换了语义的元素上。
    expect(scrollArea?.classList.contains("flex-1")).toBe(true);
  });

  // 条数少（不需要滚动）时同样成立：约束与列表长度无关，避免只做得住「无滚动条」那半段
  test("任务条数少时同一条约束仍在（与列表长度无关）", async () => {
    itemCount = 2;
    await renderPanel();
    expect(findScrollArea()?.classList.contains("min-h-0")).toBe(true);
  });
});
