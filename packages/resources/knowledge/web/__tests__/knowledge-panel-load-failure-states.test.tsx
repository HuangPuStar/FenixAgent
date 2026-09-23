// web/__tests__/knowledge-panel-load-failure-states.test.tsx
// 知识库两个数据区（切片列表、检索结果）失败时的**持久态与重试**（任务 1.3 §1.3(6) 收口缺口）。
//
// 三条行为只存在于运行时的状态流转里，读源码断言不到：
//   1. 失败后不得落回「暂无数据」空态（`chunk.empty` / `retrieval.noResults`）——这正是本次缺口：
//      失败只弹了 toast，界面照样渲染空态，用户会把「请求挂了」读成「确实没有数据」；
//   2. 失败区带 `role="alert"`，重试按钮必须重新发起**原请求**（切片：同页码；检索：同一份检索参数），
//      而不是只重置本地状态；
//   3. 401/403（`request()` 已归一为 `UNAUTHORIZED`）复用无权限态，且**不给**重试按钮。
//
// 环境：happy-dom + react-dom/client（与同批 prod-view / workflow / channel 的组件用例同款）。
// mock 的口径是本批约定的「模块作用域 `mock.module` 提供替身 + afterEach `mock.restore()`」，
// 需要替身的都是会把外部副作用、不可运行实现或单例带进用例的依赖：
//   - `react-i18next`：**自己注册替身**（本包两个用例共用 `registerReactI18nextStub`），替身不另抄
//     翻译表——`useTranslation` 委托给 provider 传入的真实实例（本用例注入的就是挂本包字典那份），
//     字典与断言取的 `TEXT` 同源。必须自己注册的原因与替身细节见 `react-i18next-stub.ts`；
//   - `sonner`：toast 需要宿主 Toaster 订阅，本用例只需观察「失败且已有数据」时的瞬时提示；
//   - `@fenix/ui-components/ui/sheet`：Radix 弹窗内容在 happy-dom 下不挂载（实测：portal 容器建立、
//     内容为空；同批 skill 用例对 FormDialog / ConfirmDialog 做同样替换）；
//   - `../components/knowledge/ResourcePreviewContent`：切片详情左栏的文档预览是 `React.lazy` 动态导入的，
//     模块顶层拉 mammoth / xlsx / react-markdown 等浏览器重依赖，左栏不在本用例的观察范围内；
//   - `@fenix/ui-components/ui/textarea`：**本环境无法模拟真实输入**（实测：React 19 的 ChangeEventPlugin
//     在 happy-dom 下对构造出来的 input/keydown 事件拿到 null targetInst，受控组件的 onChange / onKeyDown
//     不触发，异常还会被 happy-dom 的 dispatchEvent 吞掉），因此替身把「用户已输入查询词」这一步直接交给
//     `onChange`，粒度落在输入之后；被钉住的失败态、重试接线与请求参数不受影响；
//   - `dompurify`：真实实例在**模块求值期**绑定当时的全局 `window`，同进程更早的文件
//     （`packages/ui-components` 的 barrel 用例经 `@open-file-viewer/core`）已在无 window 时把它加载过，
//     本包渲染 `ChunkDetailSheet` 会直接抛 `DOMPurify.sanitize is not a function`；替身把真实工厂绑回
//     本用例的 window，清洗仍是真实实现（见文件内注释）。
//
// 期望文案直接取本包字典（`knowledgeResources.en`）：渲染用的是同一份字典（真实 i18next 实例），
// 字典改了用例跟着改，不会出现「界面换了文案、断言还是旧的」。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement, type ReactNode, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { KNOWLEDGE_NS, knowledgeResources } from "../i18n";
import { registerReactI18nextStub } from "./react-i18next-stub";

// 告知 React 当前为测试环境，消除 act() 警告
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * 用例期望的文案全部取自本包字典；渲染走真实 i18next 实例并挂同一份字典，
 * 因此「字典已登记该键」与「该分支真的渲染了这句文案」被绑在一起。
 */
const TEXT = knowledgeResources.en;

