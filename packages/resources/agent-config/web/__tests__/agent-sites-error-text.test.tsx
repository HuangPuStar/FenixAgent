// web/__tests__/agent-sites-error-text.test.tsx
// 守护站点目录失败态的**文案来源**：`EmptyState` 的说明必须取 `error.message`，即 `unwrap()` 抛出的
// `ApiError.message`（后端错误信封原文）。
//
// 为什么必须钉住：`AgentSitesPage` 用 `unwrap()` 取列表，只上屏固定字典文案会把后端故障在接口侧屏蔽
// 掉——用户与测试都拿不到服务端给出的原因（2026-10-12 回滚「错误文案收口」后确立的口径）。这里同时钉住
// 失败块仍可恢复：说明与后端原文一起出现，`role="alert"` 与重试入口不因错误来源变化而失效。
//
// 为什么用真实渲染 + 真实 i18next：被钉住的行为是「原始 message 出现在渲染结果里」+「失败块仍是可恢复的
// `role="alert"` + 重试」，两者都取决于分支顺序与最终落到哪个元素。`siteDeployment.*` 的键随台账 D4 从宿主
// `agentPanel` 字典迁入本包 `agents`（消费方即本包页面），因此此处直接按本包命名空间声明夹具资源：断言的是
// 接线（说明取 error.message），文案本身由夹具给。
//
// 不用 `mock.module`：本包 `src/__tests__/agent-config-source-migration.test.ts` 的「包内测试不直接
// mock 模块」是零容忍守卫（CLAUDE.md 测试红线），替身一律走真实库或平台 `/testing`。

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import i18next from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next";
import { AGENTS_NS } from "../i18n/namespace";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const originalGlobals = new Map(["window", "document", "navigator"].map((key) => [key, globals[key]]));
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;

/** 服务端原始异常文本：它必须出现在失败块的说明里，同时另有一份进 `AgentSitesPage` 的 `console.error`。 */
const RAW_SERVER_MESSAGE = 'relation "site_app" does not exist (hint: run migrations)';

await i18next.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  ns: [AGENTS_NS],
  defaultNS: AGENTS_NS,
  resources: {
    zh: {
      [AGENTS_NS]: {
        siteDeployment: {
          title: "站点部署",
          subtitle: "把智能体发布成可访问的应用",
          actions: { retry: "重试" },
          errors: { load: "应用列表加载失败" },
        },
      },
    },
  },
});

const { AgentSitesCatalog } = await import("../pages/agent-panel/pages/agent-sites-catalog");

let container: HTMLElement;
let root: Root;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

afterAll(() => {
  for (const [key, value] of originalGlobals) {
    if (value === undefined) delete globals[key];
    else globals[key] = value;
  }
});

/** 挂载并渲染；用例只有一条，挂载细节留在函数里，不引入 beforeEach。 */
function renderCatalog(node: ReactElement): void {
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  act(() => {
    root.render(node);
  });
}

/** 目录页的全部回调在失败态下都不该被触发，这里只提供占位实现。 */
const noop = () => {};

describe("站点目录失败态的文案来源", () => {
  // 失败块必须停住（`role="alert"` + 可执行提示 + 重试），且说明里能看到服务端原始 message：
  // 只上屏固定文案会让后端故障在界面与测试里同时消失（2026-10-12 口径）
  test("失败块回显 error.message，并保留 role=alert 与重试入口", () => {
    renderCatalog(
      createElement(AgentSitesCatalog, {
        apps: [],
        loading: false,
        error: new Error(RAW_SERVER_MESSAGE),
        query: "",
        visibility: "all",
        page: 1,
        totalPages: 1,
        onQueryChange: noop,
        onVisibilityChange: noop,
        onPageChange: noop,
        onCreate: noop,
        onEdit: noop,
        onDelete: noop,
        onRotateToken: noop,
        onCreatorOpen: noop,
        onRetry: noop,
      }),
    );

    const text = container.textContent ?? "";
    // 标题仍取字典键：i18n 命中时渲染译文，未命中时回显键本身。**断言不能依赖命中状态**
    // ——`bun test packages/` 在同一进程内跑完全部文件，同进程别处对 `react-i18next` 的模块替身会
    // 让本文件的 `t()` 也退回键回显（2026-09-23 实测：单独跑本文件渲染译文，跑整包渲染键）。
    expect(text).toMatch(/siteDeployment\.errors\.load|应用列表加载失败/);
    // 说明必须是服务端信封原文：任何 i18n 状态下它都该原样出现
    expect(text).toContain(RAW_SERVER_MESSAGE);
    // 失败仍是可恢复的持久态：`role="alert"` + 重试入口
    expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(text).toMatch(/siteDeployment\.actions\.retry|重试/);
  });
});
