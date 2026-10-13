/**
 * 把 Agent 工具调用上报的任意格式路径规范化为 workspace 相对路径，
 * 与后端文件树 API 返回的路径格式保持一致。
 *
 * 归属（2026-09-24，台账 `ce-standards-todo.md` D2）：由宿主 `apps/web/src/shell/artifacts/preview/utils.ts`
 * 迁入（该簇 2026-09-28 归位到 `apps/web/src/pages/agent-panel/artifacts/`，本文件不在其中）。它处理的是 Agent 工具调用上报路径与文件树路径的**对齐约定**，两侧（文件树容器与
 * `use-artifacts-files`）都归本包，因此随文件域实现一起落位；包外没有第二个消费者。
 *
 * 同目录此前的「预览源判定」主体（扩展名分类表、`classifyFile`、`getPreviewMimeType`、
 * `shouldLoadPreviewAsBlob`、`loadByteAccuratePreviewSource`、`buildPreviewUrl`）的 owner 是
 * `@fenix/ui-components/components/preview/preview-source` 与 `FileViewerPreview`，宿主副本已删除，
 * 本模块不再重复它们。
 *
 * Agent 的 cwd 即 workspace 根目录，上报的 path 已经是相对于 workspace 的路径，
 * 无需额外添加 `user/` 前缀。后端 `resolveWorkspacePath` 会自行处理路径解析。
 *
 * Agent 上报的 path 可能是：
 * 1. workspace 相对路径（`src/foo.ts`、`user/foo.txt`）——直接返回
 * 2. workspace 绝对路径含 /user/ 段（`/workspaces/{org}/{user}/{env}/user/src/foo.ts`）
 * 3. workspace 绝对路径不含 /user/ 段（`/workspaces/{org}/{user}/{env}/src/foo.ts`）
 * 4. 空串 —— 兜底为 `user/`
 *
 * 规范化策略：
 * - 已带 `user/` 前缀的路径：直接保持原样
 * - 空字符串、纯粹 "user" / "user/"：统一为 `user/`
 * - 绝对路径命中 env_* 段：取其后部分作为 workspace 相对路径，
 *   保留原始 user/ 或非 user/ 前缀状态，不额外添加前缀
 * - 绝对路径无 env_* 段：原样返回让 server 兜底
 * - 纯相对路径：直接返回（agent 工作目录即 workspace 根，路径已正确）
 *
 * 这样可与文件树 tree API 返回的路径格式对齐，
 * 同一文件不会因为路径来源不同而出现两个 tab。
 */
export function normalizeToUserPath(rawPath: string): string {
  // 统一去除尾部斜杠（目录形态），保留前导斜杠判断用于绝对路径分支
  const trimmed = rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
  if (trimmed === "") return "user/";

  // 完全等于 "user" / 已带 user/ 前缀：保持不变
  if (trimmed === "user" || trimmed === "user/") return "user/";
  if (trimmed.startsWith("user/")) return trimmed;

  // 绝对路径分支（以 / 开头）：用 env_*/ 分隔符切分 workspace 路径
  // workspace 路径结构固定为 .../env_{envId}/<相对路径>，
  // 用 env_*/ 切分即可提取 workspace 相对路径，不依赖 server 上下文。
  if (trimmed.startsWith("/")) {
    const envMatch = trimmed.match(/\/env_[^/]+\//);
    if (envMatch && envMatch.index !== undefined) {
      const afterEnv = trimmed.slice(envMatch.index + envMatch[0].length);
      if (afterEnv) return afterEnv;
      return "user/";
    }
    // 非 workspace 路径（无 env_*/ 段）：原样返回让 server 兜底
    return trimmed;
  }

  // 纯相对路径：直接返回（agent 工作目录即 workspace 根，路径已正确）
  return trimmed;
}
