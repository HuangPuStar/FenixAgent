/**
 * 文件树布局偏好（浮动 / 固定）的**单一权威**：模式取值、默认解析与浮层宽度约束都在这里。
 *
 * 为什么单独放 `lib/`：容器（`artifacts-files-workspace`）只消费解析结果，而「未手动选择时按屏宽取默认」
 * 「显式选择优先」这两条规则必须能在不带 DOM 的 `bun test` 里直接断言（见 `web/__tests__/file-tree-layout.test.ts`）。
 */

/** 文件树布局模式：`floating` 浮层盖在预览之上（不占布局宽度），`docked` 占用一列宽度（历史行为）。 */
export type FileTreeLayoutMode = "floating" | "docked";

/**
 * 用户**显式选择**的结果；键不存在 = 从未手动选择，此时按屏宽取默认。
 *
 * 区分「没选过」与「选了浮动」是必需的：只有前者才随屏宽变化，后者是用户意志，窗口缩放不得覆盖。
 */
export const FILE_TREE_LAYOUT_STORAGE_KEY = "fenix:file-tree-layout";

/**
 * 大屏断点：Tailwind 默认 `lg`（1024px），与仓库里的 `lg:` / `max-lg:` 工具类同源。
 *
 * 面板自身的紧凑断点是 1050px（`COMPACT_LAYOUT_QUERY`），那一条判的是「面板整体是否浮在聊天区之上」，
 * 与本条无关：窄面板里依然可以有一个固定的文件树列。
 */
export const FILE_TREE_DOCKED_MEDIA_QUERY = "(min-width: 1024px)";

/** 文件树列的最小宽度（固定模式的 `ResizablePanel` 下界，也是浮层宽度的下界）。 */
export const FILE_TREE_MIN_WIDTH = 176;

/** 没有宽度偏好（首访 / 存储不可用）时的文件树宽度。 */
export const FILE_TREE_DEFAULT_WIDTH = 184;

/**
 * 浮层宽度上限：浮动模式下树盖在预览之上，宽度再大就把预览的可读区压得没有意义。
 * 固定模式不受此限——它占的是布局宽度，由 `ResizablePanel` 的 50% 上限约束。
 */
export const FILE_TREE_OVERLAY_MAX_WIDTH = 360;

/**
 * 生效模式：显式选择优先；未手动选择时按屏宽取默认（小屏浮动、大屏固定）。
 *
 * 纯函数，不读环境——`localStorage` 与 `matchMedia` 的读取归 `use-file-tree-layout.ts`。
 */
export function resolveFileTreeLayout(stored: FileTreeLayoutMode | null, isWideViewport: boolean): FileTreeLayoutMode {
  if (stored) return stored;
  return isWideViewport ? "docked" : "floating";
}

/** 浮层宽度：沿用固定模式的宽度偏好（同一棵树，两处宽度偏好合并成一份），夹在最小宽度与浮层上限之间。 */
export function clampFileTreeOverlayWidth(width: number): number {
  if (!Number.isFinite(width)) return FILE_TREE_MIN_WIDTH;
  return Math.max(FILE_TREE_MIN_WIDTH, Math.min(width, FILE_TREE_OVERLAY_MAX_WIDTH));
}
