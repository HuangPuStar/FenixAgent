"use client";

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import type * as React from "react";

import { cn } from "../../src/lib/utils";

/**
 * 超大弹窗组件 — 基于 shadcn Dialog，增宽至 960px，
 * 适用于详情展示、图文混排等需要更大空间的场景。
 */
function XLDialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="xl-dialog" {...props} />;
}

function XLDialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="xl-dialog-trigger" {...props} />;
}

function XLDialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="xl-dialog-close" {...props} />;
}

function XLDialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="xl-dialog-header"
      className={cn("flex flex-col gap-1.5 text-center sm:text-left", className)}
      {...props}
    />
  );
}

function XLDialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="xl-dialog-title"
      className={cn("text-lg leading-tight font-bold", className)}
      {...props}
    />
  );
}

function XLDialogContent({
  className,
  children,
  showCloseButton = true,
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  ref?: React.Ref<HTMLDivElement>;
}) {
  return (
    <DialogPrimitive.Portal data-slot="xl-dialog-portal">
      <DialogPrimitive.Overlay
        data-slot="xl-dialog-overlay"
        className="fixed inset-0 z-50 bg-black/50 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0"
      />
      <DialogPrimitive.Content
        ref={ref}
        data-slot="xl-dialog-content"
        className={cn(
          "fixed top-[50%] left-[50%] z-50 grid w-full max-w-[calc(100%-2rem)] translate-x-[-50%] translate-y-[-50%] gap-0 rounded-xl border bg-background shadow-xl duration-200 outline-none data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 sm:max-w-[960px] max-h-[90vh] overflow-hidden flex flex-col",
          className,
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="xl-dialog-close"
            className="absolute top-4 right-4 z-10 rounded-xs opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:outline-hidden disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export { XLDialog, XLDialogClose, XLDialogContent, XLDialogHeader, XLDialogTitle, XLDialogTrigger };
