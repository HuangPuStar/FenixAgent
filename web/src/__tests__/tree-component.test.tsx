import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => {
      const map: Record<string, string> = {
        "tree.showMore": `+${params?.count ?? 0} more`,
        "tree.loading": "Loading...",
        "tree.loadError": "Failed to load",
        "tree.retry": "Retry",
        "tree.empty": "No items",
      };
      return map[key] ?? key;
    },
  }),
}));

mock.module("../../src/i18n", () => ({
  NS: { COMPONENTS: "components" },
}));

// 模块导出完整性
describe("Tree component exports", () => {
  test("Tree module exports all expected components", async () => {
    const mod = await import("../../components/ui/tree");
    expect(typeof mod.Tree).toBe("function");
    expect(typeof mod.TreeItem).toBe("function");
    expect(typeof mod.TreeItemContent).toBe("function");
    expect(typeof mod.TreeItemGroup).toBe("function");
  });
});

// TreeItem 直接渲染（通过 children prop + nodeData 绕过异步加载）
describe("TreeItem rendering", () => {
  test("TreeItem renders label and badge from nodeData", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const getChildren = async () => [];

    const html = renderToStaticMarkup(
      <Tree getChildren={getChildren}>
        <TreeItem nodeId="x" nodeData={{ id: "x", label: "Labeled", hasChildren: false, badge: 5 }} />
      </Tree>,
    );

    expect(html).toContain("Labeled");
    expect(html).toContain("5");
  });

  test("TreeItem renders description when provided", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const getChildren = async () => [];

    const html = renderToStaticMarkup(
      <Tree getChildren={getChildren}>
        <TreeItem nodeId="d" nodeData={{ id: "d", label: "Main", hasChildren: false, description: "sub text" }} />
      </Tree>,
    );

    expect(html).toContain("Main");
    expect(html).toContain("sub text");
  });

  test("TreeItem with isDisabled applies opacity class", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const getChildren = async () => [];

    const html = renderToStaticMarkup(
      <Tree getChildren={getChildren}>
        <TreeItem nodeId="dis" nodeData={{ id: "dis", label: "Disabled", hasChildren: false, isDisabled: true }} />
      </Tree>,
    );

    expect(html).toContain("opacity-50");
  });

  test("TreeItem renders custom actions via renderActions", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const getChildren = async () => [];

    const html = renderToStaticMarkup(
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

  test("TreeItem renders icon when provided", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const TestIcon = ({ className }: { className?: string }) =>
      `<svg class="${className}" data-testid="icon" />` as unknown as React.ReactElement;

    const getChildren = async () => [];

    const html = renderToStaticMarkup(
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

  test("TreeItem renders selected state via selectedId", async () => {
    const { Tree, TreeItem } = await import("../../components/ui/tree");

    const getChildren = async () => [];

    const html = renderToStaticMarkup(
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
  test("TreeItemContent renders children", async () => {
    const { TreeItemContent } = await import("../../components/ui/tree");
    const html = renderToStaticMarkup(<TreeItemContent>Hello</TreeItemContent>);
    expect(html).toContain("Hello");
    expect(html).toContain('data-slot="tree-item-content"');
  });

  test("TreeItemGroup renders children", async () => {
    const { TreeItemGroup } = await import("../../components/ui/tree");
    const html = renderToStaticMarkup(<TreeItemGroup>Group</TreeItemGroup>);
    expect(html).toContain("Group");
    expect(html).toContain('data-slot="tree-item-group"');
  });
});
