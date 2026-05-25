"use client";

import type { ToolUIPart } from "ai";
import { CheckCircleIcon, ChevronDownIcon, CircleIcon, ClockIcon, WrenchIcon, XCircleIcon } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { isValidElement } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { Badge } from "../ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { CodeBlock } from "./code-block";

export type ToolProps = ComponentProps<typeof Collapsible>;

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn("not-prose mb-4 w-full max-w-full overflow-hidden rounded-md border", className)}
    {...props}
  />
);

// Extended state type to include our custom states
export type ExtendedToolState = ToolUIPart["state"] | "waiting-for-confirmation" | "rejected";

export type ToolHeaderProps = {
  title?: string;
  type: ToolUIPart["type"];
  state: ExtendedToolState;
  className?: string;
};

const toolStatusLabels: Record<ExtendedToolState, string> = {
  "input-streaming": "tool.statusPending",
  "input-available": "tool.statusRunning",
  "approval-requested": "tool.statusAwaitingApproval",
  "approval-responded": "tool.statusResponded",
  "output-available": "tool.statusCompleted",
  "output-error": "tool.statusError",
  "output-denied": "tool.statusDenied",
  "waiting-for-confirmation": "tool.statusAwaitingApproval",
  rejected: "tool.statusRejected",
};

const getStatusBadge = (status: ExtendedToolState) => {
  const { t } = useTranslation("components");

  const icons: Record<ExtendedToolState, ReactNode> = {
    "input-streaming": <CircleIcon className="size-4" />,
    "input-available": <ClockIcon className="size-4 animate-pulse" />,
    "approval-requested": <ClockIcon className="size-4 text-yellow-600" />,
    "approval-responded": <CheckCircleIcon className="size-4 text-blue-600" />,
    "output-available": <CheckCircleIcon className="size-4 text-green-600" />,
    "output-error": <XCircleIcon className="size-4 text-red-600" />,
    "output-denied": <XCircleIcon className="size-4 text-orange-600" />,
    "waiting-for-confirmation": <ClockIcon className="size-4 text-yellow-600" />,
    rejected: <XCircleIcon className="size-4 text-orange-600" />,
  };

  return (
    <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
      {icons[status]}
      {t(toolStatusLabels[status])}
    </Badge>
  );
};

export const ToolHeader = ({ className, title, type, state, ...props }: ToolHeaderProps) => (
  <CollapsibleTrigger className={cn("flex w-full items-center justify-between gap-4 p-3", className)} {...props}>
    <div className="flex min-w-0 items-center gap-2">
      <WrenchIcon className="size-4 shrink-0 text-muted-foreground" />
      <span className="truncate font-medium text-sm">{title ?? type.split("-").slice(1).join("-")}</span>
      {getStatusBadge(state)}
    </div>
    <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
  </CollapsibleTrigger>
);

export type ToolContentProps = ComponentProps<typeof CollapsibleContent>;

export const ToolContent = ({ className, ...props }: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 text-popover-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
      className,
    )}
    {...props}
  />
);

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolUIPart["input"];
};

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const { t } = useTranslation("components");
  return (
    <div className={cn("space-y-2 overflow-hidden p-4 max-w-full", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{t("tool.parameters")}</h4>
      <div className="rounded-md bg-muted/50 overflow-hidden">
        <CodeBlock code={JSON.stringify(input, null, 2)} language="json" />
      </div>
    </div>
  );
};

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolUIPart["output"];
  errorText: ToolUIPart["errorText"];
};

export const ToolOutput = ({ className, output, errorText, ...props }: ToolOutputProps) => {
  const { t } = useTranslation("components");
  if (!(output || errorText)) {
    return null;
  }

  let Output = <div>{output as ReactNode}</div>;

  if (typeof output === "object" && !isValidElement(output)) {
    Output = <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />;
  } else if (typeof output === "string") {
    Output = <CodeBlock code={output} language="json" />;
  }

  return (
    <div className={cn("space-y-2 p-4 max-w-full overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? t("tool.error") : t("tool.result")}
      </h4>
      <div
        className={cn(
          "overflow-hidden rounded-md text-xs [&_table]:w-full",
          errorText ? "bg-destructive/10 text-destructive" : "bg-muted/50 text-foreground",
        )}
      >
        {errorText && <div className="p-2">{errorText}</div>}
        {Output}
      </div>
    </div>
  );
};
