// web/__tests__/workflow-log-dialog.test.tsx
// 「日志」弹窗的关键数据流：打开即取数、上游无记录是空态、读取失败给重试且重试真的重新发请求、
// 本地与上游版本不一致时给出漂移提示，以及关闭态不取数。
//
// 为什么必须真实渲染：这四种状态的区别全在 `useRequest` 的状态流转与分支顺序上（失败**不得**退化成空态、
// 重试必须真的再发一笔请求），源码里出现对应字样不等于运行时走到了那一行（§11.1）。
//
// 两处替身：`@fenix/ui-components/ui/dialog` 的 Radix 内容在 happy-dom 下不挂载（portal 建好、内容为空），
// 换成直通替身把数据流暴露出来；`react-i18next` 用真实实例但 `resources: {}`，断言按 **i18n 键**回显做
// （字典完整性由 `workflow-v2-i18n.test.ts` 静态守护）。DOM 装配与 fetch 桩复用 `./canvas-host-harness`。

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

const { WorkflowLogDialog } = await import("../pages/list/workflow-log-dialog");

const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

/** 本地主键；弹窗按它取数（列表行上的「日志」把该行记录交给弹窗）。 */
const WORKFLOW_ID = "wf-local-1";
const WORKFLOW_NAME = "客服问答流程";

/** 上游返回一条完整记录（版本 + 渠道结果）+ 一条平台侧发布动作 + 当前发布版本。 */
const OVERVIEW_WITH_RECORD = webOk({
  current: { publishedVersion: "v0.0.3" },
  records: [
    {
      version: "v0.0.2",
      status: "done",
      channels: [{ connectorId: "1024", connectorName: "API", status: "success" }],
      packFailedResources: [],
    },
  ],
  actions: [
    {
      occurredAt: "2026-10-09T02:00:00.000Z",
      actorName: "张三",
      result: "ok",
      errorCode: null,
    },
  ],
});

/** 上游没有渠道发布记录（且平台侧也没有动作）：两段都是合法空态，不是失败。 */
const OVERVIEW_EMPTY = webOk({ current: { publishedVersion: null }, records: [], actions: [] });

let overviewRoute: FetchRoute;
let router: FetchRouter;
let mount: ReturnType<typeof mountCanvas>;

function route(call: FetchCall): FetchRoute {
  if (call.method === "GET" && call.url.includes("/publish-records")) return overviewRoute;
  return webErr("NOT_FOUND", "unexpected route", 404);
}

beforeEach(() => {
  overviewRoute = OVERVIEW_WITH_RECORD;
  router = installFetchRouter(route);
  mount = mountCanvas();
});

afterEach(() => {
  mount.unmount();
  router.restore();
});