/** 插值断言：字典里的 `{{count}}` 换成实际命中数，避免把文案里的数字另抄一份。 */
function withCount(template: string, count: number): string {
  return template.replace("{{count}}", String(count));
}

/**
 * 渲染用的真实 i18next 实例：挂本包 en 字典，与断言取的是同一份资源。
 * 用真实实例而不是 `mock.module("react-i18next")`（后者在 bun 1.4.2 下是进程级、不可撤销的注册，
 * 会让同一次运行里其他必须拿真实库的用例失败），也避免了自建 `t` 替身必须逐字复刻字典的漂移。
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

/** 被测组件统一包在 i18n provider 里渲染（组件内的 `useTranslation(NS.KNOWLEDGE)` 据此取字典）。 */
function withI18n(node: ReactElement): ReactElement {
  return createElement(I18nextProvider, { i18n }, node);
}

// `react-i18next` 替身：本包两个组件用例共用 `registerReactI18nextStub`（语义与理由见该文件），
// 必须在被测组件被 import 之前注册——`bun test packages/` 单进程里同批文件注册的是
// `t: (key) => key` 的替身，不自己注册就会拿到 key 回显。
registerReactI18nextStub(i18n);

// 瞬时提示替身：本用例要观察「失败且已有数据」时 toast 才作为补充提示出现，因此必须可观察。
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

// Radix Sheet 的 portal 内容在 happy-dom 下不挂载，直接让内容随 open 就地渲染。
mock.module("@fenix/ui-components/ui/sheet", () => ({
  Sheet: ({ open, children }: { open: boolean; children?: ReactNode }) => (open ? children : null),
  SheetContent: ({ children }: { children?: ReactNode }) => children,
  SheetHeader: ({ children }: { children?: ReactNode }) => children,
  SheetTitle: ({ children }: { children?: ReactNode }) => children,
}));

mock.module("../components/knowledge/ResourcePreviewContent", () => ({
  ResourcePreviewContent: () => null,
}));

/** 替身 Textarea 交给 `onChange` 的查询词：它是「用户输入」这一步的替身，不是被断言的对象。 */
const PRESET_QUERY = "refund policy";

