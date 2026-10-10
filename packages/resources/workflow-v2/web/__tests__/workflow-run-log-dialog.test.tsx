// web/__tests__/workflow-run-log-dialog.test.tsx
// 「运行日志」视图的关键数据流：打开即取数、上游无记录是空态、读取失败给重试且重试真的重新发请求、失败文案按
// 稳定错误码取（不回显服务端原文）、筛选切换真的改请求参数，以及关闭态不取数。
//
// 为什么必须真实渲染：这些状态的区别全在 `useRequest` 的状态流转与分支顺序上（失败**不得**退化成空态、重试
// 必须真的再发一笔请求、筛选变化必须带上 query），源码里出现对应字样不等于运行时走到了那一行（§11.1）。
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

mock.module("@fenix/ui-components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open?: boolean; children?: ReactNode }) =>
    open ? createElement("div", null, children) : null,
  DialogContent: ({ children }: { children?: ReactNode }) => createElement("div", null, children),
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
let router: FetchRouter;
let mount: ReturnType<typeof mountCanvas>;

/**
 * 让下一次 `/run-records` 的响应**悬停**：取数在途中界面是什么样，只能靠一个未决的响应把那一帧钉住
 * （响应立即兑现时，微任务排空后已是终态）。`releaseResponse` 由用例在断言之后调用来放行。
 */
let holdNextResponse = false;
let releaseResponse: (() => void) | null = null;

function route(call: FetchCall): FetchRoute | Promise<FetchRoute> {
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
  holdNextResponse = false;
  releaseResponse = null;
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

/** 运行记录的取数次数（打开、重试与切换筛选都落在这里）。 */
function runGetCount(): number {
  return router.callsTo("/run-records").filter((call) => call.method === "GET").length;
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
    // 记录行：名称、状态、时间、耗时四段都在渲染路径上（取值由模型用例钉住）。
    expect(textOf(mount.container)).toContain(WORKFLOW_A.name);
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
    // 空态下筛选器仍在（用户要能换一个工作流再看），且不发额外的请求。
    expect(filter()).not.toBeNull();
    expect(runGetCount()).toBe(1);
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
    expect(textOf(mount.container)).toContain(WORKFLOW_A.name);
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
      items: [RECORD_OK, { ...RECORD_OK, executeId: "7694582493076258888" }],
      workflows: [WORKFLOW_A, WORKFLOW_B],
      scannedWorkflows: 1,
      workflowTotal: 2,
      truncated: false,
      hasMoreUpstream: false,
      platformRuns: [],
    });
    await selectWorkflow(WORKFLOW_B.id);

    expect(runGetCount()).toBe(before + 1);
    const latest = router.callsTo("/run-records").at(-1);
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

    // 在途：筛选器留在原位（否则切一次筛选控件就消失一次），列表区是骨架而不是上一批记录。
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
    expect(mount.container.querySelector("select")).toBeNull();
  });
});

describe("单工作流模式（卡片「更多」入口）", () => {
  // 单工作流模式的查询主体由调用方给定：请求必须带该本地主键，且**不再渲染筛选器**（没有可筛的东西，
  // 一个只有一项的下拉只是噪音）；标题带上工作流名，用户能确认自己看的是哪一条。
  test("请求带该工作流主键、隐藏筛选器并显示限定标题", async () => {
    await mount.render(dialog(true, WORKFLOW_A.id));

    const call = router.callsTo("/run-records").at(-1);
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

  // 行里的字段全部来自上游库：执行 ID、模式、状态、时间、耗时、节点数一次断言到位；失败运行的错误码也要上屏。
  test("行渲染执行 ID、节点数与错误码", async () => {
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
  // 补上自己触发的运行：这一段来自审计流水，与上游清单分开展示（粒度不同），上游空态与平台侧记录可以同时出现
  // （两段互不替代）。
  test("平台侧运行记录单独成段与上游空态并排", async () => {
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
