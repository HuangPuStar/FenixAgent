/**
 * 文件树数据模型与纯函数（从 apps/web 的 `agent-panel/file-tree-model.ts` 复制并纯化）。
 *
 * 纯化取舍：源文件导出的 `MAX_FILE_UPLOAD_SIZE_LABEL` 依赖宿主的上传上限常量
 * （`@/src/api/fs` 的 `MAX_UPLOAD_SIZE_BYTES`），属业务配置，未随包迁移；
 * 需要该文案的宿主自行拼接。
 */

import type { TreeNodeData } from "../ui/tree";

export interface ParsedFileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ParsedFileNode[];
}

export interface FileTreeSections {
  workspace: ParsedFileNode[];
  user: ParsedFileNode[];
}

/**
 * 把扁平路径列表还原成树。
 *
 * 路径以 `/` 结尾表示目录；`user/` 这一层即使远端为空也保留，作为固定的用户文件入口
 * （源仓库的产品约定，模型层保留以免调用方各自补根节点）。
 */
export function parsePathsToTree(paths: string[]): ParsedFileNode[] {
  const root: ParsedFileNode[] = [{ name: "user", path: "user", isDir: true, children: [] }];
  for (const rawPath of paths) {
    const isDir = rawPath.endsWith("/");
    const cleanPath = isDir ? rawPath.slice(0, -1) : rawPath;
    const parts = cleanPath.split("/");
    let current = root;
    for (let index = 0; index < parts.length; index++) {
      const name = parts[index];
      const last = index === parts.length - 1;
      const path = parts.slice(0, index + 1).join("/");
      let node = current.find((candidate) => candidate.name === name);
      if (!node) {
        node = { name, path, isDir: last ? isDir : true, children: [] };
        current.push(node);
      }
      current = node.children;
    }
  }

  const sort = (nodes: ParsedFileNode[]): ParsedFileNode[] =>
    nodes
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
      .map((node) => ({ ...node, children: sort(node.children) }));
  return sort(root);
}

/** 投影为 `ui/tree` 的节点结构（Arborist 路径不使用，保留给 Tree 组件消费方）。 */
export function toTreeNodeData(node: ParsedFileNode): TreeNodeData {
  return { id: node.path, label: node.name, hasChildren: node.isDir && node.children.length > 0 };
}

/** 按名称做大小写不敏感过滤；命中子节点的父节点整体保留，保证路径可读。 */
export function filterFileTree(nodes: ParsedFileNode[], query: string): ParsedFileNode[] {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    const children = filterFileTree(node.children, query);
    return node.name.toLocaleLowerCase().includes(query) || children.length > 0 ? [{ ...node, children }] : [];
  });
}

/**
 * 将 workspace 根节点投影为两个独立展示区。
 * 用户文件仍保留 `user/...` 的真实 workspace 相对路径，只移除视图中的重复目录层级。
 */
export function splitFileTreeSections(nodes: ParsedFileNode[]): FileTreeSections {
  const userRoot = nodes.find((node) => node.path === "user");
  return {
    workspace: nodes.filter((node) => node.path !== "user"),
    user: userRoot?.children ?? [],
  };
}

export function collectDirectoryPaths(nodes: ParsedFileNode[]): string[] {
  return nodes.flatMap((node) => (node.isDir ? [node.path, ...collectDirectoryPaths(node.children)] : []));
}

export function findFileNode(nodes: ParsedFileNode[], path: string): ParsedFileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findFileNode(node.children, path);
    if (found) return found;
  }
  return null;
}
