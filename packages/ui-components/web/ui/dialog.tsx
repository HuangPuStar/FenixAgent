import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "../lib/cn";
import "./dialog.css";

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
        className,
      )}
      {...props}
    />
  );
}

/**
 * 弹窗尺寸变体。
 *
 * 原 `ui/dialog-xl.tsx` 把 portal / overlay / content / 关闭按钮整套重抄了一遍，只差宽度与内边距；
 * 代价是能力漂移——XL 那套不支持 `showOverlay` / `disableOverlayClose` / `disableEscapeClose`，
 * 于是一个「禁止 ESC 关闭」的约束在两种弹窗上表现不同。改为同一实现的尺寸参数后，
 * 两个变体共享全部开关与 a11y 行为，差异只剩这几条工具类。
 */
const DIALOG_CONTENT_SIZE = {
  default: "gap-4 rounded-lg p-6 shadow-lg sm:max-w-lg",
  xl: "gap-0 rounded-xl shadow-xl sm:max-w-240 max-h-[90vh] overflow-hidden flex flex-col",
} as const;

function DialogContent({
  className,
  children,
  size = "default",
  showCloseButton = true,
  showOverlay = true,
  disableOverlayClose,
  disableEscapeClose,
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** 尺寸变体：`xl` 为 960px 宽的超大弹窗（详情展示、图文混排），主体自行滚动。 */
  size?: keyof typeof DIALOG_CONTENT_SIZE;
  showCloseButton?: boolean;
  showOverlay?: boolean;
  /** 禁止点击遮罩关闭 */
  disableOverlayClose?: boolean;
  /** 禁止 ESC 关闭 */
  disableEscapeClose?: boolean;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <DialogPortal data-slot="dialog-portal">
      {showOverlay && <DialogOverlay />}
      <DialogPrimitive.Content
        ref={ref}
        data-slot="dialog-content"
        className={cn(
          // 宽度上限引用 `dialog.css` 的变量（不是就地写死值）：见该文件头 ② 的层叠说明。
          "dialog-content fixed top-[50%] left-[50%] z-50 grid w-full max-w-(--dialog-content-max-width) translate-x-[-50%] translate-y-[-50%] border bg-background duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          DIALOG_CONTENT_SIZE[size],
          className,
        )}
        onInteractOutside={disableOverlayClose ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={disableEscapeClose ? (e) => e.preventDefault() : undefined}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            className={cn(
              "dialog-close absolute top-4 right-4 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
              // xl 变体主体自成一个滚动容器且内容可为图文混排，关闭按钮需要压在内容之上
              size === "xl" && "z-10",
            )}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function DialogFooter({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", className)}
      {...props}
    />
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn("text-lg leading-none font-semibold", className)}
      {...props}
    />
  );
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
