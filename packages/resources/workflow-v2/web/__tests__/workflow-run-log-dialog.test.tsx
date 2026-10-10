// web/__tests__/workflow-run-log-dialog.test.tsx
// 「运行日志」主从两栏的关键数据流：打开即取清单并自动选中第一条执行记录、只按当前选中项取**一次**出入参数
// （不随记录条数增长）、点击左栏另一条换详情、上游无记录是空态、读取失败给重试且重试真的重新发请求、失败文案按
// 稳定错误码取（不回显服务端原文）、筛选切换真的改请求参数并让选中回落到新一批，以及关闭态不取数。
//
// 为什么必须真实渲染：这些区别全在 `useRequest` 的状态流转与分支顺序上（失败**不得**退化成空态、重试必须真的
// 再发一笔请求、切换记录必须换掉详情而不是把上一条的数据留下来），源码里出现对应字样不等于运行时走到了那一行
// （§11.1）。
//
// 两处替身：`@fenix/ui-components/ui/dialog` 的 Radix 内容在 happy-dom 下不挂载（portal 建好、内容为空），
// 换成直通替身把数据流暴露出来；`react-i18next` 用真实实例但 `resources: {}`，断言按 **i18n 键**回显做
// （字典完整性由 `workflow-v2-i18n.test.ts` 静态守护）。DOM 装配与 fetch 桩复用 `./canvas-host-harness`。
// 筛选器是原生 `<select>`（非 portal），因此筛选用例可以走真实的 change 事件。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInstance } from "i18next";
import { act, createElement, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import {
  type FetchCall,
  type FetchRoute,
  type FetchRouter,
  installFetchRouter,
  mountCanvas,
  textOf,
  webErr,
  webOk,
  win,
} from "./canvas-host-harness";

/**
 * 弹窗内容收到的 props（尺寸变体与固定高度）。
 *
 * 替身是直通渲染，尺寸与高度只体现在 `DialogContent` 的 props 上（DOM 结构与 happy-dom 的布局都不反映它们），
 * 因此由替身在渲染时记下来供断言——「外框不随内容变高」这条约束只能在这里钉。
 */
let dialogContentProps: { readonly size?: string; readonly className?: string } = {};

mock.module("@fenix/ui-components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  DialogContent: (props: { size?: string; className?: string; children?: ReactNode }) => {
    dialogContentProps = { size: props.size, className: props.className };
    return createElement("div", { className: props.className }, props.children);
  },
  DialogHeader: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
  DialogTitle: ({ children }: { children?: ReactNode }) => createElement("h2", null, children),
  DialogDescription: ({ children }: { children?: ReactNode }) => createElement("p", null, children),
}));

afterEach(() => {
  mock.restore();
});

const { WorkflowRunLogDialog } = await import("../pages/list/workflow-run-log-dialog");

const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

/** 本地主键 + 名称：筛选选项由服务端随记录同批返回。 */
const WORKFLOW_A = { id: "wf-local-a", name: "客服问答流程" };
const WORKFLOW_B = { id: "wf-local-b", name: "报表生成流程" };

/** 上游 workflow ID：记录行与平台侧留痕都按它归属（本地主键只是筛选用的入口标识）。 */
const UPSTREAM_WORKFLOW_ID = "7694581096108785664";

/** 一条可判读的记录（字段与服务端 `RunRecordSchema` 逐项对应；execute id 走字符串形态）。 */
const RECORD_OK = {
  executeId: "7694582493076258816",
  workflowId: UPSTREAM_WORKFLOW_ID,
  version: "v0.0.2",
  mode: "release" as const,
  status: "succeeded" as const,
  durationMs: 1_500,
  createdAt: "2026-10-09T02:00:00.000Z",
  errorCode: null,
  nodeCount: 2,
  logId: "log-1",
};

/** 第二条记录：用来验证「切换选中只按新选中项取数」。 */
const RECORD_SECOND = { ...RECORD_OK, executeId: "7694582493076258888", logId: "log-2" };

/** 上游给了认不出的模式/状态码：显示「未知」而不是「失败」，也不显示成某个具体模式。 */
const RECORD_UNKNOWN = {
  executeId: "7694582493076258899",
  workflowId: UPSTREAM_WORKFLOW_ID,
  version: null,
  mode: null,
  status: null,
  durationMs: null,
  createdAt: null,
  errorCode: null,
  nodeCount: null,
  logId: null,
};

