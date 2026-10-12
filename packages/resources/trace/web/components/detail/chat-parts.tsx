/**
 * 消息内容分片的渲染。
 *
 * 移植来源：langfuse-lite `components/chat-parts.tsx`。
 *
 * 分层原因：`extractParts`（见 `../../lib/chat-utils`）已经把 Anthropic 的分片数组与 OpenAI 的 `tool_calls`
 * 收敛成同一套 ContentPart，这里只负责「一种分片一种外观」——文本带截断、思考块可折叠、工具调用与工具结果用
 * 卡片——而不是把原始 JSON 摊给用户看。
 *
 * 本次适配：删掉参考实现里的复制 / 下载动作（详情面板不承载这些出口，纯渲染即可）；文案走 `t()`，
 * 配色 token 换成本项目命名。
 */
import { cn } from "@fenix/ui-components/lib/cn";
import { ChevronDown, Sparkles, SquareTerminal } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import type { ContentPart } from "../../lib/chat-utils";

/** 超过该长度的文本先截断，展开后再给全文。 */
const TRUNCATE_CHARS = 1200;

/** 消息正文：截断 + 展开开关；`mono` 用于工具结果这类等宽文本。 */
export function MessageBody({ text, mono }: { text: string; mono?: boolean }) {
  const { t } = useTranslation(TRACE_NS);
  const [expanded, setExpanded] = useState(false);
  const needsTruncation = text.length > TRUNCATE_CHARS;
  const display = needsTruncation && !expanded ? `${text.slice(0, TRUNCATE_CHARS)}…` : text;

  return (
    <div>
      <pre
        className={cn(
          "w-full whitespace-pre-wrap break-words text-xs leading-relaxed text-text-primary",
          mono ? "font-mono text-11 text-text-muted" : "font-sans",
        )}
      >
        {display}
      </pre>
      {needsTruncation && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="mt-1 text-11 font-medium text-text-muted hover:text-text-primary"
        >
          {expanded ? t("detail.showLess") : t("detail.showMore")}
        </button>
      )}
    </div>
  );
}

/** 可折叠的思维链块（Anthropic `thinking` 分片）；默认收起，避免长推理淹没答案。 */
function ThinkingBlock({ text }: { text: string }) {
  const { t } = useTranslation(TRACE_NS);
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-violet-500/20 bg-violet-500/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left"
      >
        <Sparkles className="h-3 w-3 text-violet-500" />
        <span className="text-3xs font-semibold uppercase tracking-wide text-violet-600 dark:text-violet-400">
          {t("detail.thinking")}
        </span>
        <ChevronDown className={cn("ms-auto h-3 w-3 text-text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="border-t border-violet-500/15 px-2 py-1.5">
          <MessageBody text={text} />
        </div>
      )}
    </div>
  );
}

/** 可折叠的工具调用卡（Anthropic `tool_use` / OpenAI `tool_calls`）。 */
function ToolUseBlock({ id, name, input }: { id?: string; name: string; input: unknown }) {
  const [open, setOpen] = useState(false);
  const json = useMemo(() => (typeof input === "string" ? input : JSON.stringify(input ?? {}, null, 2)), [input]);
  return (
    <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.04]">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full cursor-pointer items-center gap-1.5 px-2 py-1 text-left"
      >
        <SquareTerminal className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
        <span className="font-mono text-11 font-medium text-emerald-700 dark:text-emerald-300">{name}</span>
        {id && <span className="truncate font-mono text-3xs opacity-50">{id}</span>}
        <ChevronDown className={cn("ms-auto h-3 w-3 text-text-muted transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-emerald-500/15 px-2 py-1.5 font-mono text-11 leading-relaxed text-text-muted">
          {json}
        </pre>
      )}
    </div>
  );
}

/** 工具结果正文：等宽文本，已知配对 id 时在首行标注。 */
function ToolResultBlock({ id, text }: { id?: string; text: string }) {
  return (
    <div>
      {id && <div className="mb-0.5 font-mono text-3xs text-text-muted/70">↳ {id}</div>}
      <MessageBody text={text} mono />
    </div>
  );
}

/** 渲染消息气泡里的一个归一化分片。 */
export function PartView({ part, mono }: { part: ContentPart; mono?: boolean }) {
  const { t } = useTranslation(TRACE_NS);
  switch (part.type) {
    case "text":
      return part.text ? <MessageBody text={part.text} mono={mono} /> : null;
    case "thinking":
      return part.text ? <ThinkingBlock text={part.text} /> : null;
    case "tool_use":
      return <ToolUseBlock id={part.id} name={part.name} input={part.input} />;
    case "tool_result":
      return part.text ? <ToolResultBlock id={part.id} text={part.text} /> : null;
    case "image":
      return part.url ? (
        <img src={part.url} alt={t("detail.messageImage")} className="max-h-40 rounded-md border border-border" />
      ) : (
        <span className="text-11 text-text-muted italic">{t("detail.image")}</span>
      );
    case "audio":
      return <span className="text-11 text-text-muted italic">{t("detail.audio")}</span>;
    default:
      return <MessageBody text={JSON.stringify(part.raw, null, 2) ?? String(part.raw)} mono />;
  }
}
