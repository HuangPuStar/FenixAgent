import type { FileUIPart } from "ai";
import { PaperclipIcon, XIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "../../src/i18n";
import { Button } from "../ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";

function withClassName(baseClassName: string, className?: string): string {
  return className ? `${baseClassName} ${className}` : baseClassName;
}

export type MessageAttachmentProps = HTMLAttributes<HTMLDivElement> & {
  data: FileUIPart;
  className?: string;
  onRemove?: () => void;
};

/** Renders one image or file attachment while keeping removal accessible by keyboard. */
export function MessageAttachment({ data, className, onRemove, ...props }: MessageAttachmentProps) {
  const { t } = useTranslation(NS.COMPONENTS);
  const filename = data.filename ?? "";
  const isImage = Boolean(data.mediaType?.startsWith("image/") && data.url);
  const attachmentLabel = filename || (isImage ? t("message.image") : t("message.attachment"));

  return (
    <div className={withClassName("group relative size-24 overflow-hidden rounded-lg", className)} {...props}>
      {isImage ? (
        <img
          alt={filename || t("message.attachment")}
          className="size-full object-cover"
          height={100}
          src={data.url}
          width={100}
        />
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="flex size-full shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              <PaperclipIcon className="size-4" />
            </div>
          </TooltipTrigger>
          <TooltipContent>
            <p>{attachmentLabel}</p>
          </TooltipContent>
        </Tooltip>
      )}
      {onRemove && (
        <Button
          aria-label={t("message.removeAttachment")}
          className="absolute top-2 right-2 size-6 rounded-full bg-background/80 p-0 opacity-0 backdrop-blur-sm transition-opacity hover:bg-background group-hover:opacity-100 [&>svg]:size-3"
          onClick={(event) => {
            event.stopPropagation();
            onRemove();
          }}
          type="button"
          variant="ghost"
        >
          <XIcon />
          <span className="sr-only">{t("message.remove")}</span>
        </Button>
      )}
    </div>
  );
}

export type MessageAttachmentsProps = ComponentProps<"div">;

/** Groups message attachments without reserving space when empty. */
export function MessageAttachments({ children, className, ...props }: MessageAttachmentsProps) {
  if (!children) return null;

  return (
    <div className={withClassName("ml-auto flex w-fit flex-wrap items-start gap-2", className)} {...props}>
      {children}
    </div>
  );
}