/** 组织内两个工作流、一条记录；`scanned === total` 因此不触发范围提示。 */
const PAGE_READY = webOk({
  items: [RECORD_OK],
  workflows: [WORKFLOW_A, WORKFLOW_B],
  scannedWorkflows: 2,
  workflowTotal: 2,
  truncated: false,
  hasMoreUpstream: false,
  platformRuns: [],
});

/** 上游没有记录（当前上游构建下是常态）：合法空态，不是失败。 */
const PAGE_EMPTY = webOk({
  items: [],
  workflows: [WORKFLOW_A, WORKFLOW_B],
  scannedWorkflows: 2,
  workflowTotal: 2,
  truncated: false,
  hasMoreUpstream: false,
  platformRuns: [],
});

let runRoute: FetchRoute;
let ioRoute: FetchRoute;
let router: FetchRouter;
let mount: ReturnType<typeof mountCanvas>;

/**
 * 让下一次 `/run-records` 的响应**悬停**：取数在途中界面是什么样，只能靠一个未决的响应把那一帧钉住
 * （响应立即兑现时，微任务排空后已是终态）。`releaseResponse` 由用例在断言之后调用来放行。
 */
let holdNextResponse = false;
let releaseResponse: (() => void) | null = null;

/** 同上，作用于选中项的出入参数请求（`/run-records/:id/io`）：加载态同样只在未决响应那一帧可见。 */
let holdNextIoResponse = false;
let releaseIoResponse: (() => void) | null = null;

function route(call: FetchCall): FetchRoute | Promise<FetchRoute> {
  // 出入参数（路径更深）必须先判：它的 URL 同样含 `/run-records`，先判清单会把详情请求喂成清单响应。
  if (call.method === "GET" && call.url.includes("/run-records/")) {
    if (!holdNextIoResponse) return ioRoute;
    holdNextIoResponse = false;
    return new Promise<FetchRoute>((resolve) => {
      releaseIoResponse = () => resolve(ioRoute);
    });
  }
  if (call.method === "GET" && call.url.includes("/run-records")) {
    if (!holdNextResponse) return runRoute;
    holdNextResponse = false;
    return new Promise<FetchRoute>((resolve) => {
      releaseResponse = () => resolve(runRoute);
    });
  }
  return webErr("NOT_FOUND", "unexpected route", 404);
}

beforeEach(() => {
  runRoute = PAGE_READY;
  ioRoute = webOk({ input: '{"hello":"io-probe"}', output: '{"ok":true}' });
  holdNextResponse = false;
  releaseResponse = null;
  holdNextIoResponse = false;
  releaseIoResponse = null;
  router = installFetchRouter(route);
  mount = mountCanvas();
});

afterEach(() => {
  mount.unmount();
  router.restore();
});

/** 渲染弹窗：`workflowId` 缺省为 null = 页面级模式（页头入口），给出 id 即单工作流模式（卡片入口）。 */
function dialog(open = true, scopedId: string | null = null) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(WorkflowRunLogDialog, {
      open,
      onOpenChange: () => {},
      workflowId: scopedId,
      workflowName: scopedId === null ? "" : WORKFLOW_A.name,
    }),
  );
}

