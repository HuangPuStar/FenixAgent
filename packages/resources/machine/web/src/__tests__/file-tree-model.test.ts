// W2.5：文件树模型（解析 / 过滤 / 分区）的宿主实现已上收到 `@fenix/ui-components`，本包经对方**包根入口**
// 取用——该模型的公开出口只有根 barrel，`web/components/file-tree-model` 这类深路径不在 exports 里
// （实测 `ResolveMessage: Cannot find module`），因此不得写成深路径；也不再以六级相对路径穿透到
// `apps/web`（见 §1 静态条件 3）。
import { describe, expect, test } from "bun:test";
import { filterFileTree, parsePathsToTree, splitFileTreeSections } from "@fenix/ui-components";

describe("file-tree-model", () => {
  // 搜索命中文件时保留完整祖先链，确保结果仍能在树中定位。
  test("preserves parent folders for matching files", () => {
    const tree = parsePathsToTree(["docs/guide.md", "user/brief.md", "web/main.tsx"]);
    const result = filterFileTree(tree, "brief");

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("user");
    expect(result[0].children.map((node) => node.path)).toEqual(["user/brief.md"]);
  });

  // 文件树解析只生成 workspace 相对路径，不为 user 区伪造绝对根路径。
  test("keeps the user area workspace-relative", () => {
    const tree = parsePathsToTree(["user/reference.png", "docs/"]);
    const user = tree.find((node) => node.path === "user");

    expect(user?.isDir).toBe(true);
    expect(user?.children[0].path).toBe("user/reference.png");
    expect(user?.children[0].path.startsWith("/")).toBe(false);
  });

  // 空工作区也要保留受控的用户文件分区，避免新建文件入口随数据有无跳变。
  test("keeps an empty user area visible", () => {
    const tree = parsePathsToTree([]);

    expect(tree).toEqual([{ name: "user", path: "user", isDir: true, children: [] }]);
  });

  // 用户区只移除重复的展示根节点，文件操作仍必须使用受服务端校验的 user 相对路径。
  test("projects user children without losing their workspace-relative paths", () => {
    const tree = parsePathsToTree(["docs/guide.md", "user/references/brief.md", "user/logo.png"]);
    const sections = splitFileTreeSections(tree);

    expect(sections.workspace.map((node) => node.path)).toEqual(["docs"]);
    expect(sections.user.map((node) => node.path)).toEqual(["user/references", "user/logo.png"]);
    expect(sections.user.some((node) => node.path === "user")).toBe(false);
  });
});
