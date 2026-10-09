// web/__tests__/ui-spec-render.test.tsx
// `ui-spec` 渲染层的行为守卫（计划 §5.4 第 4 项）：正常 Spec、未知类型占位、坏输入原文降级、
// DOM 文本安全、官方容器锚点、宿主上下文隔离与「无请求」，外加 L4 错误边界（块内抛错落占位与原文、
// `code` 变化后重置恢复）。
//
// 口径说明：
// - 直接渲染 `UISpecBlock`（streamdown renderer 的入参形状），**不**经 streamdown 的围栏分派 ——
//   围栏分派、闭合/未闭合与同一实例的生命周期组合由 streaming 用例覆盖（§3.1），这里只验本层行为。
// - DOM 断言用 happy-dom + `createRoot`（不 mock renderer 分派），与 `message-bubble-copy.test.tsx`
//   同一套骨架；DOM 全局与 `HTMLElement` / `customElements` **成对**注入并在结束时还原，避免泄漏给
//   同进程后续文件（理由见 `web/testing.ts` 的记录）。
// - 文案断言与字典解耦：字典键由公共出口 owner 统一新增，这里用**同一个 i18n 实例算出期望值**再比对
//   DOM，既钉住「用了哪个键、插值了哪个字段」，也不因字典尚未落地而假红（键集完整性由
//   `i18n-barrel.test.ts` 负责）。

import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { initializeHappyDomWindow } from "@fenix/ui-components/testing";
import { Window } from "happy-dom";
import { createInstance } from "i18next";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { initReactI18next } from "react-i18next/initReactI18next";
import { type UISpecRegistryProps, uiSpecRegistry } from "../chat/ui-spec/registry";
import { UI_SPEC_LIMITS } from "../chat/ui-spec/spec";
import { UISpecBlock } from "../chat/ui-spec/UISpecBlock";
import { UISpecHostProvider, useUISpecHost } from "../chat/ui-spec/UISpecHostContext";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";

const win = initializeHappyDomWindow(new Window());
const globals = globalThis as Record<string, unknown>;
const savedGlobals: Record<string, unknown> = {};

const i18n = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

beforeAll(() => {
  for (const key of [
    "window",
    "document",
    "navigator",
    "HTMLElement",
    "customElements",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "IS_REACT_ACT_ENVIRONMENT",
  ]) {
    savedGlobals[key] = globals[key];
  }
  globals.window = win;
  globals.document = win.document;
  globals.navigator = win.navigator;
  globals.HTMLElement = win.HTMLElement;
  globals.customElements = win.customElements;
  globals.requestAnimationFrame = win.requestAnimationFrame.bind(win);
  globals.cancelAnimationFrame = win.cancelAnimationFrame.bind(win);
  globals.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  for (const [key, value] of Object.entries(savedGlobals)) globals[key] = value;
  win.document.body.replaceChildren();
});

interface Harness {
  host: HTMLElement;
  root: Root;
}

const mounted: Harness[] = [];

/** 逐个事件循环推进，让惰性模块（官方容器 / 骨架、`UISpecView`）有机会落地。 */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** 等某个标记出现再断言：容器与组件树都是懒加载的，同步渲染只会拿到 Suspense 兜底。 */
async function waitFor(host: HTMLElement, selector: string): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const found = host.querySelector(selector);
    if (found) return found as HTMLElement;
    await flush();
  }
  throw new Error(`等待 ${selector} 超时（惰性模块未落地）`);
}

/** 在自有宿主元素上建 root；`isIncomplete` 对应 streamdown 传给 renderer 的同名字段。 */
function createHarness(): Harness {
  const host = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(host as unknown as Parameters<typeof win.document.body.appendChild>[0]);
  const harness = { host, root: createRoot(host) };
  mounted.push(harness);
  return harness;
}

/** 挂载一块 ui-spec 正文。 */
async function mount(code: string, isIncomplete = false): Promise<Harness> {
  const harness = createHarness();
  await act(async () => {
    harness.root.render(<UISpecBlock code={code} isIncomplete={isIncomplete} language="ui-spec" />);
  });
  return harness;
}

/** 同一实例更新（§3.1 要求的状态切换只能在同一个 root 上观测）。 */
async function update(harness: Harness, code: string, isIncomplete = false): Promise<void> {
  await act(async () => {
    harness.root.render(<UISpecBlock code={code} isIncomplete={isIncomplete} language="ui-spec" />);
  });
}