/** 按可见文案（键回显）取按钮；找不到即用例写错。 */
function buttonByText(label: string): HTMLButtonElement {
  for (const button of mount.container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  throw new Error(`按钮未渲染：${label}`);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await mount.flush();
}

/** 左栏条目按钮（执行记录与平台记录各一行）：不可选中的记录不是按钮，因此不在其中。 */
function indexButtons(): HTMLButtonElement[] {
  return [...mount.container.querySelectorAll("li button")] as unknown as HTMLButtonElement[];
}

/** 当前选中的左栏条目（`aria-current` 是选中态的唯一判据）。 */
function selectedIndexButton(): HTMLButtonElement | undefined {
  return indexButtons().find((button) => button.getAttribute("aria-current") === "true");
}

/** 筛选器（原生 `<select>`）；找不到即用例写错。 */
function filter(): HTMLSelectElement {
  const select = mount.container.querySelector("select");
  if (select === null) throw new Error("筛选器未渲染");
  return select as unknown as HTMLSelectElement;
}

/** 切换筛选值：原生控件的 change 事件即 React 的 onChange（`select` 不需要 value 追踪器那条规避）。
 * 事件必须用 happy-dom 的构造器——Node 全局的 `Event` 与装置里的 DOM 不同源，`dispatchEvent` 会拒收。 */
async function selectWorkflow(value: string): Promise<void> {
  await act(async () => {
    filter().value = value;
    filter().dispatchEvent(new win.Event("change", { bubbles: true }));
  });
  await mount.flush();
}

/** 运行**清单**的请求：打开、重试与切换筛选落在这里；出入参数请求（路径更深）与之同前缀，必须排除。 */
function runCalls(): FetchCall[] {
  return router.callsTo("/run-records").filter((call) => call.method === "GET" && !call.url.includes("/run-records/"));
}

/** 运行记录的取数次数。 */
function runGetCount(): number {
  return runCalls().length;
}

/** 出入参数的取数次数（自动选中与切换选中落在这里）。 */
function ioGetCount(): number {
  return router.callsTo("/run-records/").filter((call) => call.method === "GET").length;
}

describe("运行日志弹窗的取数与三态", () => {
  // 首帧是骨架：取数期间渲染空态会谎报「上游没有记录」，那是与事实相反的结论。
  test("先渲染骨架，取数完成后显示记录与默认筛选", async () => {
    act(() => {
      mount.root.render(dialog());
    });
    expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await mount.flush();
    expect(mount.container.querySelector('[aria-busy="true"]')).toBeNull();
    // 左栏：分组标题 + 记录（执行 ID、状态、时间、耗时四段都在渲染路径上，取值由模型用例钉住）。
    expect(textOf(mount.container)).toContain("run.records_title");
    expect(textOf(mount.container)).toContain("run.record_execute_id");
    expect(textOf(mount.container)).toContain("run.status.succeeded");
    expect(textOf(mount.container)).toContain("run.record_started_at");
    expect(textOf(mount.container)).toContain("run.record_duration");
    // 筛选默认「全部工作流」，且选项来自同一次响应（不需要第二个请求）。
    expect(filter().value).toBe("");
    expect(filter().options).toHaveLength(3);
    expect(runGetCount()).toBe(1);
  });

  // 「未知」「失败」「成功」是三个必须分开的结论：上游没给可判读状态时不得显示成失败，否则用户会去排查一次
  // 并没有失败的运行；名称缺失也要有兜底而不是空字符串。
  test("上游未给状态与时间时显示未知档而非失败", async () => {
    runRoute = webOk({
      items: [RECORD_UNKNOWN],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.status.unknown");
    expect(textOf(mount.container)).not.toContain("run.status.failed");
    expect(textOf(mount.container)).toContain("run.mode.unknown");
    // 时间与耗时的**取值**（含缺失时的兜底文案）由 `workflow-run-log-model.test.ts` 钉住：字典为空时
    // i18next 回显键本身、不插值，界面上看到的仍是键名。
    expect(textOf(mount.container)).toContain("run.record_started_at");
    expect(textOf(mount.container)).toContain("run.record_duration");
  });

  // 上游没有记录时必须渲染空态而不是空列表：空记录是上游的合法回答（当前上游构建恒如此）。
  test("上游无记录时渲染空态而不是空列表", async () => {
    runRoute = PAGE_EMPTY;
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.empty_title");
    expect(textOf(mount.container)).toContain("run.empty_hint");
    expect(mount.container.querySelector("ul")).toBeNull();
    // 空态下筛选器仍在（用户要能换一个工作流再看），且不发额外的请求、也没有出入参数请求。
    expect(filter()).not.toBeNull();
    expect(runGetCount()).toBe(1);
    expect(ioGetCount()).toBe(0);
  });

  // 读取失败是**独立分支**：给 role="alert" 与重试，且重试必须真的再发一笔请求。
  test("读取失败给重试，重试后渲染成功状态", async () => {
    runRoute = webErr("UPSTREAM_REJECTED", "upstream rejected", 502);
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.failed_title");
    expect(textOf(mount.container)).toContain("run.failed_upstream");
    expect(mount.container.querySelector('[role="alert"]')).not.toBeNull();
    const before = runGetCount();

    runRoute = PAGE_READY;
    await click(buttonByText("run.retry"));

    expect(runGetCount()).toBe(before + 1);
    expect(textOf(mount.container)).toContain("run.record_execute_id");
  });

  // 失败文案按**稳定错误码**取字典键，且不回显服务端原文（`ApiError.message` 是后端信封原文，含上游措辞）。
  test("失败文案按稳定错误码取键且不回显服务端原文", async () => {
    runRoute = webErr("ORG_APP_NOT_BOUND", "当前组织尚未初始化工作流空间", 409);
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.failed_unbound");
    // 服务端原文只进日志：它不该出现在界面上（字典为空时键会原样回显，正文不会出现上游措辞）。
    expect(textOf(mount.container)).not.toContain("当前组织尚未初始化工作流空间");
  });

  // 筛选是「按工作流查询」这条上游约束的界面出口：切换后请求必须带上该本地主键，且列表换成新一批结果。
  test("切换筛选后按本地主键重新取数", async () => {
    await mount.render(dialog());
    const before = runGetCount();

    runRoute = webOk({
      items: [RECORD_OK, RECORD_SECOND],
      workflows: [WORKFLOW_A, WORKFLOW_B],
      scannedWorkflows: 1,
      workflowTotal: 2,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await selectWorkflow(WORKFLOW_B.id);

    expect(runGetCount()).toBe(before + 1);
    const latest = runCalls().at(-1);
    expect(latest?.url).toContain(`workflowId=${WORKFLOW_B.id}`);
    // 新一批是两行、旧一批是一行：行数变化即证明列表换成了新结果（插值文本在空字典下不可见）。
    expect(mount.container.querySelectorAll("ul > li")).toHaveLength(2);
  });

  // 重取期间不得沿用上一批行：`useRequest` 会保留旧 `data`，若照旧渲染，切换筛选的那一瞬间会把上一个工作流的
  // 记录挂在新筛选值下面（一个明确的加载态比张冠李戴的行好查得多）。
  test("切换筛选的重取期间不沿用上一批记录", async () => {
    await mount.render(dialog());
    expect(mount.container.querySelectorAll("ul > li")).toHaveLength(1);

    runRoute = webOk({
      items: [{ ...RECORD_OK, workflowName: WORKFLOW_B.name, logId: "log-b" }],
      workflows: [WORKFLOW_A, WORKFLOW_B],
      scannedWorkflows: 1,
      workflowTotal: 2,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    holdNextResponse = true;
    await act(async () => {
      filter().value = WORKFLOW_B.id;
      filter().dispatchEvent(new win.Event("change", { bubbles: true }));
    });

    // 在途：筛选器留在原位（否则切一次筛选控件就消失一次），两栏区是骨架而不是上一批记录。
    // 判据取「记录列表不存在」而不是「文本里没有旧名字」——旧名字仍会作为**筛选选项**出现，那是正确的。
    expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(mount.container.querySelector("ul")).toBeNull();
    expect(filter().value).toBe(WORKFLOW_B.id);

    await act(async () => {
      releaseResponse?.();
    });
    await mount.flush();
    expect(mount.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(mount.container.querySelectorAll("ul > li")).toHaveLength(1);
  });

  // 「全部工作流」在上游侧只能是有限扇出（`workflow_id` 必填）：被截断时必须说明这次扫了哪些，
  // 否则用户会把「没扫到」读成「没运行过」。
  test("全部工作流未被完全扫描时给出范围提示", async () => {
    runRoute = webOk({
      items: [RECORD_OK],
      workflows: [WORKFLOW_A, WORKFLOW_B],
      scannedWorkflows: 1,
      workflowTotal: 9,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.scope_hint");
  });

  // 未截断时不给范围提示：一个恒显示的说明行只会污染每一次查看。
  test("扫描范围完整时不给出范围提示", async () => {
    await mount.render(dialog());

    expect(textOf(mount.container)).not.toContain("run.scope_hint");
  });

  // 上屏条数被服务端裁剪过时必须说出来，否则「只有 50 条」会被当成「一共 50 次运行」。
  test("记录被裁剪时给出裁剪提示", async () => {
    runRoute = webOk({
      items: [RECORD_OK],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: true,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.truncated_hint");
  });

  // 上游按工作流返回的记录条数有上限（没有游标），页满时服务端置 `hasMoreUpstream`：它与平台侧裁剪提示互不
  // 替代——本用例只置上游页满（`truncated` 为 false），这条提示也必须单独出现。
  test("上游页满时给出「可能还有更早运行」提示", async () => {
    runRoute = webOk({
      items: [RECORD_OK],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: true,
      platformRuns: [],
    });
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.upstream_more_hint");
    expect(textOf(mount.container)).not.toContain("run.truncated_hint");
  });

  // 上游未页满时不点亮提示：假阳性已经由服务端的判定口径限死在「恰好一页」，界面上不能再放宽成恒显示。
  test("上游未页满时不给「可能还有更早运行」提示", async () => {
    await mount.render(dialog());

    expect(textOf(mount.container)).not.toContain("run.upstream_more_hint");
  });

  // 关闭态不取数：Radix 关闭时不渲染内容，本用例的替身也照此实现——避免弹窗常驻时后台空转请求。
  test("关闭态不取数", async () => {
    await mount.render(dialog(false));

    expect(runGetCount()).toBe(0);
    expect(ioGetCount()).toBe(0);
    expect(mount.container.querySelector("select")).toBeNull();
  });
});

describe("主从两栏：左栏选中与右栏详情", () => {
  // 打开即自动选中第一条**可查看详情**的执行记录：空态等待会让用户以为这里没东西可看；且只按选中项取一次
  // 出入参数——清单不返回 input/output（上游契约如此），N 条记录 N 次上游查询不成立。
  test("打开即选中第一条并只取一次出入参数", async () => {
    runRoute = webOk({
      items: [RECORD_OK, RECORD_SECOND],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());

    expect(ioGetCount()).toBe(1);
    const call = router.callsTo("/run-records/").at(-1);
    expect(call?.url).toContain(`/run-records/${RECORD_OK.executeId}/io`);
    expect(call?.url).toContain(`upstreamWorkflowId=${UPSTREAM_WORKFLOW_ID}`);
    // 选中态：左栏第一条、右栏出输入与输出两块（值本身不经字典，是数据不是文案）。
    expect(selectedIndexButton()?.textContent).toContain("run.record_execute_id");
    expect(textOf(mount.container)).toContain("run.io_input");
    expect(textOf(mount.container)).toContain("run.io_output");
    expect(textOf(mount.container)).toContain('"hello": "io-probe"');
  });

  // 切换选中必须换掉详情（含它的请求参数），且只为新选中项再取一次：左栏是索引，右栏是「当前这一条」。
  test("点击另一条记录换成它的出入参数", async () => {
    runRoute = webOk({
      items: [RECORD_OK, RECORD_SECOND],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());
    expect(ioGetCount()).toBe(1);

    ioRoute = webOk({ input: '{"second":true}', output: null });
    await click(indexButtons()[1]);

    expect(ioGetCount()).toBe(2);
    const call = router.callsTo("/run-records/").at(-1);
    expect(call?.url).toContain(`/run-records/${RECORD_SECOND.executeId}/io`);
    expect(textOf(mount.container)).toContain('"second": true');
    // 输出缺失时给「上游未提供」，上一批的输出（`"ok": true`）不得留在右栏。
    expect(textOf(mount.container)).toContain("run.value_unknown");
    expect(textOf(mount.container)).not.toContain('"ok": true');
  });

  // 重复点击同一个选中项不重复取数：用户点回自己正在看的那一条不该产生第二次上游调用。
  test("重复点击已选中的记录不重复取数", async () => {
    await mount.render(dialog());
    expect(ioGetCount()).toBe(1);

    const before = selectedIndexButton();
    await click(indexButtons()[0]);

    expect(ioGetCount()).toBe(1);
    expect(selectedIndexButton()).toBe(before as HTMLButtonElement);
  });

  // 在途是独立的加载态（不谎报「上游未提供」）：未决响应那一帧必须显示加载文案，兑现后换成输入/输出两块。
  test("详情取数在途显示加载态，兑现后上屏输入与输出", async () => {
    ioRoute = webOk({ input: "{}", output: null });
    holdNextIoResponse = true;
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.io_loading");

    await act(async () => {
      releaseIoResponse?.();
    });
    await mount.flush();

    expect(textOf(mount.container)).not.toContain("run.io_loading");
    // 输出缺失时给「上游未提供」而不是空块；输入那一块照常上屏。
    expect(textOf(mount.container)).toContain("run.value_unknown");
    expect(textOf(mount.container)).toContain("run.io_input");
  });

  // 详情失败是**右栏分支**：按稳定错误码取文案（不回显服务端原文）、右栏重试真的再取一次，且清单不受影响
  // ——把一条记录的详情读取失败升级成整页错误，会让用户为了看别的记录而重试整个列表。
  test("详情失败给错误与重试，重试成功后就地显示", async () => {
    ioRoute = webErr("UPSTREAM_TIMEOUT", "upstream timeout", 504);
    await mount.render(dialog());

    expect(textOf(mount.container)).toContain("run.io_failed_title");
    expect(textOf(mount.container)).toContain("run.failed_timeout");
    expect(textOf(mount.container)).not.toContain("upstream timeout");
    expect(mount.container.querySelector('[role="alert"]')).not.toBeNull();
    // 左栏仍在（记录行与右栏错误同屏；字典为空时工作流名只走插值，判据取记录行本身），列表级重试没有出现。
    expect(mount.container.querySelectorAll("ul > li")).toHaveLength(1);
    expect(textOf(mount.container)).toContain("run.record_execute_id");

    ioRoute = webOk({ input: '{"a":1}', output: null });
    await click(buttonByText("run.retry"));

    expect(ioGetCount()).toBe(2);
    // 详情重试只重取这一条：清单请求次数不变（两个错误等级不能混用，否则看别的记录也要重取整个列表）。
    expect(runGetCount()).toBe(1);
    expect(textOf(mount.container)).toContain('"a": 1');
  });

  // 缺任一归属要素就不可选中（详情按两者取数，缺一取不到）：这类记录不是按钮（给一个必然失败的入口比不给
  // 更糟），右栏说明原因而不是留白，也不发任何出入参数请求。
  test("缺执行 ID 或上游 ID 的记录不可选中", async () => {
    runRoute = webOk({
      items: [
        { ...RECORD_OK, workflowId: null },
        { ...RECORD_OK, executeId: null, logId: null },
      ],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());

    expect(mount.container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(indexButtons()).toHaveLength(0);
    expect(textOf(mount.container)).toContain("run.detail_unavailable");
    expect(ioGetCount()).toBe(0);
  });

  // 截图式的兜底反例：可查看详情的记录与不可查看的混排时，默认选中跳过不可选的那条——否则右栏会停在一条
  // 永远取不到数的记录上。
  test("默认选中跳过不可查看详情的记录", async () => {
    runRoute = webOk({
      items: [{ ...RECORD_OK, executeId: null, logId: null }, RECORD_SECOND],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());

    const call = router.callsTo("/run-records/").at(-1);
    expect(call?.url).toContain(`/run-records/${RECORD_SECOND.executeId}/io`);
    expect(textOf(mount.container)).not.toContain("run.detail_unavailable");
  });

  // 切换筛选换了批次后，原来的选中项已不在列表里：选中回落到新一批的第一条，且详情请求带上新记录的 execute id
  // ——右栏显示的运行必须能在左栏找到。
  test("切换筛选后选中回落到新一批的第一条", async () => {
    await mount.render(dialog());

    runRoute = webOk({
      items: [{ ...RECORD_OK, workflowName: WORKFLOW_B.name }],
      workflows: [WORKFLOW_A, WORKFLOW_B],
      scannedWorkflows: 1,
      workflowTotal: 2,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await selectWorkflow(WORKFLOW_B.id);

    const call = router.callsTo("/run-records/").at(-1);
    expect(call?.url).toContain(`/run-records/${RECORD_OK.executeId}/io`);
    expect(ioGetCount()).toBe(2);
    expect(selectedIndexButton()).not.toBeUndefined();
  });
});

describe("外框固定高度与两栏滚动边界", () => {
  // 弹窗高度由弹窗决定：`size="xl"` 只给 `max-h-[90vh]`（内容是骨架时弹窗就矮、是长输出时就高），页面再钉一条
  // `h-[90vh]` 才是固定高度。弹窗垂直居中，外框一变整块就重新居中——「点一下记录抖一下」的来源就在这里。
  test("弹窗用固定高度而不是只给 max-height", async () => {
    await mount.render(dialog());

    expect(dialogContentProps.size).toBe("xl");
    expect(dialogContentProps.className).toContain("h-[90vh]");
  });

  // 两个滚动边界都要有高度约束：`min-h-0` 让它能在 flex 里收缩、`overflow-y-auto` 是它自己的滚动条。缺一个
  // 就会出现「整个弹窗第二条滚动条」或「内容把外框越撑越高」。
  test("左右两栏各自是 min-h-0 + overflow-y-auto 的滚动容器", async () => {
    await mount.render(dialog());

    for (const slot of ["run-index-scroll", "run-detail-scroll"]) {
      const scroller = mount.container.querySelector(`[data-slot="${slot}"]`);
      expect(scroller).not.toBeNull();
      expect(scroller?.className).toContain("min-h-0");
      expect(scroller?.className).toContain("overflow-y-auto");
    }
  });

  // 切换选中后右栏从顶部开始读：滚动位置跟着旧节点一起丢掉（容器按选中键重建）。左栏是索引，点击不重建它
  // ——左栏的滚动位置不会因为看另一条记录而跳回顶部。
  // happy-dom 不做真实布局、`scrollTop` 永远是 0，因此这里钉住的是机制本身：滚动容器的节点身份。
  test("切换选中重建右栏滚动容器、左栏容器保持", async () => {
    runRoute = webOk({
      items: [RECORD_OK, RECORD_SECOND],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog());
    const detailBefore = mount.container.querySelector('[data-slot="run-detail-scroll"]');
    const indexBefore = mount.container.querySelector('[data-slot="run-index-scroll"]');
    expect(detailBefore).not.toBeNull();

    await click(indexButtons()[1]);

    expect(mount.container.querySelector('[data-slot="run-detail-scroll"]')).not.toBe(detailBefore);
    expect(mount.container.querySelector('[data-slot="run-index-scroll"]')).toBe(indexBefore as Element);
  });

  // 取数期间左栏的滚动边界不重建：窄列不会先闪成空的、再被回填的行撑开，滚动位置也不跟着跳回顶部；骨架只在
  // 容器内部顶住行高。取数结束后仍是同一个容器。
  test("切换筛选的重取期间左栏容器不重建且只有骨架", async () => {
    await mount.render(dialog());
    const indexBefore = mount.container.querySelector('[data-slot="run-index-scroll"]');
    expect(indexBefore).not.toBeNull();

    holdNextResponse = true;
    await act(async () => {
      filter().value = WORKFLOW_B.id;
      filter().dispatchEvent(new win.Event("change", { bubbles: true }));
    });

    expect(mount.container.querySelector('[data-slot="run-index-scroll"]')).toBe(indexBefore as Element);
    expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(mount.container.querySelector("ul")).toBeNull();
    // 序号提示条也是上一批的结论：取数期间不显示。
    expect(textOf(mount.container)).not.toContain("run.truncated_hint");

    await act(async () => {
      releaseResponse?.();
    });
    await mount.flush();

    expect(mount.container.querySelector('[data-slot="run-index-scroll"]')).toBe(indexBefore as Element);
    expect(mount.container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});

describe("单工作流模式（卡片「更多」入口）", () => {
  // 单工作流模式的查询主体由调用方给定：请求必须带该本地主键，且**不再渲染筛选器**（没有可筛的东西，
  // 一个只有一项的下拉只是噪音）；标题带上工作流名，用户能确认自己看的是哪一条。
  test("请求带该工作流主键、隐藏筛选器并显示限定标题", async () => {
    await mount.render(dialog(true, WORKFLOW_A.id));

    const call = runCalls().at(-1);
    expect(call?.url).toContain(`workflowId=${WORKFLOW_A.id}`);
    expect(mount.container.querySelector("select")).toBeNull();
    expect(textOf(mount.container)).toContain("run.title_scoped");
    expect(textOf(mount.container)).toContain("run.description_scoped");
    // 工作流名与执行 ID 都走插值（空字典下 i18next 只回显键本身），这里钉住「标题 + 记录行」都在渲染路径上。
    expect(textOf(mount.container)).toContain("run.record_execute_id");
  });

  // 单工作流模式下不存在「没扫全」这个偏差（就查这一个），因此不给范围提示；裁剪提示与「上游可能还有」仍然要给
  // ——前者是服务端上屏上界、后者是上游按工作流的返回上限，两条约束都与模式无关。
  test("单工作流模式不给范围提示但仍给裁剪与上游页满提示", async () => {
    runRoute = webOk({
      items: [RECORD_OK],
      workflows: [WORKFLOW_A, WORKFLOW_B],
      scannedWorkflows: 1,
      workflowTotal: 9,
      truncated: true,
      hasMoreUpstream: true,
      platformRuns: [],
    });
    await mount.render(dialog(true, WORKFLOW_A.id));

    expect(textOf(mount.container)).not.toContain("run.scope_hint");
    expect(textOf(mount.container)).toContain("run.truncated_hint");
    expect(textOf(mount.container)).toContain("run.upstream_more_hint");
  });

  // 行里的字段全部来自上游库：执行 ID、模式、状态、时间、耗时在左栏，节点数与失败运行的错误码在右栏详情
  // ——窄列塞不下后两个，而它们是「这次为什么失败」的入口。
  test("执行 ID 在左栏，节点数与错误码在右栏详情", async () => {
    runRoute = webOk({
      items: [{ ...RECORD_OK, status: "failed", errorCode: "777777778" }],
      workflows: [WORKFLOW_A],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await mount.render(dialog(true, WORKFLOW_A.id));

    expect(textOf(mount.container)).toContain("run.record_execute_id");
    expect(textOf(mount.container)).toContain("run.record_node_count");
    expect(textOf(mount.container)).toContain("run.record_error");
    expect(textOf(mount.container)).toContain("run.status.failed");
  });

  // 上游 2026-10-09 起有「列出执行历史」的读出口（上面的清单来自它），但那只覆盖**上游侧**的执行；平台侧必须
  // 补上自己触发的运行：这一段来自审计流水、落在左栏底部分组（粒度与上游 span 不同，合并会把两件事说成一件）。
  // 上游清单为空时它仍是默认选中项，右栏据此**明确说明**没有输入输出可看，而不是留一块白板。
  test("平台侧记录在左栏底部分组，选中后说明没有输入输出", async () => {
    runRoute = webOk({
      items: [],
      platformRuns: [
        {
          upstreamWorkflowId: UPSTREAM_WORKFLOW_ID,
          occurredAt: "2026-10-09T02:00:00.000Z",
          result: "ok",
          errorCode: null,
        },
      ],
      workflows: [{ id: WORKFLOW_A.id, name: WORKFLOW_A.name }],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
    });
    await mount.render(dialog(true, WORKFLOW_A.id));

    expect(textOf(mount.container)).toContain("run.platform_title");
    expect(textOf(mount.container)).toContain("run.platform_time");
    expect(textOf(mount.container)).toContain("run.platform_result");
    expect(textOf(mount.container)).toContain("run.platform_hint");
    expect(textOf(mount.container)).toContain("run.empty_title");
    // 平台记录可选中，且右栏给出「输入输出不存在」的说明而不是空白面板。
    expect(indexButtons()).toHaveLength(1);
    expect(selectedIndexButton()).not.toBeUndefined();
    expect(textOf(mount.container)).toContain("run.platform_no_io");
    // 平台记录没有 execute id，因此不会去取上游的出入参数。
    expect(ioGetCount()).toBe(0);
  });

  // 平台记录与执行记录同屏时各在各的分组：平台记录**不混进**执行记录列表，默认仍选中执行记录（主内容），
  // 点平台条目才把右栏换成它的字段与「没有输入输出」的说明，且不会因此去取上游的出入参数。
  test("平台记录与执行记录同屏时分属两个分组", async () => {
    runRoute = webOk({
      items: [RECORD_OK],
      platformRuns: [
        {
          upstreamWorkflowId: UPSTREAM_WORKFLOW_ID,
          occurredAt: "2026-10-09T02:00:00.000Z",
          result: "ok",
          errorCode: null,
        },
      ],
      workflows: [{ id: WORKFLOW_A.id, name: WORKFLOW_A.name }],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
    });
    await mount.render(dialog(true, WORKFLOW_A.id));

    // 两条条目：执行记录 1 条 + 平台记录 1 条（平台记录没有 execute id，不会出现在执行记录列表里）。
    expect(indexButtons()).toHaveLength(2);
    expect(selectedIndexButton()?.textContent).toContain("run.record_execute_id");
    expect(textOf(mount.container)).toContain("run.io_input");
    expect(textOf(mount.container)).not.toContain("run.platform_no_io");

    // 平台条目在底部分组里（DOM 顺序在后）：点它之后右栏换成平台字段与说明，出入参数那块整体让位。
    await click(indexButtons()[1]);

    expect(textOf(mount.container)).toContain("run.platform_no_io");
    expect(textOf(mount.container)).not.toContain("run.io_input");
    expect(ioGetCount()).toBe(1);
  });

  // 平台侧没有记录时整段不渲染：不给用户看一个恒空的标题（与筛选范围提示同款取舍）。
  test("平台侧运行记录为空时整段不渲染", async () => {
    runRoute = webOk({
      items: [],
      platformRuns: [],
      workflows: [{ id: WORKFLOW_A.id, name: WORKFLOW_A.name }],
      scannedWorkflows: 1,
      workflowTotal: 1,
      truncated: false,
      hasMoreUpstream: false,
    });
    await mount.render(dialog(true, WORKFLOW_A.id));

    expect(textOf(mount.container)).not.toContain("run.platform_title");
    expect(textOf(mount.container)).toContain("run.empty_title");
  });

  // 失败的呈现与页面级模式共用一套（同一组件、同一错误码口径），单工作流模式只是查询主体不同。
  test("单工作流模式失败时同样给错误码文案与重试", async () => {
    runRoute = webErr("PLATFORM_ACCOUNT_NOT_PROVISIONED", "account ledger missing", 503);
    await mount.render(dialog(true, WORKFLOW_A.id));

    expect(mount.container.querySelector('[role="alert"]')).not.toBeNull();
    // 台账缺行不是「未绑定」：文案不得把用户指到列表页的初始化入口（那里因为已绑定没有这个按钮）。
    expect(textOf(mount.container)).toContain("run.failed_account_not_provisioned");
    expect(textOf(mount.container)).not.toContain("run.failed_unbound");
  });
});
