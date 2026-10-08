// web/__tests__/workflow-list-page.test.tsx
// 列表页的关键数据流：取数三态（loading / empty / error+retry）、无权限不给重试、上游未就绪的引导，以及
// 新建 / 重命名 / 删除三个动作的接线与「删除被上游策略拒绝」的结局。
//
// 为什么必须真实渲染：被钉住的行为是「失败不会退化成空态」「重试真的重新发一笔请求」「deleted=false 时
// 记录仍在列表里且不重取」——这些取决于 `useRequest` 的状态流转、分支顺序与回调接线，源码里出现对应字样
// 不等于运行时走到了那一行（§11.1）。
//
// 环境与替身口径沿用同目录的画布用例：DOM 全局装配与 fetch 路由桩直接复用 `./canvas-host-harness`
// （happy-dom 的全局注入必须成对且完整，第二份副本必然漂移；那份装置里的 `mountCanvas()` 只是
// 「建容器 + createRoot + render/flush/unmount」，与画布无关）。另加三处替换：
//   - `react-i18next` 不替换：用真实实例但 `resources: {}`，断言按 **i18n 键**回显做（与画布用例同款），
//     字典本身的完整性由 `workflow-v2-i18n.test.ts` 静态守护；
//   - `@fenix/ui-components` 的两个弹窗：Radix 弹窗内容在 happy-dom 下不挂载（portal 容器建立、内容为空），
//     用同签名替身把「确认删除」「提交表单」两条接线暴露出来，字段体与校验照常渲染；
//   - `@tanstack/react-router`：导航是 `<Link>` 与 `useNavigate()`，脱离 RouterProvider 会抛错，替身记录
//     跳转目标并按下 `$id` 插值（据此断言画布深链指向上游 workflow ID）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInstance } from "i18next";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import type { Resolver } from "react-hook-form";
import { I18nextProvider } from "react-i18next";
import {
  type FetchCall,
  type FetchRoute,
  type FetchRouter,
  installFetchRouter,
  mountCanvas,
  webErr,
  webOk,
} from "./canvas-host-harness";

// ── 弹窗与路由替身（必须在导入页面之前注册） ──

const { FormProvider, useForm } = await import("react-hook-form");
const { zodResolver } = await import("@hookform/resolvers/zod");

/** 路由跳转记录；`params` 保留原样，断言画布深链时用。 */
const navigations: Array<{ to: string; params?: Record<string, string> }> = [];

mock.module("@tanstack/react-router", () => ({
  useNavigate: () => (options: { to: string; params?: Record<string, string> }) => {
    navigations.push(options);
  },
  // `params` 插值：真实 `Link` 会把 `$id` 换成分段值，替身照做才能断言深链目标。
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params?: Record<string, string>;
    children?: unknown;
    className?: string;
  }) => {
    let href = to;
    for (const [name, value] of Object.entries(params ?? {})) href = href.replace(`$${name}`, value);
    return createElement("a", { href, className }, children as never);
  },
}));

/**
 * 最近一次 `FormDialog` 替身创建的表单实例的写入器：用例经它填字段。
 *
 * 为什么不是「往输入框派发 input 事件」：React 19 在 happy-dom 下判定 `isInputEventSupported` 为假
 * （`isEventSupported("input")` 依赖真实文档），文本输入的 `onChange` 走 IE 时代的 `propertychange`
 * 回退分支而永不触发——同批的表单用例（plugin-market / channel）因此一律经表单实例或默认值取值。
 * 被替换的是「用户敲键盘」这一层，页面关心的「表单值 → 请求体」接线照常生效。
 */
let fillForm: ((values: Record<string, string>) => void) | null = null;

