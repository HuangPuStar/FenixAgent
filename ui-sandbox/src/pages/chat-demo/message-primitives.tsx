import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Clock3,
  CodeXml,
  Copy,
  LoaderCircle,
  Quote,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useChatQuote } from "./chat-quote-context";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle } from "./demo-ui";
import { useDemoTranslation } from "./use-demo-copy";

/** Renders a local user turn with optional mock attachments. */
export function UserMessage({
  children,
  attachments,
  promptAnchorId,
}: {
  children: ReactNode;
  attachments?: ReactNode;
  promptAnchorId?: string;
}) {
  const { t } = useDemoTranslation();
  return (
    <article className="chat-demo__message chat-demo__message--user" data-prompt-anchor={promptAnchorId || undefined}>
      {attachments}
      <div className="chat-demo__user-bubble">{children}</div>
      <span className="chat-demo__message-time">{t("conversation.messageTime")}</span>
    </article>
  );
}

export function AssistantMessage({
  children,
  compact = false,
  copyable = true,
}: {
  children: ReactNode;
  compact?: boolean;
  copyable?: boolean;
}) {
  const { t } = useDemoTranslation();
  const addQuote = useChatQuote();
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const resetTimerRef = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
    };
  }, []);

  const copyMessage = async () => {
    const text = bodyRef.current?.innerText.trim();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (resetTimerRef.current) window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <article className={`chat-demo__message chat-demo__message--assistant${compact ? " is-compact" : ""}`}>
      <div ref={bodyRef} className="chat-demo__assistant-body">
        {children}
      </div>
      {copyable && (
        <div className="chat-demo__message-actions">
          <button type="button" aria-label={t(`controls.${copied ? "copied" : "copy"}`)} onClick={copyMessage}>
            {copied ? <Check /> : <Copy />}
          </button>
          <button
            type="button"
            aria-label="引用到对话"
            onClick={() => {
              const text = bodyRef.current?.innerText.trim();
              if (text) addQuote(text);
            }}
          >
            <Quote />
          </button>
        </div>
      )}
    </article>
  );
}

export function ThoughtBlock({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="chat-demo__thought">
      <button type="button" className="chat-demo__thought-trigger" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span>{label}</span>
        {open ? <ChevronDown /> : <ChevronRight />}
      </button>
      {open && <div className="chat-demo__thought-body">{children}</div>}
    </div>
  );
}

/** Renders platform guidance outside both user and assistant message ownership. */
export function SystemReminder({ title }: { title: string }) {
  return (
    <aside className="chat-demo__system-reminder" role="note">
      <strong>{title}</strong>
    </aside>
  );
}

export type DemoToolStatus = "complete" | "running" | "failed" | "queued";

/** Keeps large tool batches readable while preserving every individual call on demand. */
export function ToolCallGroup({
  count,
  complete,
  failed,
  running,
  thinking,
  children,
}: {
  count: number;
  complete: number;
  failed: number;
  running: number;
  thinking?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="chat-demo__tool-cluster" data-open={open || undefined}>
      <button
        type="button"
        className="chat-demo__tool-cluster-summary"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="chat-demo__tool-cluster-chevron">{open ? <ChevronDown /> : <ChevronRight />}</span>
        <strong>{count} 次工具调用</strong>
        <span className="chat-demo__tool-cluster-counts">
          <span data-status="complete">{complete} 成功</span>
          {failed > 0 && <span data-status="failed">{failed} 失败</span>}
          {running > 0 && <span data-status="running">{running} 执行中</span>}
        </span>
        <span className="chat-demo__tool-cluster-action">{open ? "收起" : "展开"}</span>
      </button>
      {open && (
        <div className="chat-demo__tool-cluster-body">
          {thinking && <div className="chat-demo__tool-cluster-thinking">{thinking}</div>}
          <div className="chat-demo__tool-group chat-demo__tool-group--long">{children}</div>
        </div>
      )}
    </section>
  );
}

export function ToolRow({
  title,
  detail,
  status,
  children,
}: {
  title: string;
  detail: string;
  status: DemoToolStatus;
  children?: ReactNode;
}) {
  const { t } = useDemoTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const StatusIcon =
    status === "complete" ? CircleCheck : status === "running" ? LoaderCircle : status === "failed" ? CircleX : Clock3;

  return (
    <>
      <div className="chat-demo__tool-row" data-status={status}>
        <div className="chat-demo__tool-summary">
          <span className="chat-demo__tool-status">
            <StatusIcon className={status === "running" ? "is-spinning" : undefined} />
          </span>
          <span className="chat-demo__tool-copy">
            <strong>{title}</strong>
            <small>{detail}</small>
          </span>
          <span className="chat-demo__tool-state">{t(`status.${status}`)}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="chat-demo__tool-detail-button"
            aria-label={t("controls.inspect")}
            onClick={() => setDialogOpen(true)}
          >
            <CodeXml />
          </Button>
        </div>
      </div>
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="chat-demo__tool-dialog sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
          </DialogHeader>
          <div className="chat-demo__tool-dialog-meta">
            <span>{detail}</span>
            <span>{t(`status.${status}`)}</span>
          </div>
          <div className="chat-demo__tool-dialog-output">{children ?? <p>{t("tools.noOutput")}</p>}</div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function AttachmentPills({ names }: { names: string[] }) {
  return (
    <div className="chat-demo__attachments">
      {names.map((name) => (
        <span key={name}>
          <span aria-hidden="true">↗</span>
          {name}
        </span>
      ))}
    </div>
  );
}
