/**
 * prompt-input 内部模块：附件条目、附件列表与「添加附件」菜单项。
 *
 * 仅供 `web/ai-elements/prompt-input.tsx` 使用，不属于公开 API；公开出口统一由该文件维护。
 * 拆分原因：原实现单文件超过 500 行红线，按职责切分后各自独立演进。
 */

import { ImageIcon, PaperclipIcon, XIcon } from "lucide-react";
import { type ComponentProps, Fragment, type HTMLAttributes, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "../../lib/cn";
import { UI_COMPONENTS_NS } from "../../lib/i18n";
import { Button } from "../../ui/button";
import { DropdownMenuItem } from "../../ui/dropdown-menu";
// 仅需 HoverCardTrigger：内容区使用包内 PromptInputHoverCardContent 包装（源文件额外引入了未使用的 HoverCardContent）
import { HoverCardTrigger } from "../../ui/hover-card";
import { type FileUIPartWithFile, usePromptInputAttachments } from "./prompt-input-context";
import { PromptInputHoverCard, PromptInputHoverCardContent } from "./prompt-input-hover-card";

export type PromptInputAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPartWithFile;
  className?: string;
};

export function PromptInputAttachment({ data, className, ...props }: PromptInputAttachmentProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const attachments = usePromptInputAttachments();

  const filename = data.filename || "";

  const mediaType = data.mediaType?.startsWith("image/") && data.url ? "image" : "file";
  const isImage = mediaType === "image";

  const attachmentLabel = filename || (isImage ? t("promptInput.image") : t("promptInput.attachment"));

  return (
    <PromptInputHoverCard>
      <HoverCardTrigger asChild>
        <div
          className={cn(
            "group relative flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-1.5 font-medium text-sm transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
            className,
          )}
          key={data.id}
          {...props}
        >
          <div className="relative size-5 shrink-0">
            <div className="absolute inset-0 flex size-5 items-center justify-center overflow-hidden rounded bg-background transition-opacity group-hover:opacity-0">
              {isImage ? (
                <img
                  alt={filename || t("promptInput.attachment")}
                  className="size-5 object-cover"
                  height={20}
                  src={data.url}
                  width={20}
                />
              ) : (
                <div className="flex size-5 items-center justify-center text-muted-foreground">
                  <PaperclipIcon className="size-3" />
                </div>
              )}
            </div>
            <Button
              aria-label={t("promptInput.removeAttachment")}
              className="absolute inset-0 size-5 cursor-pointer rounded p-0 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 [&>svg]:size-2.5"
              onClick={(e) => {
                e.stopPropagation();
                attachments.remove(data.id);
              }}
              type="button"
              variant="ghost"
            >
              <XIcon />
              <span className="sr-only">{t("promptInput.remove")}</span>
            </Button>
          </div>

          <span className="flex-1 truncate">{attachmentLabel}</span>
        </div>
      </HoverCardTrigger>
      <PromptInputHoverCardContent className="w-auto p-2">
        <div className="w-auto space-y-3">
          {isImage && (
            <div className="flex max-h-96 w-96 items-center justify-center overflow-hidden rounded-md border">
              <img
                alt={filename || "attachment preview"}
                className="max-h-full max-w-full object-contain"
                height={384}
                src={data.url}
                width={448}
              />
            </div>
          )}
          <div className="flex items-center gap-2.5">
            <div className="min-w-0 flex-1 space-y-1 px-0.5">
              <h4 className="truncate font-semibold text-sm leading-none">
                {filename || (isImage ? t("promptInput.image") : t("promptInput.attachment"))}
              </h4>
              {data.mediaType && <p className="truncate font-mono text-muted-foreground text-xs">{data.mediaType}</p>}
            </div>
          </div>
        </div>
      </PromptInputHoverCardContent>
    </PromptInputHoverCard>
  );
}

export type PromptInputAttachmentsProps = Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  children: (attachment: FileUIPartWithFile) => ReactNode;
};

export function PromptInputAttachments({ children, className, ...props }: PromptInputAttachmentsProps) {
  const attachments = usePromptInputAttachments();

  if (!attachments.files.length) {
    return null;
  }

  return (
    <div className={cn("flex flex-wrap items-center gap-2 p-3 w-full", className)} {...props}>
      {attachments.files.map((file) => (
        <Fragment key={file.id}>{children(file)}</Fragment>
      ))}
    </div>
  );
}

export type PromptInputActionAddAttachmentsProps = ComponentProps<typeof DropdownMenuItem> & {
  label?: string;
};

export const PromptInputActionAddAttachments = ({ label, ...props }: PromptInputActionAddAttachmentsProps) => {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const attachments = usePromptInputAttachments();
  const _label = label ?? t("promptInput.addPhotosOrFiles");

  return (
    <DropdownMenuItem
      {...props}
      onSelect={(e) => {
        e.preventDefault();
        attachments.openFileDialog();
      }}
    >
      <ImageIcon className="mr-2 size-4" /> {_label}
    </DropdownMenuItem>
  );
};