/** 弹窗替身：`FormDialog` 复刻内部形态（`useForm` 在「弹窗」内创建 + `FormProvider` 包住字段体 + zod 校验）。 */
mock.module("@fenix/ui-components/config/FormDialog", () => ({
  FormDialog: ({
    open,
    formConfig,
    children,
  }: {
    open: boolean;
    formConfig?: {
      schema?: unknown;
      defaultValues?: Record<string, unknown>;
      onFormSubmit?: (values: Record<string, unknown>) => void;
    };
    children?: ReactNode;
  }) => {
    // 泛型与 `FormDialog` 内部一致（域类型在 `formConfig` 里是 `Record<string, unknown>`）；
    // zod schema 经 `Resolver` 收窄，避免 `handleSubmit` 的入参退化成 `unknown`。
    const methods = useForm<Record<string, unknown>>({
      resolver: formConfig?.schema
        ? (zodResolver(formConfig.schema as never) as Resolver<Record<string, unknown>>)
        : undefined,
      defaultValues: formConfig?.defaultValues,
    });
    if (!open) return null;
    // 只有打开着的弹窗写这个句柄：页面同时挂载新建与重命名两个弹窗，关闭的那个不该抢走写入目标。
    fillForm = (values) => {
      for (const [name, value] of Object.entries(values)) methods.setValue(name, value);
    };
    return createElement(
      FormProvider,
      methods as never,
      createElement(
        "form",
        { onSubmit: methods.handleSubmit((values) => formConfig?.onFormSubmit?.(values)) },
        children,
        createElement("button", { type: "submit", "data-testid": "form-submit" }, "submit"),
      ),
    );
  },
}));

mock.module("@fenix/ui-components/config/ConfirmDialog", () => ({
  ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) =>
    open
      ? createElement("button", { type: "button", "data-testid": "confirm-delete", onClick: onConfirm }, "confirm")
      : null,
}));

afterEach(() => {
  mock.restore();
});

const { WorkflowListPage } = await import("../pages/list/workflow-list-page");

const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

// ── 契约夹具（字段与 `api/workflows.ts` 的类型逐项对应） ──

const ITEM = {
  id: "wf-local-1",
  upstreamWorkflowId: "upstream-wf-1",
  appId: "app-1",
  name: "客服问答流程",
  ownerUserId: "user-1",
  visibility: "private",
  publishedVersion: null,
  syncState: "active" as const,
  updatedAt: new Date().toISOString(),
};

const BOUND_ACTIVE = webOk({ appId: "app-1", status: "active" });
const LIST_ONE = webOk({ items: [ITEM], total: 1 });
const LIST_EMPTY = webOk({ items: [], total: 0 });

let listRoute: FetchRoute;
let bindingRoute: FetchRoute;
/** 建绑（初始化工作流空间）的成功响应；与探测同路径，按方法分流。 */
let orgAppCreateRoute: FetchRoute;
/** 只按 URL 前缀分派：列表的 GET / DELETE 都落在同一前缀上，由方法区分。 */
let workflowDeleteRoute: FetchRoute;

function route(call: FetchCall): FetchRoute {
  if (call.method === "GET" && call.url.startsWith("/web/workflow-v2/workflows")) return listRoute;
  if (call.method === "DELETE" && call.url.startsWith("/web/workflow-v2/workflows")) return workflowDeleteRoute;
  // `/org-app` 一条路径两种语义：GET 是绑定探测、POST 是建绑，必须先按方法分流再落到探测上。
  if (call.method === "POST" && call.url === "/web/workflow-v2/org-app") return orgAppCreateRoute;
  if (call.url === "/web/workflow-v2/org-app") return bindingRoute;
  // 变更请求默认成功：单条用例只关心自己那条动作时，不必再声明一遍。
  if (call.method === "POST" && call.url === "/web/workflow-v2/workflows")
    return webOk({ id: "wf-local-new", upstreamWorkflowId: "upstream-wf-new" });
  if (call.method === "PATCH" && call.url.startsWith("/web/workflow-v2/workflows")) return webOk({ ok: true });
  return webErr("NOT_FOUND", "unexpected route", 404);
}

let router: FetchRouter;
let mount: ReturnType<typeof mountCanvas>;

