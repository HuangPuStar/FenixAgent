/**
 * prompt-input 内部模块：提交按钮：按 ChatStatus 切换图标。
 *
 * 仅供 `web/chat/primitives/prompt-input.tsx` 使用，不属于公开 API；公开出口统一由该文件维护。
 * 拆分原因：原实现单文件超过 500 行红线，按职责切分后各自独立演进。
 */

import type { ChatStatus } from "ai";
import { CornerDownLeftIcon, Loader2Icon, SquareIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { cn } from "../../../lib/cn";
import { InputGroupButton } from "../../../ui/input-group";

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: ChatStatus;
};

export const PromptInputSubmit = ({
  className,
  variant = "default",
  size = "icon-sm",
  status,
  children,
  ...props
}: PromptInputSubmitProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  let Icon = <CornerDownLeftIcon className="size-4" />;

  if (status === "submitted") {
    Icon = <Loader2Icon className="size-4 animate-spin" />;
  } else if (status === "streaming") {
    Icon = <SquareIcon className="size-4" />;
  } else if (status === "error") {
    Icon = <XIcon className="size-4" />;
  }

  return (
    <InputGroupButton
      aria-label={t("promptInput.submit")}
      className={cn(className)}
      size={size}
      type="submit"
      variant={variant}
      {...props}
    >
      {children ?? Icon}
    </InputGroupButton>
  );
};
