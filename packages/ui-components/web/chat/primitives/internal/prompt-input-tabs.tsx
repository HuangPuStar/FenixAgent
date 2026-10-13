/**
 * prompt-input 内部模块：Tabs 系列纯样式容器。
 *
 * 仅供 `web/chat/primitives/prompt-input.tsx` 使用，不属于公开 API；公开出口统一由该文件维护。
 * 拆分原因：原实现单文件超过 500 行红线，按职责切分后各自独立演进。
 */

import type { HTMLAttributes } from "react";

import { cn } from "../../../lib/cn";

export type PromptInputTabsListProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabsList = ({ className, ...props }: PromptInputTabsListProps) => (
  <div className={cn(className)} {...props} />
);

export type PromptInputTabProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTab = ({ className, ...props }: PromptInputTabProps) => (
  <div className={cn(className)} {...props} />
);

export type PromptInputTabLabelProps = HTMLAttributes<HTMLHeadingElement>;

export const PromptInputTabLabel = ({ className, ...props }: PromptInputTabLabelProps) => (
  <h3 className={cn("mb-2 px-3 font-medium text-muted-foreground text-xs", className)} {...props} />
);

export type PromptInputTabBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabBody = ({ className, ...props }: PromptInputTabBodyProps) => (
  <div className={cn("space-y-1", className)} {...props} />
);

export type PromptInputTabItemProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTabItem = ({ className, ...props }: PromptInputTabItemProps) => (
  <div className={cn("flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent", className)} {...props} />
);
