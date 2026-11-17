import {
  findFileNode,
  getRootFileTreePaths,
  type ParsedFileNode,
} from "@fenix/ui-components/components/file-tree-model";

/** 服务端已确认成功的路径变更，供文件树与预览共同应用。 */
export interface WorkspaceFilesChange {
  moved: Array<{ oldPath: string; newPath: string }>;
  deleted: string[];
}

/** 移动计划的可本地判断失败，不代替服务端最终校验。 */
export interface WorkspaceMoveFailure {
  path: string;
  reason: "invalid-target" | "protected-root" | "missing-source" | "descendant" | "conflict";
}

/** 逐项执行的移动计划；同目录项被省略，冲突项保留为失败。 */
export interface WorkspaceMovePlan {
  moves: WorkspaceFilesChange["moved"];
  failed: WorkspaceMoveFailure[];
}

/** 生成不覆盖目标的移动计划，目录自身与后代目标会拒绝整组。 */
export function planWorkspaceFileMoves(paths: string[], targetDir: string, tree: ParsedFileNode[]): WorkspaceMovePlan {
  const sources = getRootFileTreePaths(paths);
  const target = targetDir === "" ? null : findFileNode(tree, targetDir);
  if (targetDir !== "" && !target?.isDir) {
    return { moves: [], failed: sources.map((path) => ({ path, reason: "invalid-target" })) };
  }
  if (sources.some((path) => targetDir === path || targetDir.startsWith(`${path}/`))) {
    return { moves: [], failed: sources.map((path) => ({ path, reason: "descendant" })) };
  }
  const plan: WorkspaceMovePlan = { moves: [], failed: [] };
  const reserved = new Set<string>();
  for (const path of sources) {
    if (path === "user") {
      plan.failed.push({ path, reason: "protected-root" });
      continue;
    }
    if (!findFileNode(tree, path)) {
      plan.failed.push({ path, reason: "missing-source" });
      continue;
    }
    const basename = path.slice(path.lastIndexOf("/") + 1);
    const newPath = targetDir ? `${targetDir}/${basename}` : basename;
    if (path === newPath) continue;
    if (reserved.has(newPath) || findFileNode(tree, newPath)) {
      plan.failed.push({ path, reason: "conflict" });
      continue;
    }
    reserved.add(newPath);
    plan.moves.push({ oldPath: path, newPath });
  }
  return plan;
}

/** 将打开的文件映射到成功变更后的路径；已删除文件及后代返回 null。 */
export function remapWorkspaceFilePath(path: string, change: WorkspaceFilesChange): string | null {
  const within = (root: string) => path === root || path.startsWith(`${root}/`);
  if (change.deleted.some(within)) return null;
  const move = change.moved.find((entry) => within(entry.oldPath));
  return move ? move.newPath + path.slice(move.oldPath.length) : path;
}
