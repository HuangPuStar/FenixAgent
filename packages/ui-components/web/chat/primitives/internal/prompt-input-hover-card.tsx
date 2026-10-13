/**
 * prompt-input 内部模块：HoverCard 系列薄包装。
 *
 * 仅供 `web/chat/primitives/prompt-input.tsx` 使用，不属于公开 API；公开出口统一由该文件维护。
 * 拆分原因：原实现单文件超过 500 行红线，按职责切分后各自独立演进。
 */

import type { ComponentProps } from "react";

import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../../ui/hover-card";

export type PromptInputHoverCardProps = ComponentProps<typeof HoverCard>;

export const PromptInputHoverCard = ({ openDelay = 0, closeDelay = 0, ...props }: PromptInputHoverCardProps) => (
  <HoverCard closeDelay={closeDelay} openDelay={openDelay} {...props} />
);

export type PromptInputHoverCardTriggerProps = ComponentProps<typeof HoverCardTrigger>;

export const PromptInputHoverCardTrigger = (props: PromptInputHoverCardTriggerProps) => <HoverCardTrigger {...props} />;

export type PromptInputHoverCardContentProps = ComponentProps<typeof HoverCardContent>;

export const PromptInputHoverCardContent = ({ align = "start", ...props }: PromptInputHoverCardContentProps) => (
  <HoverCardContent align={align} {...props} />
);
