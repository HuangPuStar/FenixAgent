import { createContext, useContext } from "react";
import type { TreeContextValue } from "./tree-types";

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

/**
 * Tree 复合组件的内部上下文。TreeItem 递归渲染时需要读取，但 Tree/TreeItem 分处两个文件
 * 会形成 React 组件的循环引用，因此把 context 独立成文件，由 tree.tsx 提供 Provider。
 */
export const TreeContext = createContext<TreeContextValue | null>(null);

export function useTreeContext(): TreeContextValue {
  const ctx = useContext(TreeContext);
  if (!ctx) throw new Error("Tree compound components must be used inside <Tree>");
  return ctx;
}