beforeEach(() => {
  navigations.length = 0;
  listRoute = LIST_ONE;
  bindingRoute = BOUND_ACTIVE;
  orgAppCreateRoute = webOk({ appId: "app-1" });
  workflowDeleteRoute = webOk({ deleted: true, strategy: 0 });
  router = installFetchRouter(route);
  mount = mountCanvas();
});

afterEach(() => {
  mount.unmount();
  router.restore();
});

// ── 渲染与查询工具 ──

function page(): ReactElement {
  return createElement(I18nextProvider, { i18n }, createElement(WorkflowListPage));
}

/** 按可见文案（键回显）取按钮；找不到即用例写错（比断言 undefined 更早暴露）。 */
function buttonByText(label: string): HTMLButtonElement {
  for (const button of mount.container.querySelectorAll("button")) {
    if ((button.textContent ?? "").trim() === label) return button as unknown as HTMLButtonElement;
  }
  throw new Error(`按钮未渲染：${label}`);
}

function byTestId(testId: string): HTMLElement {
  const element = mount.container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`元素未渲染：${testId}`);
  return element;
}

function inputById(id: string): HTMLInputElement {
  const element = mount.container.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`输入框未渲染：${id}`);
  return element;
}

/** 写入表单字段（经替身暴露的实例，理由见 `fillForm` 的说明）。 */
async function fill(values: Record<string, string>): Promise<void> {
  if (!fillForm) throw new Error("表单替身未挂载：先打开弹窗");
  await act(async () => {
    fillForm?.(values);
  });
}

/** 点击并等待随后的请求链与重渲染落定。 */
async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await mount.flush();
}

/** 列表取数次数（分页、重试、删除后刷新都落在这里）。 */
function listGetCount(): number {
  return router.callsTo("/web/workflow-v2/workflows").filter((call) => call.method === "GET").length;
}

/** 绑定探测次数；与建绑同路径，这里只数 GET（「刷新必须同时重取列表与绑定」就靠它与 `listGetCount` 一起断言）。 */
function orgAppGetCount(): number {
  return router.callsTo("/web/workflow-v2/org-app").filter((call) => call.method === "GET").length;
}

function callTo(fragment: string, method: string): FetchCall | undefined {
  return router.callsTo(fragment).find((call) => call.method === method);
}

