// web/__tests__/workflow-api-dialog.test.tsx
// 「调用接口」弹窗的关键行为：内容（地址 / 凭据 / 示例 / 参数）渲染正确，复制给的是**界面上显示的那段文本**，
// 复制成功与失败都有反馈，目标未确定时不渲染正文，且整个过程不发任何请求（纯静态内容）。
//
// 为什么必须真实渲染：地址由 `window.location.origin` + 本地主键拼出，复制走的是模态框专用的剪贴板原语（安全上下文
// 走 `navigator.clipboard`，非安全上下文退回「选中框内元素」），这些差别只有跑起来才看得见。
//
// 两处替身与环境注入（口径与同目录用例一致）：
//   - `@fenix/ui-components/ui/dialog`：Radix 弹窗内容在 happy-dom 下不挂载（portal 建好、内容为空），换成直通
//     替身把正文暴露出来；
//   - `navigator.clipboard`：把「写剪贴板」换成记录器，用例据此断言**复制内容**与成功/失败两条反馈分支；
//   - `react-i18next` 不替换：真实实例但 `resources: {}`，断言按 i18n 键回显做（字典完整性由
//     `workflow-v2-i18n.test.ts` 静态守护）。

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createInstance } from "i18next";
import { act, createElement, type ReactNode } from "react";
import { I18nextProvider } from "react-i18next";
import { type FetchRouter, installFetchRouter, mountCanvas, textOf, win } from "./canvas-host-harness";

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
  clipboardFails = false;
});

const { WorkflowApiDialog } = await import("../pages/list/workflow-api-dialog");

const i18n = createInstance();
void i18n.init({ lng: "zh", fallbackLng: "zh", initAsync: false, resources: {} });

/** 工作流夹具：本地主键进地址，名称进标题。 */
const WORKFLOW = { id: "9f1c2f9e-0d3a-4c6b-8f21-2a7b0f5c1d33", name: "客服问答流程" };

/** 剪贴板替身：记录写入内容；`clipboardFails` 为真时模拟写入被拒（非安全上下文或权限拒绝）。 */
const clipboardWrites: string[] = [];
let clipboardFails = false;

function injectClipboard(): void {
  const clipboard = {
    writeText: async (value: string) => {
      if (clipboardFails) throw new Error("clipboard denied");
      clipboardWrites.push(value);
    },
  };
  Object.defineProperty(win.navigator, "clipboard", { configurable: true, writable: true, value: clipboard });
  // happy-dom 不实现 `isSecureContext`（值为 undefined），而模态框剪贴板原语以它决定走 `navigator.clipboard`
  // 还是退回「选中元素 + execCommand」。这里显式声明为安全上下文，用例因此覆盖**主路径**；失败分支由
  // `clipboardFails` 驱动（此时退化路径在 happy-dom 下没有 `execCommand`，结果仍是失败）。
  Object.defineProperty(win, "isSecureContext", { configurable: true, writable: true, value: true });
}

let router: FetchRouter;
let mount: ReturnType<typeof mountCanvas>;

beforeEach(() => {
  clipboardWrites.length = 0;
  clipboardFails = false;
  injectClipboard();
  router = installFetchRouter(() => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "无请求预期" } } }));
  mount = mountCanvas();
});

afterEach(() => {
  mount.unmount();
  router.restore();
});

function dialog(workflowId: string | null = WORKFLOW.id) {
  return createElement(
    I18nextProvider,
    { i18n },
    createElement(WorkflowApiDialog, {
      open: true,
      onOpenChange: () => {},
      workflowId,
      workflowName: WORKFLOW.name,
    }),
  );
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await mount.flush();
}

/** 按 `aria-label` 取按钮（三处复制按钮共用同一段文案，只能靠标签区分）。 */
function copyButton(label: string): HTMLButtonElement {
  const button = mount.container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (button === null) throw new Error(`复制按钮未渲染：${label}`);
  return button;
}

