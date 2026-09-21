// Tree 组件的服务端渲染测试（CE 阶段 2 §1.6 T10b3 从 `apps/web/src/__tests__/tree-component.test.tsx`
// 迁入包内：用例守卫的 `ui/tree` 与 `ui/internal/tree-item-parts` 的 owner 已是本包，实现侧不存在任何
// 宿主依赖，留在宿主只会让「包内实现被应用壳测试守护」）。
//
// 迁移改动（用例名与中文注释逐字保留，只改断言之外的引导方式）：
// - 被测模块的导入已是包名自引用（T8c 改指时写入），无需改写。
// - i18n 从 `mock.module("react-i18next", …)` 替身换成包内字典经 `I18nextProvider` 注入，与
//   `message.ssr.test.tsx` 同一约定。两处原因：①「测试文件禁止直接调用 `mock.module()`」（CLAUDE.md）；
//   ② 实测 `mock.module` 会跨文件泄漏——本文件迁入本包后与 `message.ssr.test.tsx`、`chat-composer.test.tsx`
//   同进程求值，`afterEach` 的 `mock.restore()` 挡不住已经拿到替身绑定的模块，14 条 i18n 断言随即退化成
//   回显 key（`chat.components.composerAssets.quoteNumber`）。改真字典后两处都消解。
// - 原先对宿主 `@/src/i18n` 的替身一并删除：`ui/tree` 只依赖包内 `web/i18n/namespace`，包内不存在该导入方，
//   属宿主副本时代（T8a 之前）的残留。

import { describe, expect, test } from "bun:test";
import { createInstance, type i18n as I18nInstance } from "i18next";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { initReactI18next } from "react-i18next/initReactI18next";
import en from "../i18n/locales/en/uiComponents.json";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { Tree, TreeItem, TreeItemContent, TreeItemGroup } from "../ui/tree";

const i18n: I18nInstance = createInstance();
void i18n.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  ns: [UI_COMPONENTS_NS],
  defaultNS: UI_COMPONENTS_NS,
  initAsync: false,
  interpolation: { escapeValue: false },
  resources: { en: { [UI_COMPONENTS_NS]: en } },
});

/**
 * 统一引导：组件经 `useTranslation` 读包内命名空间，故每次渲染都包一层 `I18nextProvider`。
 * 刻意不用「`initReactI18next` 注册全局实例」的写法：那会把本文件的字典泄漏给同进程的其它用例文件
 * （与上面那条 `mock.module` 泄漏同一类风险），Provider 的作用域只覆盖本次渲染。
 */
function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>);
}

// 模块导出完整性
describe("Tree component exports", () => {
  test("Tree module exports all expected components", () => {
    expect(typeof Tree).toBe("function");
    expect(typeof TreeItem).toBe("function");
    expect(typeof TreeItemContent).toBe("function");
    expect(typeof TreeItemGroup).toBe("function");
  });
});

// TreeItem 直接渲染（通过 children prop + nodeData 绕过异步加载）
describe("TreeItem rendering", () => {
  test("TreeItem renders label and badge from nodeData", () => {
    const getChildren = async () => [];

    const html = render(
      <Tree getChildren={getChildren}>
        <TreeItem nodeId="x" nodeData={{ id: "x", label: "Labeled", hasChildren: false, badge: 5 }} />
      </Tree>,
    );

    expect(html).toContain("Labeled");
    expect(html).toContain("5");
  });

  test("TreeItem renders description when provided", () => {
    const getChildren = async () => [];

    const html = render(
      <Tree getChildren={getChildren}>
        <TreeItem nodeId="d" nodeData={{ id: "d", label: "Main", hasChildren: false, description: "sub text" }} />
      </Tree>,
    );

    expect(html).toContain("Main");
    expect(html).toContain("sub text");
  });

  test("TreeItem with isDisabled applies opacity class", () => {
    const getChildren = async () => [];

    const html = render(
      <Tree getChildren={getChildren}>
        <TreeItem nodeId="dis" nodeData={{ id: "dis", label: "Disabled", hasChildren: false, isDisabled: true }} />
      </Tree>,
    );

    expect(html).toContain("opacity-50");
  });

  test("TreeItem renders custom actions via renderActions", () => {
    const getChildren = async () => [];

    const html = render(
      <Tree getChildren={getChildren}>
        <TreeItem
          nodeId="a"
          nodeData={{ id: "a", label: "Action Item", hasChildren: false }}
          renderActions={(node) => <span>Action-{node.id}</span>}
        />
      </Tree>,
    );

    expect(html).toContain("Action-a");
  });

  // 节点全名提示使用统一 Tooltip，避免每个节点创建 fixed 浮层造成滚动重影。
  test("TreeItem uses the shared tooltip instead of a fixed hover layer", () => {
    const html = render(
      <Tree getChildren={async () => []}>
        <TreeItem
          nodeId="tooltip-node"
          nodeData={{ id: "tooltip-node", label: "Long file name", hasChildren: false }}
        />
      </Tree>,
    );

    expect(html).toContain("tooltip-trigger");
    expect(html).not.toContain("position:fixed");
  });
  test("TreeItem renders icon when provided", () => {
    const TestIcon = ({ className }: { className?: string }) =>
      `<svg class="${className}" data-testid="icon" />` as unknown as React.ReactElement;

    const getChildren = async () => [];

    const html = render(
      <Tree getChildren={getChildren}>
        <TreeItem
          nodeId="icon-node"
          nodeData={{ id: "icon-node", label: "With Icon", hasChildren: false, icon: TestIcon }}
        />
      </Tree>,
    );

    expect(html).toContain("With Icon");
    expect(html).toContain("data-testid");
  });

  test("TreeItem renders selected state via selectedId", () => {
    const getChildren = async () => [];

    const html = render(
      <Tree getChildren={getChildren} selectedId="sel">
        <TreeItem nodeId="sel" nodeData={{ id: "sel", label: "Selected", hasChildren: false }} />
      </Tree>,
    );

    expect(html).toContain("bg-accent");
    expect(html).toContain("Selected");
  });
});

// TreeItemContent 和 TreeItemGroup
describe("Tree sub-components", () => {
  test("TreeItemContent renders children", () => {
    const html = render(<TreeItemContent>Hello</TreeItemContent>);
    expect(html).toContain("Hello");
    expect(html).toContain('data-slot="tree-item-content"');
  });

  test("TreeItemGroup renders children", () => {
    const html = render(<TreeItemGroup>Group</TreeItemGroup>);
    expect(html).toContain("Group");
    expect(html).toContain('data-slot="tree-item-group"');
  });
});
