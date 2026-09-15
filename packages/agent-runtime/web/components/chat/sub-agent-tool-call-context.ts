import type { ReactNode } from "react";
import { createContext } from "react";
import type { ToolCallEntry } from "@/src/lib/types";

/**
 * 子 Agent 时间线把工具分组渲染交给其宿主，避免 ToolCallRow 与 ToolCallGroup 形成循环依赖。
 */
export const SubAgentToolCallGroupContext = createContext<((entries: ToolCallEntry[]) => ReactNode) | null>(null);
