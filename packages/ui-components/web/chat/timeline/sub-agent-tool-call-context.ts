/**
 * 子 Agent 时间线的工具分组渲染槽位。
 *
 * 来源：`packages/agent-runtime/web/components/chat/sub-agent-tool-call-context.ts`（旧路径，已于 2026-09-21 由 f2741a82d 删除） 逐字复制。
 * 纯化改动点：`ToolCallEntry` 改从包内 `../types` 导入。
 *
 * 语义：子 Agent 时间线把工具分组渲染交给其宿主，避免 ToolCallRow 与 ToolCallGroup 形成循环依赖。
 * 宿主通过 `<SubAgentToolCallGroupContext.Provider value={...}>` 注入渲染函数，未注入时子时间线
 * 不渲染工具分组。
 */

import type { ReactNode } from "react";
import { createContext } from "react";
import type { ToolCallEntry } from "../types";

export const SubAgentToolCallGroupContext = createContext<((entries: ToolCallEntry[]) => ReactNode) | null>(null);
