// web/__tests__/agent-sites-error-text.test.tsx
// 守护站点目录失败态的**文案来源**：`EmptyState` 的说明只能取 `agentPanel` 命名空间的键，不得回显
// `error.message`。
//
// 为什么必须钉住：`AgentSitesPage` 用 `unwrap()` 取列表，抛出的 `ApiError.message` 就是后端错误信封
// 的原文（服务端措辞、SQL 片段、内部路径都可能出现）。改动前这里写的是
// `description={props.error.message}`，于是标题已经是「应用列表加载失败」，说明又把后端实现细节铺了
// 一层——用户读到的是别人系统的内部措辞（§9.3「未知错误使用安全通用文案，不展示 raw message」）。
//
// 为什么用真实渲染 + 真实 i18next：被钉住的行为是「原始 message 不出现在渲染结果里」+「失败块仍是
// 可恢复的 `role="alert"` + 重试」，两者都取决于分支顺序与最终落到哪个元素。`siteDeployment.*` 的键
// 落在宿主字典（agentPanel 命名空间由宿主登记，见 §9.2 的跨包裁定），包内测试不读宿主文件，因此
// 用**本文件自带的资源**初始化真实的 i18next 单例：断言的是接线（说明取哪个键、不取 error.message），
// 文案本身由夹具给。
//
// 不用 `mock.module`：本包 `src/__tests__/agent-config-source-migration.test.ts` 的「包内测试不直接
// mock 模块」是零容忍守卫（CLAUDE.md 测试红线），替身一律走真实库或平台 `/testing`。

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { NS } from "@fenix/web-runtime/i18n/namespace";
import { Window } from "happy-dom";
import i18next from "i18next";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const originalGlobals = new Map(["window", "document", "navigator"].map((key) => [key, globals[key]]));
globals.window = win;
globals.document = win.document;
globals.navigator = win.navigator;

/** 服务端原始异常文本：正常渲染路径下它只该出现在 `AgentSitesPage` 的 `console.error` 里。 */
const RAW_SERVER_MESSAGE = 'relation "site_app" does not exist (hint: run migrations)';

await i18next.use(initReactI18next).init({
  lng: "zh",
  fallbackLng: "zh",
  ns: [NS.AGENT_PANEL],
  defaultNS: NS.AGENT_PANEL,
  resources: {
    zh: {
      [NS.AGENT_PANEL]: {
        siteDeployment: {
          title: "站点部署",
          subtitle: "把智能体发布成可访问的应用",
          actions: { retry: "重试" },
          errors: {
            load: "应用列表加载失败",
            loadHint: "请重试；若持续失败，请联系组织管理员。",
          },
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
  // 失败块必须停住（`role="alert"` + 可执行提示 + 重试），且说明文案只来自字典：
  // 后端信封原文出现在界面上等于把服务端内部措辞透给用户（§9.3）
  test("失败块不回显 error.message，只上屏字典文案并保留重试入口", () => {
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
    // 标题与说明槽位取的都是字典键：i18n 命中时渲染译文，未命中时回显键本身。**断言不能依赖命中状态**
    // ——`bun test packages/` 在同一进程内跑完全部文件，同进程别处对 `react-i18next` 的模块替身会
    // 让本文件的 `t()` 也退回键回显（2026-09-23 实测：单独跑本文件渲染译文，跑整包渲染键）。
    expect(text).toMatch(/siteDeployment\.errors\.loadHint|请重试；若持续失败，请联系组织管理员。/);
    expect(text).toMatch(/siteDeployment\.errors\.load|应用列表加载失败/);
    // 而服务端原始 message 在任何一种 i18n 状态下都不该出现：它只能进 `AgentSitesPage` 的
    // `console.error`（§9.3）
    expect(text).not.toContain(RAW_SERVER_MESSAGE);
    expect(text).not.toContain("relation");
    // 失败仍是可恢复的持久态：`role="alert"` + 重试入口
    expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(text).toMatch(/siteDeployment\.actions\.retry|重试/);
  });
});