/** 围栏正文的最小构造器：拼出合法 JSON，避免用例里手写转义。 */
function specCode(spec: unknown): string {
  return JSON.stringify(spec, null, 2);
}

const VALID_SPEC = {
  version: 1,
  root: "root",
  elements: {
    root: { type: "Stack", props: { gap: "sm" }, children: ["title", "table"] },
    title: { type: "Text", props: { text: "部署摘要", tone: "muted" } },
    table: {
      type: "Table",
      props: {
        caption: "明细",
        columns: ["名称", "数量"],
        rows: [
          ["甲", "1"],
          ["乙", "2"],
        ],
        align: ["left", "right"],
      },
    },
  },
};

/** 期望文案：与组件读同一本字典、同一个键与插值字段。 */
const expectedText = (key: string, options?: Record<string, unknown>) => String(i18n.t(key, options));

describe("ui-spec 渲染层", () => {
  afterEach(() => {
    while (mounted.length > 0) {
      const harness = mounted.pop() as Harness;
      act(() => harness.root.unmount());
      harness.host.remove();
    }
    win.document.body.replaceChildren();
  });

  // 正常路径：Stack / Text / Table 三类型都要真的出内容，而不是只吐容器壳。
  test("合法 Spec 渲染出自有组件：Stack 间距、Text 文案、Table 表头与单元格、列对齐", async () => {
    const harness = await mount(specCode(VALID_SPEC));
    const stack = await waitFor(harness.host, '[data-slot="ui-spec-stack"]');

    expect(stack.className).toContain("gap-2");
    expect(harness.host.querySelector('[data-slot="ui-spec-text"]')?.textContent).toBe("部署摘要");
    expect(harness.host.querySelector('[data-slot="ui-spec-text"]')?.className).toContain("text-muted-foreground");

    const table = await waitFor(harness.host, '[data-slot="ui-spec-table"]');
    // 宽表滚动容器来自既有 `web/ui/table.tsx` 原语，不冒用 streamdown 的表格属性。
    expect(table.querySelector('[data-slot="table-container"]')).not.toBeNull();
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["名称", "数量"]);
    expect([...table.querySelectorAll("tbody td")].map((cell) => cell.textContent)).toEqual(["甲", "1", "乙", "2"]);
    expect([...table.querySelectorAll("tbody td")].map((cell) => cell.getAttribute("data-align"))).toEqual([
      "left",
      "right",
      "left",
      "right",
    ]);
    expect(table.querySelector("caption")?.textContent).toBe("明细");
  });

  // 未知 type：该元素原地占位并显示受限类型名，兄弟节点继续渲染（§1.5 L3 目录）。
  test("未知 type 就地占位（不渲染其子树），兄弟节点继续渲染", async () => {
    const harness = await mount(
      specCode({
        version: 1,
        root: "root",
        elements: {
          root: { type: "Stack", props: { gap: "md" }, children: ["known", "unknown"] },
          known: { type: "Text", props: { text: "兄弟还在" } },
          unknown: { type: "Metric", props: { series: [1] }, children: ["hidden"] },
          hidden: { type: "Text", props: { text: "不该出现" } },
        },
      }),
    );

    const placeholder = await waitFor(harness.host, '[data-slot="ui-spec-placeholder"]');
    expect(placeholder.textContent).toBe(expectedText("chat.components.uiSpec.unsupportedType", { type: "Metric" }));
    // 占位不渲染子树，也不吞掉兄弟。
    expect(placeholder.querySelector("*")).toBeNull();
    expect(harness.host.querySelector('[data-slot="ui-spec-text"]')?.textContent).toBe("兄弟还在");
    expect(harness.host.textContent).not.toContain("不该出现");
  });

  // 坏输入：整块降级为原文 pre，原文逐字保留（可复制、不截断，不假装成完整 UI）。
  test("半截 JSON 整块降级为原文 pre，且不产出任何组件", async () => {
    const code = '{"version":1,"root":"root","elements":{"root":{"type":"Stack"';
    const harness = await mount(code);
    const raw = await waitFor(harness.host, '[data-slot="ui-spec-raw"]');

    expect(raw.querySelector("pre")?.textContent).toBe(code);
    expect(harness.host.querySelector('[data-slot="ui-spec-stack"]')).toBeNull();
    expect(harness.host.querySelector('[data-slot="ui-spec-placeholder"]')).toBeNull();
  });

  // 安全（§1.7）：Spec 字符串一律是文本节点，绝不能变成元素或事件属性。
  test("<script> / <img onerror> 一类正文只作文本节点，不生成元素", async () => {
    const payload = '<script>alert(1)</script><img src=x onerror="alert(2)">';
    const harness = await mount(
      specCode({ version: 1, root: "root", elements: { root: { type: "Text", props: { text: payload } } } }),
    );
    const text = await waitFor(harness.host, '[data-slot="ui-spec-text"]');

    expect(text.textContent).toBe(payload);
    expect(harness.host.querySelector("script")).toBeNull();
    expect(harness.host.querySelector("img")).toBeNull();
    expect(harness.host.querySelector("[onerror]")).toBeNull();
    expect(harness.host.innerHTML).not.toContain("<script");
  });

  // 容器锚点（§1.6）：四种正文都挂在 streamdown 官方容器里，宿主伴生 CSS 才吃得到。
  test("每个形态都挂在官方容器锚点内（data-streamdown=code-block + 标题 + data-language）", async () => {
    const okHarness = await mount(specCode(VALID_SPEC));
    const okContainer = await waitFor(okHarness.host, '[data-streamdown="code-block"]');

    expect(okContainer.getAttribute("data-slot")).toBe("ui-spec-block");
    expect(okContainer.getAttribute("data-language")).toBe("ui-spec");
    expect(okContainer.getAttribute("data-incomplete")).toBeNull();
    // 组件态打状态标记：伴随表据此关闭代码块外壳（边框 / 底色 / 圆角）
    expect(okContainer.getAttribute("data-ui-spec-state")).toBe("ready");
    expect(okContainer.querySelector('[data-streamdown="code-block-header"]')).not.toBeNull();
    expect(okContainer.querySelector('[data-slot="ui-spec-stack"]')).not.toBeNull();

    const badHarness = await mount("not json at all");
    const badContainer = await waitFor(badHarness.host, '[data-streamdown="code-block"]');

    expect(badContainer.querySelector('[data-slot="ui-spec-raw"]')).not.toBeNull();
    // 降级态保持代码块外观：不出现 ready 标记
    expect(badContainer.getAttribute("data-ui-spec-state")).toBeNull();
  });

  // 宿主上下文（§1.2）：envId 由宿主注入，两个 Provider 相互隔离，Spec 改不动它。
  test("envId 由宿主上下文注入：两个 Provider 互不串台，Spec 的 envId/style 字段只导致占位", async () => {
    function HostProbe() {
      const { envId } = useUISpecHost();
      return <span data-slot="host-probe">{envId ?? "none"}</span>;
    }

    const harness = createHarness();
    const spec = specCode({
      version: 1,
      root: "root",
      elements: { root: { type: "Text", props: { text: "正文", envId: "attacker", style: "color:red" } } },
    });

    await act(async () => {
      harness.root.render(
        <>
          <UISpecHostProvider value={{ envId: "env-a" }}>
            <HostProbe />
            <UISpecBlock code={spec} isIncomplete={false} language="ui-spec" />
          </UISpecHostProvider>
          <UISpecHostProvider value={{ envId: "env-b" }}>
            <HostProbe />
          </UISpecHostProvider>
        </>,
      );
    });

    const probes = [...harness.host.querySelectorAll('[data-slot="host-probe"]')];
    expect(probes.map((probe) => probe.textContent)).toEqual(["env-a", "env-b"]);

    // `Text` 的 props 被 `strictObject` 判为非法（多出 envId/style）→ 该元素占位，字段不落到 DOM。
    const placeholder = await waitFor(harness.host, '[data-slot="ui-spec-placeholder"]');
    expect(placeholder.textContent).toBe(expectedText("chat.components.uiSpec.invalidProps", { type: "Text" }));
    expect(harness.host.querySelector('[data-slot="ui-spec-text"]')).toBeNull();
    expect(placeholder.getAttribute("style")).toBeNull();
    expect(placeholder.getAttribute("envId")).toBeNull();
  });

  // 零请求与零资源元素（§1.7）：正文里的 URL / 图片片段不得触发任何取数或元素创建。
  test("渲染不发请求、不创建图片或 iframe 元素", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    globalThis.fetch = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.reject(new Error("ui-spec 不得发请求"));
    }) as typeof fetch;

    try {
      const harness = await mount(
        specCode({
          version: 1,
          root: "root",
          elements: { root: { type: "Text", props: { text: "见 https://example.invalid/a.png 与 <img src=/x.png>" } } },
        }),
      );
      await waitFor(harness.host, '[data-slot="ui-spec-text"]');

      expect(calls).toHaveLength(0);
      expect(harness.host.querySelectorAll("img, iframe, script, link, source")).toHaveLength(0);
      // 资源属性同样一个都不该出现：`src` / `href` 是「元素自己发起取数」的另一条通路。
      expect(harness.host.querySelectorAll("[src], [href]")).toHaveLength(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // 未确认活跃（§3.1 规则 1）：首次挂载即使候选流式为真也先按当前正文解析，不盲等骨架。
  test("首次挂载 isIncomplete=true 也不挂骨架：半截 JSON 直接给原文", async () => {
    const code = '{"version":1,"root":"root","elements":';
    const harness = await mount(code, true);
    const raw = await waitFor(harness.host, '[data-slot="ui-spec-raw"]');

    expect(raw.querySelector("pre")?.textContent).toBe(code);
    expect(harness.host.querySelector('[data-slot="ui-spec-skeleton"]')).toBeNull();
  });

  // 增量 + 未闭合（§3.1 规则 1）：只有同一实例上观察到正文增量时才允许官方骨架。
  test("同一实例观察到正文增量且 isIncomplete=true 时挂官方骨架", async () => {
    const harness = await mount('{"version":1,"root":"root",');
    await waitFor(harness.host, '[data-slot="ui-spec-raw"]');

    await update(harness, '{"version":1,"root":"root","elements":{"root":', true);
    const skeleton = await waitFor(harness.host, '[data-slot="ui-spec-skeleton"]');

    expect(skeleton.closest('[data-streamdown="code-block"]')).not.toBeNull();
    // 伴随表的补偿选择器依赖官方骨架的固定形状：`[data-slot="ui-spec-skeleton"] > div > div:first-child` 即高度条。
    expect(skeleton.querySelector(":scope > div > div:first-child")).not.toBeNull();
    expect(harness.host.querySelector('[data-slot="ui-spec-raw"]')).toBeNull();
    expect(harness.host.querySelector('[data-streamdown="code-block"]')?.getAttribute("data-incomplete")).toBe("true");
  });

  // 骨架期间不解析（§1.5 L0 流式「官方 CodeBlockSkeleton，不解析」）：持续增量下既不能闪出原文，
  // 也不能随每个增量块重复整块解析 —— 后者的可观察后果就是每次新 code 都打一条 degraded 上报。
  test("骨架可见且正文持续增量时不解析：仍是骨架，且全程不产生 degraded 上报", async () => {
    const harness = await mount('{"version":1,"root":"root",');
    // 首帧没有增量 → 立即解析 → 原文（这一帧的上报发生在挂 spy 之前，不参与断言）。
    await waitFor(harness.host, '[data-slot="ui-spec-raw"]');

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(" "));
    };
    try {
      await update(harness, '{"version":1,"root":"root","elements":', true);
      await waitFor(harness.host, '[data-slot="ui-spec-skeleton"]');
      await update(harness, '{"version":1,"root":"root","elements":{', true);

      expect(harness.host.querySelector('[data-slot="ui-spec-skeleton"]')).not.toBeNull();
      expect(harness.host.querySelector('[data-slot="ui-spec-raw"]')).toBeNull();
      expect(warnings.filter((line) => line.includes("[ui-spec] degraded:"))).toEqual([]);
    } finally {
      console.warn = originalWarn;
    }
  });

  // L0 限额（§1.5）：超长正文不解析、不挂骨架，整块原文；载体仍是同一个官方容器。
  test("超长正文（> maxCodeChars）即使有增量也不挂骨架，整块原文", async () => {
    const harness = await mount(specCode(VALID_SPEC));
    await waitFor(harness.host, '[data-slot="ui-spec-stack"]');

    const oversized = `{"version":1,"root":"root","pad":"${"x".repeat(UI_SPEC_LIMITS.maxCodeChars)}"}`;
    await update(harness, oversized, true);

    const raw = await waitFor(harness.host, '[data-slot="ui-spec-raw"]');
    expect(raw.querySelector("pre")?.textContent).toBe(oversized);
    expect(harness.host.querySelector('[data-slot="ui-spec-skeleton"]')).toBeNull();
    expect(harness.host.querySelector('[data-slot="ui-spec-stack"]')).toBeNull();
  });

  // 版本降级（§1.5 L2）：整块「版本占位 + 原文」，占位文案带上原文里的实际版本号。
  test("version 不受支持：版本占位 + 原文，不渲染任何组件", async () => {
    const code = specCode({ ...VALID_SPEC, version: 2 });
    const harness = await mount(code);
    const raw = await waitFor(harness.host, '[data-slot="ui-spec-raw"]');

    expect(raw.textContent).toContain(expectedText("chat.components.uiSpec.unsupportedVersion", { version: 2 }));
    expect(raw.querySelector("pre")?.textContent).toBe(code);
    expect(harness.host.querySelector('[data-slot="ui-spec-stack"]')).toBeNull();
  });

  // L4 错误边界（§1.5）：块内子组件 render 抛错 → 整块占位（`renderFailed` 文案 + 原文 pre）→
  // `code` 变化即重置，不锁死。
  //
  // 触发方式：把真实注册表里 `Text` 的条目临时换成真实的抛错组件，其余环节（`UISpecBlock` → 懒模块
  // `UISpecView` → `resolveElement` → 注册表查表 → 组件 render）全部走真实分派路径，不 mock 任何模块；
  // 注入在 finally 里还原，避免泄漏给同进程后续文件。
  test("块内子组件 render 抛错：块级占位给文案与原文，code 变化后边界重置并恢复渲染", async () => {
    const registry = uiSpecRegistry as Map<string, ComponentType<UISpecRegistryProps>>;
    const originalTextEntry = registry.get("Text");
    function ThrowingText(): never {
      throw new Error("ui-spec 渲染层用例：注入的抛错子组件");
    }
    registry.set("Text", ThrowingText);

    try {
      const broken = specCode({
        version: 1,
        root: "root",
        elements: {
          root: { type: "Stack", props: { gap: "sm" }, children: ["leaf"] },
          leaf: { type: "Text", props: { text: "抛错的子组件" } },
        },
      });
      const harness = await mount(broken);
      // 等占位里的原文落地：Suspense 兜底同样带 `data-slot="ui-spec-block"`，直接等它会把空 div 当结果。
      await waitFor(harness.host, '[data-slot="ui-spec-raw"]');

      const block = harness.host.querySelector('[data-slot="ui-spec-block"]');
      expect(block).not.toBeNull();
      // 容器模块本身也可能是崩掉的那一环：占位不走官方容器（§1.5 L4）。
      expect(block?.getAttribute("data-streamdown")).toBeNull();
      expect(harness.host.querySelector('[data-streamdown="code-block"]')).toBeNull();
      expect(block?.textContent).toContain(expectedText("chat.components.uiSpec.renderFailed"));
      expect(block?.querySelector("pre")?.textContent).toBe(broken);
      // 抛错的是叶子，但降级粒度是**整块**：兄弟与父级都不保留。
      expect(harness.host.querySelector('[data-slot="ui-spec-stack"]')).toBeNull();

      // `code` 变化即重置：不重置的话边界会一直停在占位（锁死），恢复后的正文永远不出现。
      const recovered = specCode({
        version: 1,
        root: "root",
        elements: {
          root: { type: "Stack", props: { gap: "md" }, children: ["table"] },
          table: { type: "Table", props: { caption: "恢复后的正文", columns: ["名称"], rows: [["甲"]] } },
        },
      });
      await update(harness, recovered);
      await waitFor(harness.host, '[data-slot="ui-spec-stack"]');

      expect(harness.host.querySelector('[data-slot="ui-spec-raw"]')).toBeNull();
      expect(harness.host.textContent).not.toContain(expectedText("chat.components.uiSpec.renderFailed"));
      expect(harness.host.querySelector('[data-streamdown="code-block"]')).not.toBeNull();
      expect(harness.host.querySelector("caption")?.textContent).toBe("恢复后的正文");
    } finally {
      if (originalTextEntry === undefined) registry.delete("Text");
      else registry.set("Text", originalTextEntry);
    }
  });
});