describe("取数与视图状态", () => {
  // 首帧必须是骨架：`loading` 期间渲染空态或表格都会谎报「数据已到」。
  test("取数中渲染骨架，完成后渲染表格行", async () => {
    act(() => {
      mount.root.render(page());
    });
    // 取数链还停在微任务队列里，这一帧就是骨架屏（同步断言，不需要假时钟）。
    expect(mount.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(mount.container.querySelector("table")).toBeNull();

    await mount.flush();
    expect(mount.container.querySelector("table")).not.toBeNull();
    expect(mount.container.textContent).toContain(ITEM.name);
    expect(mount.container.textContent).toContain("list.status.unpublished");
  });

  test("空列表渲染空态（而不是表格与失败块）", async () => {
    listRoute = LIST_EMPTY;
    await mount.render(page());

    expect(mount.container.textContent).toContain("list.no_workflows");
    expect(mount.container.textContent).toContain("list.no_workflows_hint");
    expect(mount.container.querySelector("table")).toBeNull();
    // 空是合法结果：不给重试。
    expect(mount.container.textContent).not.toContain("list.retry");
  });

  // 失败是持久分支：只弹一次提示会落回「暂无工作流」，用户看到的是「没有数据」而不是「没取到数据」。
  test("取数失败渲染失败块，重试会重新发请求并恢复", async () => {
    listRoute = webErr("INTERNAL_ERROR", "boom", 500);
    await mount.render(page());

    expect(mount.container.textContent).toContain("list.load_failed");
    expect(mount.container.querySelector("table")).toBeNull();

    const before = listGetCount();
    listRoute = LIST_ONE;
    await click(buttonByText("list.retry"));

    expect(listGetCount()).toBe(before + 1);
    expect(mount.container.textContent).toContain(ITEM.name);
  });

  // 401/403 重试只会重复被拒：渲染说明但不给重试按钮。
  test("无权限不给重试入口", async () => {
    listRoute = webErr("UNAUTHENTICATED", "missing organization", 401);
    await mount.render(page());

    expect(mount.container.textContent).toContain("list.unauthorized_title");
    expect(mount.container.textContent).not.toContain("list.retry");
  });

  // 未绑定租户 App 时列表可能仍有历史记录，但那些工作流打开必然失败：给引导而不是渲染一张点不动的表。
  test("未绑定租户 App 时给绑定引导，不渲染表格", async () => {
    bindingRoute = webOk({ appId: null, status: "unbound" });
    await mount.render(page());

    expect(mount.container.textContent).toContain("list.blocked.unbound.title");
    expect(mount.container.textContent).not.toContain(ITEM.name);
    expect(mount.container.querySelector("table")).toBeNull();
    // 创建在上游没归属时必然失败（409），入口一并置灰。
    expect(buttonByText("list.create").disabled).toBe(true);
  });
});

describe("未绑定态的初始化入口", () => {
  /** 未绑定态是这一组用例的公共起点：列表有历史记录，但绑定探测回 unbound。 */
  async function renderUnbound(): Promise<void> {
    bindingRoute = webOk({ appId: null, status: "unbound" });
    await mount.render(page());
  }

  // 未绑定不是死路：没有初始化入口（`POST /org-app`）时「重试」永远改变不了这个状态，新组织被永久卡在这一屏。
  // 一键语义：点击**直接发请求**，既没有确认弹窗也没有名称输入框——名称由服务端取组织名称，前端不参与。
  test("未绑定态点击初始化直接发 POST /org-app，无表单无请求体", async () => {
    await renderUnbound();

    expect(mount.container.textContent).toContain("list.blocked.unbound.title");
    // 主动作与重试并存：前者能改变状态，后者用于「别人刚把绑定做好」。
    expect(mount.container.textContent).toContain("list.retry");

    const postsBefore = router.callsTo("/web/workflow-v2/org-app").filter((call) => call.method === "POST").length;
    await click(buttonByText("list.blocked.unbound.initialize"));

    const post = callTo("/web/workflow-v2/org-app", "POST");
    // 请求体为空：名称不再是入参（服务端也不读它）。
    expect(post?.body).toBeUndefined();
    expect(router.callsTo("/web/workflow-v2/org-app").filter((call) => call.method === "POST")).toHaveLength(
      postsBefore + 1,
    );
    // 没有任何名称输入框：用户不需要为展示名做决定。
    expect(mount.container.querySelector("#workflow-initialize-name")).toBeNull();
  });

  // 成功后必须把列表与绑定**一起**重取：两者同批取数，只刷一个会留下「绑定已通、列表还是未绑定那批」的界面。
  test("初始化成功后同批重取列表与绑定并切回列表", async () => {
    await renderUnbound();
    // 服务端建绑成功后探测会回 active，界面随之切到列表。
    bindingRoute = BOUND_ACTIVE;
    const listBefore = listGetCount();
    const probeBefore = orgAppGetCount();

    await click(buttonByText("list.blocked.unbound.initialize"));

    expect(listGetCount()).toBe(listBefore + 1);
    expect(orgAppGetCount()).toBe(probeBefore + 1);
    expect(mount.container.textContent).toContain(ITEM.name);
    expect(mount.container.textContent).not.toContain("list.blocked.unbound.title");
  });

  // 失败给出页面级提示：没有弹窗可以承载失败，文案按**稳定错误码**取字典，服务端信封原文（可能是上游措辞）
  // 不上屏——本包任何用户可见字符串都不得来自 `err.message`。
  test("初始化失败给出提示条，留在未绑定态且不回显服务端原文", async () => {
    await renderUnbound();
    orgAppCreateRoute = webErr("PLATFORM_SESSION_UNAVAILABLE", "RAW-UPSTREAM-TEXT", 503);
    const listBefore = listGetCount();

    await click(buttonByText("list.blocked.unbound.initialize"));

    expect(mount.container.textContent).toContain("list.initialize_failed_session");
    expect(mount.container.textContent).not.toContain("RAW-UPSTREAM-TEXT");
    // 失败后留在未绑定态：按钮还在，用户可以直接再点一次（幂等）。
    expect(mount.container.textContent).toContain("list.blocked.unbound.title");
    // 失败不刷新：绑定没成，重取只会把同一屏原样取回来（真正的失败解释在提示条里）。
    expect(listGetCount()).toBe(listBefore);
  });
});

describe("删除的数据流", () => {
  test("确认后发出 DELETE，成功则刷新列表并给出提示", async () => {
    await mount.render(page());
    await click(buttonByText("list.delete"));
    await click(byTestId("confirm-delete"));

    const request = callTo("/web/workflow-v2/workflows", "DELETE");
    expect(request?.url).toBe("/web/workflow-v2/workflows/wf-local-1");
    // 刷新：删掉的行必须从列表里消失（不刷新就只能等下一次进入页面）。
    expect(listGetCount()).toBe(2);
    expect(mount.container.textContent).toContain("list.delete_success");
  });

  // strategy 非 0 = 上游策略拒绝（首发审核中 / 需先下架）：记录仍在，UI 不得假装删掉。
  test("上游策略拒绝删除时给出拒绝原因，记录仍在且不重取", async () => {
    workflowDeleteRoute = webOk({ deleted: false, strategy: 1 });
    await mount.render(page());
    const before = listGetCount();

    await click(buttonByText("list.delete"));
    await click(byTestId("confirm-delete"));

    expect(mount.container.textContent).toContain("list.delete_refused.reviewing");
    expect(mount.container.textContent).not.toContain("list.delete_success");
    expect(listGetCount()).toBe(before);
    expect(mount.container.textContent).toContain(ITEM.name);
  });
});

describe("新建与重命名的接线", () => {
  // 空名称被 schema 拦下：校验失败时**不发请求**（服务端也要求 name 非空，白跑一次不如就地拦下）。
  test("名称为空时提交被拦下，不发创建请求", async () => {
    await mount.render(page());
    await click(buttonByText("list.create"));

    await click(byTestId("form-submit"));

    expect(callTo("/web/workflow-v2/workflows", "POST")).toBeUndefined();
    expect(navigations).toEqual([]);
  });

  test("新建提交请求体，成功后进入该工作流的画布", async () => {
    await mount.render(page());
    await click(buttonByText("list.create"));

    await fill({ name: "新流程", desc: "描述" });
    await click(byTestId("form-submit"));

    expect(callTo("/web/workflow-v2/workflows", "POST")?.body).toEqual({ name: "新流程", desc: "描述" });
    // 深链参数是上游 workflow ID（票据与画布 URL 都以它为准，见 api/workflows.ts 的类型注释）。
    expect(navigations).toEqual([{ to: "/agent/workflow/$id/edit", params: { id: "upstream-wf-new" } }]);
  });

  // 重命名必须预填当前名称：空白表单会让用户以为要重新输入，而提交空名称会被 schema 拦下。
  test("重命名以当前名称为默认值提交，成功后刷新列表", async () => {
    await mount.render(page());
    await click(buttonByText("list.rename"));

    expect(inputById("workflow-rename-name").value).toBe(ITEM.name);

    await fill({ name: "改名后的流程" });
    await click(byTestId("form-submit"));

    const patch = callTo("/web/workflow-v2/workflows/wf-local-1", "PATCH");
    expect(patch?.body).toEqual({ name: "改名后的流程" });
    expect(listGetCount()).toBe(2);
  });

  test("打开画布入口指向该行的上游 workflow ID", async () => {
    await mount.render(page());
    const link = mount.container.querySelector("a");
    expect(link?.getAttribute("href")).toBe("/agent/workflow/upstream-wf-1/edit");
  });
});
