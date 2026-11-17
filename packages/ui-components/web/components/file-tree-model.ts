/**
 * 文件树数据模型与纯函数（从 apps/web 的 `agent-panel/file-tree-model.ts` 复制并纯化）。
 *
 * 纯化取舍：源文件导出的 `MAX_FILE_UPLOAD_SIZE_LABEL` 依赖文件域的上传上限常量
 * （`@fenix/resource-machine` 的 `web/api/fs.ts` 导出 `MAX_UPLOAD_SIZE_BYTES`，2026-09-24 随台账 D2
 * 由宿主迁入该包），属业务配置，未随包迁移；需要该文案的调用方自行拼接。
 */

import type { TreeNodeData } from "../ui/tree";

/** 文件树视图节点；文件元数据缺失时保持未知，不用零值补齐。 */
export interface ParsedFileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ParsedFileNode[];
  size?: number;
  modifiedAt?: number;
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
export function parsePathsToTree(
  paths: string[],
  mtimes?: Record<string, number>,
  sizes?: Record<string, number>,
): ParsedFileNode[] {
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
      if (last && !node.isDir) {
        if (sizes?.[path] !== undefined) node.size = sizes[path];
        if (mtimes?.[path] !== undefined) node.modifiedAt = mtimes[path];
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

/** 两个文件分区共享的选择；anchor 是 Shift 连选的起点。 */
export interface FileTreeSelection {
  paths: string[];
  anchor: string | null;
}

/** 将平台修饰键归一为切换选择与范围选择。 */
export interface FileTreeSelectionGesture {
  toggle: boolean;
  range: boolean;
}

/** 按可见顺序计算选择，不把折叠或搜索隐藏的节点带入连选。 */
export function selectFileTreePaths(
  state: FileTreeSelection,
  path: string,
  visiblePaths: string[],
  gesture: FileTreeSelectionGesture,
): FileTreeSelection {
  if (gesture.range && state.anchor !== null) {
    const start = visiblePaths.indexOf(state.anchor);
    const end = visiblePaths.indexOf(path);
    if (start >= 0 && end >= 0) {
      const range = visiblePaths.slice(Math.min(start, end), Math.max(start, end) + 1);
      return { paths: gesture.toggle ? [...new Set([...state.paths, ...range])] : range, anchor: state.anchor };
    }
  }
  if (gesture.toggle) {
    return {
      paths: state.paths.includes(path) ? state.paths.filter((item) => item !== path) : [...state.paths, path],
      anchor: path,
    };
  }
  return { paths: [path], anchor: path };
}

/** 展开状态决定可见行集合；与虚拟树渲染顺序保持一致。 */
export function getVisibleFileTreePaths(nodes: ParsedFileNode[], expandedIds: string[]): string[] {
  const expanded = new Set(expandedIds);
  const visit = (items: ParsedFileNode[]): string[] =>
    items.flatMap((node) => [node.path, ...(node.isDir && expanded.has(node.path) ? visit(node.children) : [])]);
  return visit(nodes);
}

/** 父路径已经包含后代操作，按原顺序只保留顶层且非重复的选择。 */
export function getRootFileTreePaths(paths: string[]): string[] {
  const unique = [...new Set(paths.filter(Boolean))];
  return unique.filter((path) => !unique.some((other) => other !== path && path.startsWith(`${other}/`)));
}
