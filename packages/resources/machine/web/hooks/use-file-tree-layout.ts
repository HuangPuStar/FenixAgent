import { useCallback, useEffect, useState } from "react";

import {
  FILE_TREE_DOCKED_MEDIA_QUERY,
  FILE_TREE_LAYOUT_STORAGE_KEY,
  type FileTreeLayoutMode,
  resolveFileTreeLayout,
} from "../lib/file-tree-layout";

/** 读取用户显式选择；未选择、值非法或存储不可用时返回 null（调用方按屏宽取默认）。 */
function readStoredLayout(): FileTreeLayoutMode | null {
  try {
    const stored = localStorage.getItem(FILE_TREE_LAYOUT_STORAGE_KEY);
    return stored === "floating" || stored === "docked" ? stored : null;
  } catch {
    return null;
  }
}

/** 持久化显式选择；存储不可用（隐私模式）时静默降级——本次会话内布局照常生效。 */
function persistLayout(mode: FileTreeLayoutMode): void {
  try {
    localStorage.setItem(FILE_TREE_LAYOUT_STORAGE_KEY, mode);
  } catch {
    // 存储只是增强：写不进去不影响本次会话的布局。
  }
}

/** 当前视口是否达到大屏断点；无 DOM（SSR 或无窗口的测试）时按小屏处理，与浮层默认一致。 */
function matchesWideViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(FILE_TREE_DOCKED_MEDIA_QUERY).matches;
}

export interface FileTreeLayoutState {
  /** 生效模式：显式选择优先，否则按屏宽（小屏浮动、大屏固定）。 */
  mode: FileTreeLayoutMode;
  /** 切换控件回调：记为**显式选择**并持久化，此后不再随屏宽变化（用户已明确要求记住选择）。 */
  toggleMode: () => void;
}

/**
 * 文件树布局状态（浮动 / 固定）。环境读写（`localStorage` / `matchMedia`）收在本 hook 里，
 * 判定规则本身在 `lib/file-tree-layout.ts`，两处都不进容器组件，便于单独断言。
 */
export function useFileTreeLayout(): FileTreeLayoutState {
  const [stored, setStored] = useState<FileTreeLayoutMode | null>(readStoredLayout);
  const [isWideViewport, setIsWideViewport] = useState(matchesWideViewport);

  // 未手动选择时布局随屏宽变化：跨断点缩放必须跟随，所以订阅媒体查询而不是只读一次。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(FILE_TREE_DOCKED_MEDIA_QUERY);
    const handler = (event: MediaQueryListEvent) => setIsWideViewport(event.matches);
    // 首帧渲染与订阅之间视口可能已经变过，订阅时补读一次当前值。
    setIsWideViewport(query.matches);
    query.addEventListener("change", handler);
    return () => query.removeEventListener("change", handler);
  }, []);

  const mode = resolveFileTreeLayout(stored, isWideViewport);
  const toggleMode = useCallback(() => {
    const next: FileTreeLayoutMode = mode === "floating" ? "docked" : "floating";
    setStored(next);
    persistLayout(next);
  }, [mode]);

  return { mode, toggleMode };
}
