import { afterEach, beforeEach, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { PERI_TASK_COLLAPSE_THRESHOLD, taskElapsedSeconds } from "../chat/panels/peri-task-rows";
import { usePeriTaskSelection } from "../chat/shell/internal/use-peri-task-selection";
import type { PeriTaskViewProjection } from "../chat/types";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

/**
 * 「子任务」区（`ChatStatusPanel` 的 tasks 页签 → `PeriTaskRows`）的行为测试。
 *
 * 只断言用户可见行为与数据流：折叠阈值与「更多 agent」入口、点击条目走宿主注入的详情端口
 * （复用真实 `PeriTaskDetailSheet`）、详情正文按既有 md 链路渲染（含公式与原始 HTML 剥离）、
 * 投影推进后详情跟随、会话切换清空选择、加载/空态/重连/失败原因与耗时计算；不做纯结构断言。
 *
 * 加载/空态直接渲染 `PeriTaskRows`：`ChatStatusPanel` 无可用页签时整体不渲染（既有产品行为），
 * 经面板拿不到这两个态。Radix（Sheet）在模块加载时探测 DOM，故 realm 装配后才动态导入组件；
 * 与其他 happy-dom/SSR 用例混跑时首载结果会被先加载者的全局状态决定，因此真实 DOM 交互放到
 * 子进程里跑，避免顺序依赖。
 */
if (process.env.FENIX_PERI_TASK_ROWS_TEST_CHILD !== "1") {
  // 独立进程保留真实 Radix 交互，不用 mock 替换组件行为。
  test("子任务区真实 DOM 交互回归", async () => {
    const child = Bun.spawn([process.execPath, "test", import.meta.path], {
      cwd: process.cwd(),
      env: { ...process.env, FENIX_PERI_TASK_ROWS_TEST_CHILD: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw new Error(`子任务区测试失败 (${code})\n${stdout}\n${stderr}`);
    expect(code).toBe(0);
  }, 30000);
} else {
  const win = initializeHappyDomWindow(new Window());
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    Node: win.Node,
    NodeFilter: win.NodeFilter,
    MutationObserver: win.MutationObserver,
    CustomEvent: win.CustomEvent,
    customElements: win.customElements,
    getComputedStyle: win.getComputedStyle.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { ChatStatusPanel } = await import("../chat/panels/chat-status-panel");
  const { PeriTaskDetailSheet } = await import("../chat/panels/PeriTaskDetailSheet");
  const { PeriTaskRows } = await import("../chat/panels/peri-task-rows");
  const i18n = createInstance();
  void i18n.init({ lng: "en", initAsync: false, resources: { en: { [UI_COMPONENTS_NS]: en } } });
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function task(taskId: string, overrides: Partial<PeriTaskViewProjection> = {}): PeriTaskViewProjection {
    return {
      taskId,
      title: taskId,
      kind: "subagent",
      taskSubtype: null,
      status: "running",
      summary: null,
      turnId: null,
      isBackground: false,
      startedAt: "2026-10-16T00:00:00Z",
      completedAt: null,
      updatedAt: "2026-10-16T00:00:00Z",
      detailAvailability: "unavailable",
      ...overrides,
    };
  }

  /** 子任务区 + 详情端口（与宿主装配同形：选择态来自 usePeriTaskSelection）。 */
  function Harness({
    tasks,
    scope = "ses-one",
    loadDetail,
  }: {
    tasks: PeriTaskViewProjection[];
    scope?: string;
    loadDetail?: Parameters<typeof PeriTaskDetailSheet>[0]["loadDetail"];
  }) {
    const selection = usePeriTaskSelection(scope, tasks);
    return (
      <I18nextProvider i18n={i18n}>
        <ChatStatusPanel todos={[]} tasks={tasks} tasksLoaded changedFiles={[]} onOpenTask={selection.select} />
        {loadDetail && (
          <PeriTaskDetailSheet
            environmentId="env-test"
            sessionId="instance-test"
            task={selection.task}
            onClose={selection.close}
            loadDetail={loadDetail}
          />
        )}
      </I18nextProvider>
    );
  }
  async function render(props: Parameters<typeof Harness>[0]) {
    await act(async () => {
      root.render(<Harness {...props} />);
    });
  }
  async function renderRows(props: Parameters<typeof PeriTaskRows>[0]) {
    await act(async () => {
      root.render(
        <I18nextProvider i18n={i18n}>
          <PeriTaskRows {...props} />
        </I18nextProvider>,
      );
    });
  }
  async function click(label: string, parent: ParentNode = document) {
    const button = Array.from(parent.querySelectorAll("button")).find((node) => node.textContent?.includes(label));
    expect(button).toBeDefined();
    await act(async () => {
      button?.click();
    });
  }
  const rowCount = () => container.querySelectorAll("[data-status]").length;

  /** 逐个事件循环推进，让惰性模块（streamdown、KaTeX、样式表）落地。 */
  async function flush(): Promise<void> {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  /** 详情正文渲染器是动态导入的：同步渲染只能拿到 Suspense 兜底，等标记出现再断言。 */
  async function waitFor(host: ParentNode, selector: string): Promise<Element> {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const found = host.querySelector(selector);
      if (found) return found;
      await flush();
    }
    throw new Error(`等待 ${selector} 超时（惰性模块未落地）`);
  }

  // 阈值内的任务全量展示，不出现折叠入口。
  test("未超阈值时不出现「更多 agent」", async () => {
    const tasks = Array.from({ length: PERI_TASK_COLLAPSE_THRESHOLD }, (_value, index) => task(`t${index}`));
    await render({ tasks });
    expect(rowCount()).toBe(PERI_TASK_COLLAPSE_THRESHOLD);
    expect(container.textContent).not.toContain(en.chat.components.periTask.moreAgents);
  });

  // 超过阈值只显示前 N 条 + 「更多 agent」；展开后显示全部，再点收起回到阈值。
  test("超阈值折叠为阈值条数，展开显示全部并可收起", async () => {
    const extra = 3;
    const tasks = Array.from({ length: PERI_TASK_COLLAPSE_THRESHOLD + extra }, (_value, index) => task(`t${index}`));
    await render({ tasks });
    expect(rowCount()).toBe(PERI_TASK_COLLAPSE_THRESHOLD);
    expect(container.textContent).toContain(en.chat.components.periTask.moreAgents);
    await click(en.chat.components.periTask.moreAgents);
    expect(rowCount()).toBe(PERI_TASK_COLLAPSE_THRESHOLD + extra);
    expect(container.textContent).toContain(en.chat.components.periTask.showLess);
    await click(en.chat.components.periTask.showLess);
    expect(rowCount()).toBe(PERI_TASK_COLLAPSE_THRESHOLD);
  });

  // 点击条目复用既有的 PeriTaskDetailSheet；投影推进时详情跟随更新（同一 taskId 重新取数）。
  test("点击条目复用详情 Sheet，投影推进后详情跟随", async () => {
    const requests: string[] = [];
    const loadDetail: Parameters<typeof PeriTaskDetailSheet>[0]["loadDetail"] = async (_env, _session, taskId) => {
      requests.push(taskId);
      return {
        kind: "preview",
        taskId,
        taskKind: "subagent",
        items: [{ type: "text", content: `snapshot:${taskId}:${requests.length}` }],
        nextCursor: null,
        complete: false,
        limitation: "source_only_provides_preview",
      };
    };
    await render({ tasks: [task("alpha")], loadDetail });
    await click("alpha");
    expect(requests).toEqual(["alpha"]);
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain("snapshot:alpha:1");
    await render({ tasks: [task("alpha", { status: "completed" })], loadDetail });
    expect(requests).toEqual(["alpha", "alpha"]);
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("snapshot:alpha:2");
  });

  // subagent 详情走聊天正文同一条 md 链路（streamdown + 数学插件 + 既有清洗）：加粗与公式
  // 真的渲染成节点，正文里的原始 HTML 仍被剥离（不新开一条渲染或放行口径）。
  test("详情按 Markdown 渲染，公式可用且原始 HTML 被剥离", async () => {
    const content = "**bold** and $a^2$ end\n\n<script>globalThis.__periDetailXss = 1</script>\n";
    const loadDetail: Parameters<typeof PeriTaskDetailSheet>[0]["loadDetail"] = async (_env, _session, taskId) => ({
      kind: "preview",
      taskId,
      taskKind: "subagent",
      items: [{ type: "text", content }],
      nextCursor: null,
      complete: false,
      limitation: "source_only_provides_preview",
    });
    await render({ tasks: [task("alpha")], loadDetail });
    await click("alpha");
    // streamdown 的加粗落到 `<span data-streamdown="strong">`（与 message.ssr.test.tsx 同口径）
    expect((await waitFor(document.body, '[data-streamdown="strong"]')).textContent).toBe("bold");
    expect(await waitFor(document.body, ".katex")).not.toBeNull();
    expect(document.body.querySelector("script")).toBeNull();
  });

  // 会话切换后选择清空：旧会话的详情抽屉不得留在新会话上。
  test("会话切换清空选择并关闭详情", async () => {
    const loadDetail: Parameters<typeof PeriTaskDetailSheet>[0]["loadDetail"] = async (_env, _session, taskId) => ({
      kind: "unavailable",
      taskId,
      taskKind: "subagent",
      reason: "not_provided",
    });
    await render({ tasks: [task("alpha")], loadDetail });
    await click("alpha");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    await render({ scope: "ses-two", tasks: [task("alpha")], loadDetail });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  // 加载、空态与重连提示都要可见；失败行展示投影里的脱敏摘要，不伪造原因。
  test("加载、空态、重连和失败原因可见", async () => {
    await renderRows({ tasks: [], loaded: false });
    expect(container.textContent).toContain(en.chat.components.periTask.loading);
    await renderRows({ tasks: [], loaded: true });
    expect(container.textContent).toContain(en.chat.components.periTask.empty);
    await renderRows({
      tasks: [task("alpha"), task("beta", { status: "failed", summary: "Execution failed" })],
      loaded: true,
      reconnecting: true,
    });
    expect(container.textContent).toContain("Execution failed");
    expect(container.textContent).toContain(en.chat.components.periTask.reconnecting);
    expect(container.querySelector('[data-status="failed"]')).not.toBeNull();
    expect(container.querySelector('[data-status="running"]')).not.toBeNull();
  });

  // 行改单行后失败原因不得丢：理由文本仍在行内，截断后完整文本经 title 可达。
  test("失败原因单行展示且完整文本经 title 可达", async () => {
    const reason = "Execution failed: [REDACTED_SECRET]";
    await renderRows({ tasks: [task("beta", { status: "failed", summary: reason })], loaded: true });
    const row = container.querySelector('[data-status="failed"]');
    expect(row).not.toBeNull();
    const reasonNode = Array.from(row?.querySelectorAll("span") ?? []).find((node) => node.textContent === reason);
    expect(reasonNode).toBeDefined();
    expect(reasonNode?.getAttribute("title")).toBe(reason);
  });

  // 耗时只由真实时间戳推导：运行中继续计时，终态取结束时间，非法/缺失时间不产生假数据。
  test("耗时来自真实时间戳，不推测完成状态", () => {
    expect(taskElapsedSeconds(task("alpha"), Date.parse("2026-10-16T00:02:05Z"))).toBe(125);
    expect(
      taskElapsedSeconds(task("alpha", { status: "completed", completedAt: "2026-10-16T00:01:00Z" }), Date.now()),
    ).toBe(60);
    expect(taskElapsedSeconds(task("bad", { startedAt: "invalid" }), Date.now())).toBeNull();
    expect(taskElapsedSeconds(task("bad", { status: "failed" }), Date.now())).toBeNull();
  });
}
