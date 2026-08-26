import type { TreeNodeData } from "@/components/ui/tree";
import { MAX_UPLOAD_SIZE_BYTES } from "@/src/api/fs";

export interface ParsedFileNode {
  name: string;
  path: string;
  isDir: boolean;
  children: ParsedFileNode[];
}

export const MAX_FILE_UPLOAD_SIZE_LABEL = `${MAX_UPLOAD_SIZE_BYTES / (1024 * 1024)}MB`;

export function parsePathsToTree(paths: string[]): ParsedFileNode[] {
  // `user/` 是产品定义的用户文件分区，即使远端暂时为空也保持稳定入口。
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

export function toTreeNodeData(node: ParsedFileNode): TreeNodeData {
  return { id: node.path, label: node.name, hasChildren: node.isDir && node.children.length > 0 };
}

export function filterFileTree(nodes: ParsedFileNode[], query: string): ParsedFileNode[] {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    const children = filterFileTree(node.children, query);
    return node.name.toLocaleLowerCase().includes(query) || children.length > 0 ? [{ ...node, children }] : [];
  });
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

export function appendUploadFileNames(formData: FormData, files: File[]): void {
  formData.append("fileNames", JSON.stringify(files.map((file) => file.name)));
}