mock.module("@fenix/ui-components/ui/textarea", () => ({
  Textarea: ({ onChange }: { onChange?: (event: { target: { value: string } }) => void }) => {
    // 固定值 + 受控 state 的幂等比较，重复投递不会引起额外渲染或请求
    useEffect(() => {
      onChange?.({ target: { value: PRESET_QUERY } });
    }, [onChange]);
    return null;
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
// Radix 组件（Switch / Slider / Select）在挂载期读一批标准 DOM 全局，happy-dom 只把它们挂在 Window
// 实例上、不会同步到 globalThis；`getComputedStyle` 是实例方法，必须绑定到该 Window。
// （同批 channel 用例同一处理：缺哪个就会在 commit 阶段抛 ReferenceError，缺 DocumentFragment 时
// Select 的 useLayoutEffect 直接抛错。）
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

/**
 * `dompurify` 的实例在**模块求值期**就用当时的全局 `window` 定下来了
 * （`createDOMPurify(getGlobal())`：拿不到可用 window 时返回的工厂函数上没有 `sanitize`），
 * 而 `bun test packages/` 单进程跑完全部包：`packages/ui-components` 的 barrel 用例会经
 * `@open-file-viewer/core` 在无 window 时先把它加载进来，此后本包渲染 `ChunkDetailSheet`
 * （`DOMPurify.sanitize(chunk.content)`）必抛 `TypeError: DOMPurify.sanitize is not a function`。
 * 这里不降级成直通替身：把真实工厂绑到本用例的 happy-dom window 上，清洗能力仍是真实实现
 * （`onclick` / `<script>` 照旧被剥离），只是把「实例绑在哪个 window 上」收回到用例自己手里。
 * 注册必须排在上面的 `win` 之后——bun 1.4.2 会在注册时立即调用工厂。
 */
const dompurifyFactory = (await import("dompurify")).default as unknown as (root: unknown) => {
  sanitize: (html: string) => string;
};

mock.module("dompurify", () => ({ default: dompurifyFactory(win) }));

const { ChunkDetailSheet } = await import("../src/pages/agent-panel/components/ChunkDetailSheet");
const { RetrievalTestPanel } = await import("../src/pages/agent-panel/components/RetrievalTestPanel");

// ── fetch 桩：唯一的外部数据源 ──
type StubResponse = { status: number; body: unknown };

const CHUNKS_URL = "/web/knowledgeBases/kb-1/resources/res-1/chunks";
const SEARCH_URL = "/web/knowledgeBases/kb-1/search";
const RERANK_URL = "/web/knowledgeBases/rerank-models";

let chunkResponses: StubResponse[] = [];
let chunkCalls = 0;
let searchResponses: StubResponse[] = [];
let searchCalls = 0;
let rerankResponses: StubResponse[] = [];
let rerankCalls = 0;
/** 每次检索请求的 body：重试必须复用同一份参数，断言据此而不是只看调用次数。 */
const searchBodies: Record<string, unknown>[] = [];

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
    // rerank 模型下拉是与面板并行的次要请求：默认恒返回空列表（多数用例不关心它），
    // 要断言它的失败路径就把响应塞进 `rerankResponses`。
    if (method === "GET" && url.startsWith(RERANK_URL)) {
      const next = rerankResponses[Math.min(rerankCalls, rerankResponses.length - 1)] ?? {
        status: 200,
        body: { success: true, data: [] },
      };
      rerankCalls += 1;
      return jsonResponse(next);
    }
    if (method === "GET" && url.startsWith(CHUNKS_URL)) {
      const next = chunkResponses[Math.min(chunkCalls, chunkResponses.length - 1)];
      chunkCalls += 1;
      return jsonResponse(next);
    }
    if (method === "POST" && url.startsWith(SEARCH_URL)) {
      searchBodies.push(init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {});
      const next = searchResponses[Math.min(searchCalls, searchResponses.length - 1)];
      searchCalls += 1;
      return jsonResponse(next);
    }
    throw new Error(`用例未登记的请求：${method} ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

/** 失败信封：后端业务错误走 200 + success:false，传输层错误走非 2xx，两种都要能落到持久错误区。 */
function failure(code: string, message: string, status = 200): StubResponse {
  return { status, body: { success: false, error: { code, message } } };
}

/** 401/403：request 层把它归一为 UNAUTHORIZED，页面据此走无权限态（不给重试）。 */
function unauthorized(status: number): StubResponse {
  return { status, body: { success: false, error: { code: "UNAUTHORIZED", message: `请求失败 (${status})` } } };
}

function chunkPage(items: unknown[], total = items.length): StubResponse {
  return { status: 200, body: { success: true, data: { items, total, page: 1, pageSize: 20 } } };
}

function searchSuccess(): StubResponse {
  return {
    status: 200,
    body: {
      success: true,
      data: {
        chunks: [
          {
            chunkId: "chunk-1",
            content: "命中内容",
            documentName: "handbook.pdf",
            documentId: "doc-1",
            datasetId: "ds-1",
            similarity: 0.9,
          },
        ],
        total: 1,
        docAggs: [],
      },
    },
  };
}

const TEST_RESOURCE = {
  id: "res-1",
  knowledgeBaseId: "kb-1",
  sourceName: "handbook.pdf",
  sourceType: "upload" as const,
  sourcePath: "docs/handbook.pdf",
  remoteId: "rag-1",
  status: "completed" as const,
  chunkCount: 2,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const CHUNK_A = {
  id: "chunk-a",
  content: "切片一号内容",
  chunkIndex: 1,
  importantKeywords: ["关键词一"],
  enabled: true,
};

// ── 渲染工具 ──
let container: HTMLElement;
let root: Root;
let restoreFetch: () => void;
/** 失败路径会经过组件的 `console.error`；收集而不是打印，既保持输出可读，又能断言「诊断上下文没被吞掉」。 */
const consoleErrorCalls: unknown[][] = [];
let restoreConsoleError: () => void;

beforeEach(() => {
  chunkResponses = [];
  chunkCalls = 0;
  searchResponses = [];
  searchCalls = 0;
  rerankResponses = [];
  rerankCalls = 0;
  searchBodies.length = 0;
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

/** 渲染并等待 fetch → unwrap → setState 三段微任务与随后的 React 重渲染落定。 */
async function render(node: ReactElement): Promise<void> {
  await act(async () => {
    root.render(withI18n(node));
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

function renderChunkSheet(): ReactElement {
  return createElement(ChunkDetailSheet, {
    open: true,
    onClose: () => {},
    kbId: "kb-1",
    resource: TEST_RESOURCE,
  });
}

describe("ChunkDetailSheet 切片列表的失败态", () => {
  // 首次加载失败的契约：失败必须被看见（role="alert" + 原因 + 重试），且不得渲染成「没有切片」，
  // 重试按钮要真的把请求重新打出去并恢复列表——此前这里只有 toast，列表区落回 chunk.empty。
  test("首次加载失败落到可重试的持久错误区，不退化成空态，重试后恢复列表", async () => {
    chunkResponses = [failure("SERVER_ERROR", "boom", 500), chunkPage([CHUNK_A])];
    await render(renderChunkSheet());

    expect(chunkCalls).toBe(1);
    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.chunk.fetchFailed);
    expect(text()).toContain("boom");
    expect(text()).toContain(TEXT.loadFailure.hint);
    expect(text()).not.toContain(TEXT.chunk.empty);
    // 诊断上下文必须留痕（console.error），不能只把错误换成一句用户文案
    expect(consoleErrorCalls.length).toBeGreaterThan(0);

    await click(buttonByText(TEXT.actions.retry) as HTMLButtonElement);

    expect(chunkCalls).toBe(2);
    expect(alertRegions().length).toBe(0);
    expect(text()).toContain("#1");
    expect(text()).toContain("切片一号内容");
  });

  // 401/403 在 request 层已归一为 UNAUTHORIZED：只解释原因，不得给重试按钮（重试不会改变授权结果），
  // 也不得退化成空态——否则用户会以为「知识库里就是没有切片」。
  test("无权限失败复用无权限态且不提供重试按钮", async () => {
    chunkResponses = [unauthorized(403)];
    await render(renderChunkSheet());

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.accessDenied.title);
    expect(text()).toContain(TEXT.accessDenied.description);
    expect(buttonByText(TEXT.actions.retry)).toBeUndefined();
    expect(text()).not.toContain(TEXT.chunk.empty);
  });

  // 已有数据后的翻页失败：判据是「error && 无数据」才整区接管；此时列表保留旧数据（分页器已走到第 2 页，
  // 内容仍是第 1 页的旧数据），失败只由 toast 提示一次——本轮不新增「翻页失败」的第二份状态镜像。
  test("已有数据后翻页失败保留旧列表，只以瞬时提示告知且不整区接管", async () => {
    chunkResponses = [chunkPage([CHUNK_A], 40), failure("SERVER_ERROR", "boom", 500)];
    await render(renderChunkSheet());
    expect(text()).toContain("切片一号内容");

    // 下一页按钮只有图标（lucide-chevron-right），按图标类名定位；页 1/2 时它是唯一可点的下一页入口
    const next = container.querySelector(".lucide-chevron-right")?.closest("button");
    await click(next as unknown as HTMLButtonElement);

    expect(chunkCalls).toBe(2);
    expect(text()).toContain("切片一号内容");
    expect(alertRegions().length).toBe(0);
    expect(toastErrors).toEqual([TEXT.chunk.fetchFailed]);
  });
});

describe("RetrievalTestPanel 检索结果的失败态", () => {
  // 检索失败的契约：结果区整区接管为可重试的持久错误态，不得渲染成「暂无匹配结果」；
  // 重试必须复用同一份检索参数（原请求），而不是只清空状态。
  test("检索失败落到可重试的持久错误区，不退化成无结果，重试复用原请求参数", async () => {
    searchResponses = [failure("SERVER_ERROR", "检索服务不可用", 500), searchSuccess()];
    await render(createElement(RetrievalTestPanel, { knowledgeBaseId: "kb-1" }));

    await click(buttonByText(TEXT.retrieval.runTest) as HTMLButtonElement);

    expect(searchCalls).toBe(1);
    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.retrieval.error);
    expect(text()).toContain("检索服务不可用");
    expect(text()).not.toContain(TEXT.retrieval.noResults);

    await click(buttonByText(TEXT.actions.retry) as HTMLButtonElement);

    expect(searchCalls).toBe(2);
    expect(searchBodies[1]?.query).toBe(PRESET_QUERY);
    expect(alertRegions().length).toBe(0);
    expect(text()).toContain(withCount(TEXT.retrieval.resultCount, 1));
    expect(text()).toContain("handbook.pdf");
  });

  // 检索接口返回 403：同样走无权限态、不给重试，也不得落回「暂无匹配结果」。
  test("检索无权限失败复用无权限态且不提供重试按钮", async () => {
    searchResponses = [unauthorized(403)];
    await render(createElement(RetrievalTestPanel, { knowledgeBaseId: "kb-1" }));

    await click(buttonByText(TEXT.retrieval.runTest) as HTMLButtonElement);

    expect(alertRegions().length).toBe(1);
    expect(text()).toContain(TEXT.accessDenied.title);
    expect(buttonByText(TEXT.actions.retry)).toBeUndefined();
    expect(text()).not.toContain(TEXT.retrieval.noResults);
  });

  // 确实没有命中（后端返回空 chunks）时必须渲染 noResults 空态：失败态与空态的判据不能相互吃掉。
  test("检索成功但无命中时渲染无结果空态", async () => {
    searchResponses = [{ status: 200, body: { success: true, data: { chunks: [], total: 0, docAggs: [] } } }];
    await render(createElement(RetrievalTestPanel, { knowledgeBaseId: "kb-1" }));

    await click(buttonByText(TEXT.retrieval.runTest) as HTMLButtonElement);

    expect(alertRegions().length).toBe(0);
    expect(text()).toContain(TEXT.retrieval.noResults);
  });
});

describe("RetrievalTestPanel 的 rerank 候选取数", () => {
  // 业务意图：rerank 模型是**可选参数**，取数失败不该让整块面板失效；但它也不能静默——旧实现
  // `.catch(() => setRerankModels([]))` 让失败与「确实没有可选模型」同形，且 `resp.data ?? []` 是
  // 未 `unwrap` 的直取，4xx/5xx 会被读成成功空列表（§5.2 / §3.4 末条）。现在失败经 `unwrap()` 抛给
  // `useRequest`：下拉仍为空（与 §3.6 登记的「候选失败 = 空下拉」同一口径），诊断留在 `console.error`，
  // 检索入口照常可用——这条用例同时钉住「不阻断」与「不静默」两侧。
  test("rerank 候选取数失败：检索入口照常可用，失败只进诊断日志", async () => {
    rerankResponses = [failure("SERVER_ERROR", "模型列表不可用", 500)];
    await render(createElement(RetrievalTestPanel, { knowledgeBaseId: "kb-1" }));

    // 不阻断：面板没有整块失败，检索按钮仍在，也不出现持久错误区
    expect(buttonByText(TEXT.retrieval.runTest)).toBeDefined();
    expect(alertRegions().length).toBe(0);
    expect(text()).not.toContain("模型列表不可用");
    // 不静默：诊断日志带上了 rerank 的上下文（而不是被空 `catch` 吞掉）
    expect(consoleErrorCalls.some((args) => String(args[0]).includes("rerank"))).toBe(true);

    // 下拉为空不影响检索本身：照常跑通一次检索
    searchResponses = [searchSuccess()];
    await click(buttonByText(TEXT.retrieval.runTest) as HTMLButtonElement);

    expect(text()).toContain(withCount(TEXT.retrieval.resultCount, 1));
  });
});