/** 渲染弹窗；`workflowId` 缺省为已知目标（`null` 用来钉「目标未确定时不取数」）。 */
function dialog(options: { readonly open?: boolean; readonly workflowId?: string | null }) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(WorkflowLogDialog, {
      open: options.open ?? true,
      onOpenChange: () => {},
      workflowId: options.workflowId === undefined ? WORKFLOW_ID : options.workflowId,
      workflowName: WORKFLOW_NAME,
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

/** 发布记录的取数次数（打开与重试都落在这里）。 */
function overviewGetCount(): number {
  return router.callsTo("/publish-records").filter((call) => call.method === "GET").length;
}

describe("日志弹窗的取数与三态", () => {
  // 首帧是骨架：取数期间渲染空态会谎报「上游没有记录」，渲染版本对照会显示未发布——两者都是错的事实。
  test("先渲染骨架，取数完成后显示上游版本与记录", async () => {
    act(() => {
      mount.root.render(dialog({}));
    });
    expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();

    await mount.flush();
    expect(mount.container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(textOf(mount.container)).toContain("log.current_upstream");
    expect(textOf(mount.container)).toContain("v0.0.3");
    // 上游记录是**版本级**的（没有名称/时间/操作人字段）：这里钉住版本号与渠道结果，钉住「不幻造字段」。
    expect(textOf(mount.container)).toContain("log.record_version");
    expect(textOf(mount.container)).toContain("log.record_channels");
    // 平台侧发布动作（本地审计）与记录并排渲染：它的字段是时间 + 操作人 + 结果，取值由服务端决定，
    // 这里只证明整段在渲染路径上（两段来源不同，不能互相替代）。
    expect(textOf(mount.container)).toContain("log.actions_title");
    expect(textOf(mount.container)).toContain("log.action_time");
    expect(textOf(mount.container)).toContain("log.action_actor");
    expect(textOf(mount.container)).toContain("log.action_result");
  });

  // 渠道结果与打包失败明细来自上游真实字段（记录级状态由它们派生）：两行都要在渲染路径上，
  // 这样「发布到哪个渠道、成没成、打包失败的是谁」才看得见。
  test("渲染渠道结果与打包失败明细", async () => {
    overviewRoute = webOk({
      current: { publishedVersion: "v0.0.3" },
      records: [
        {
          version: "v0.0.3",
          status: "pack_failed",
          channels: [{ connectorId: "1024", connectorName: "API", status: "in_progress" }],
          packFailedResources: ["坏掉的工作流"],
        },
      ],
      actions: [],
    });
    await mount.render(dialog({}));

    expect(textOf(mount.container)).toContain("log.record_pack_failed");
    // 渠道状态走插值参数（字典为空时 i18next 回显键本身），因此这里只钉渠道那一行在渲染路径上；
    // 状态码 → 文案键的映射由模型用例逐个钉住（`workflow-publish-model.test.ts`）。
    expect(textOf(mount.container)).toContain("log.record_channels");
    // 平台侧动作为空时整段不渲染（不给用户看一个恒空的标题）。
    expect(textOf(mount.container)).not.toContain("log.actions_title");
  });

  // 上游没有记录时必须渲染空态而不是空列表：`data:null` 是上游的合法回答（当前上游构建恒如此）。
  test("上游无记录时渲染空态并显示未发布", async () => {
    overviewRoute = OVERVIEW_EMPTY;
    await mount.render(dialog({}));

    expect(textOf(mount.container)).toContain("log.empty_title");
    expect(textOf(mount.container)).toContain("log.empty_hint");
    expect(textOf(mount.container)).toContain("log.current_none");
    expect(mount.container.querySelector("ul")).toBeNull();
  });

  // 读取失败是**独立分支**：给 role="alert" 与重试，且重试必须真的再发一笔请求（而不是重渲染同一个失败态）。
  test("读取失败给重试，重试后渲染成功状态", async () => {
    overviewRoute = webErr("UPSTREAM_REJECTED", "upstream rejected", 502);
    await mount.render(dialog({}));

    expect(textOf(mount.container)).toContain("log.failed_title");
    expect(mount.container.querySelector('[role="alert"]')).not.toBeNull();
    const before = overviewGetCount();

    overviewRoute = OVERVIEW_WITH_RECORD;
    await click(buttonByText("log.retry"));

    expect(overviewGetCount()).toBe(before + 1);
    expect(textOf(mount.container)).toContain("log.current_upstream");
    expect(textOf(mount.container)).toContain("v0.0.3");
  });

  // 关闭态不取数：Radix 关闭时不渲染内容，本用例的替身也照此实现——避免弹窗常驻时后台空转请求。
  test("关闭态不取数", async () => {
    await mount.render(dialog({ open: false }));

    expect(overviewGetCount()).toBe(0);
    expect(textOf(mount.container)).not.toContain("log.current_upstream");
  });
});

describe("版本呈现只以上游为准", () => {
  // 平台不维护版本镜像（用户口径「不做版本管理」）：弹窗不得再出现「本地版本」一行，
  // 否则用户会以为存在两套版本，并去追问哪个才是真的。
  test("只呈现上游版本，没有本地版本对照行", async () => {
    await mount.render(dialog({}));

    expect(textOf(mount.container)).toContain("log.current_upstream");
    expect(textOf(mount.container)).toContain("v0.0.3");
    expect(textOf(mount.container)).not.toContain("log.current_local");
  });
});