describe("调用接口弹窗的内容", () => {
  // 地址、方法与凭据说明是用户真正要复制去用的三件事：地址必须带控制台 origin 与该工作流的本地主键，
  // 凭据只出现占位符（真实密钥永不进界面）。
  test("渲染调用地址、方法与凭据占位符", async () => {
    await mount.render(dialog());
    const text = textOf(mount.container);

    // 字典为空时 i18next 回显键本身且不插值，因此这里断言的是「标题走字典」而不是渲染出的中文标题
    // （与同目录用例同口径；键的完整性由 `workflow-v2-i18n.test.ts` 守护）。
    expect(text).toContain("api.title");
    expect(text).toContain(`${win.location.origin}/api/workflow-v2/workflows/${WORKFLOW.id}/run`);
    expect(text).toContain("POST");
    expect(text).toContain("Authorization: Bearer rcs_");
    // 地址里的 `:id` 是本地主键，上游 ID 不出现在界面上。
    expect(text).not.toContain("upstream-wf-1");
    // 纯静态内容：不发任何请求。
    expect(router.calls).toHaveLength(0);
  });

  // 示例默认展示同步调用：包含地址、占位密钥、`isAsync:false` 与最小可用入参（用户照抄即可跑通）。
  test("默认展示同步 curl 示例", async () => {
    await mount.render(dialog());
    const text = textOf(mount.container);

    expect(text).toContain("api.example_sync");
    expect(text).toContain("curl -X POST");
    expect(text).toContain(`/workflows/${WORKFLOW.id}/run'`);
    expect(text).toContain("Bearer rcs_");
    expect(text).toContain('{"parameters":{"input":"hello"},"isAsync":false}');
  });

  // 参数说明与示例同屏（平铺，不收进页签）：接入信息是照着写代码时对照着看的，三个字段名与参数边界说明
  // 必须在首屏渲染路径上。
  test("同屏展示参数说明与运行语义", async () => {
    await mount.render(dialog());
    const text = textOf(mount.container);

    expect(text).toContain("api.params_title");
    expect(text).toContain("parameters");
    expect(text).toContain("isAsync");
    expect(text).toContain("ext.user_id");
    expect(text).toContain("api.params_note");
    // 两种示例同样都在渲染路径上（用户不必先点开哪一段）。
    expect(text).toContain("api.example_sync");
    expect(text).toContain("api.example_async");
  });

  // 目标未确定（列表还没给出卡片）时不渲染正文：避免拿空主键拼出一个看起来可用的地址。
  test("目标为 null 时不渲染正文", async () => {
    await mount.render(dialog(null));
    const text = textOf(mount.container);

    expect(text).toContain("api.title");
    expect(text).not.toContain("/api/workflow-v2/workflows/");
  });
});

describe("调用接口弹窗的复制反馈", () => {
  // 复制地址：写入剪贴板的必须是界面显示的那一条地址，并给出成功反馈。
  test("复制调用地址写入剪贴板并提示成功", async () => {
    await mount.render(dialog());
    const url = `${win.location.origin}/api/workflow-v2/workflows/${WORKFLOW.id}/run`;

    await click(copyButton("api.copy_endpoint"));

    expect(clipboardWrites).toEqual([url]);
    expect(textOf(mount.container)).toContain("api.copied");
  });

  // 复制示例：写入的是同步示例全文（含地址与请求体），而不是地址或空串——两处内容不同，接错线很难被发现。
  test("复制同步示例写入完整 curl 文本", async () => {
    await mount.render(dialog());

    await click(copyButton("api.copy_example_sync"));

    expect(clipboardWrites).toHaveLength(1);
    expect(clipboardWrites[0]).toContain("curl -X POST");
    expect(clipboardWrites[0]).toContain('"isAsync":false');
    expect(textOf(mount.container)).toContain("api.copied");
  });

  // 复制失败必须有反馈：静默失败会让用户以为已经复制好了（HTTP 部署下这条路径是真实存在的）。
  test("剪贴板写入被拒时给出失败提示", async () => {
    clipboardFails = true;
    await mount.render(dialog());

    await click(copyButton("api.copy_endpoint"));

    const text = textOf(mount.container);
    expect(text).toContain("api.copy_failed");
    expect(text).not.toContain("api.copied");
  });
});
