/**
 * ObservationPreview —— observation 输入 + 输出的人读摘要。
 *
 * 移植来源：langfuse-lite `components/observation-preview.tsx`。
 *
 * 为什么不直接摊 JSON：
 * - GENERATION：给出模型名、对话上下文（截断正文 + 工具调用简写）与助手答案；
 * - TOOL / SPAN / AGENT / EVENT：给出截断后的输入 / 输出片段。
 *
 * 本次适配：参考实现把摘要做成详情里的第一个页签；本面板的详情固定为 Input / Output / Metadata 三个页签，
 * 摘要改为头部下方常驻的一段，组件本身的摘要逻辑原样保留。同时删掉复制 / 下载动作，文案走 `t()`。
 */
import { cn } from "@fenix/ui-components/lib/cn";
import { truncate } from "@fenix/ui-components/lib/format";
import { ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { TRACE_NS } from "../../i18n/namespace";
import { contentToText, extractMessages, isChatPayload, parseMaybeString } from "../../lib/chat-utils";
import type { TraceObservation } from "../../lib/observation-types";

const MAX_MESSAGES = 10;
const MAX_MSG_CHARS = 140;
const MAX_SNIPPET_CHARS = 260;
const MAX_ANSWER_CHARS = 400;

type ExtractedMessage = NonNullable<ReturnType<typeof extractMessages>>[number];

const ROLE_TEXT: Record<string, string> = {
  system: "text-text-muted",
  user: "text-brand",
  assistant: "text-text-primary",
  tool: "text-orange-600 dark:text-orange-400",
  function: "text-orange-600 dark:text-orange-400",
};

/**
 * 摘要行键：协议没有消息 id，按位置 + 角色派生；直接写 `key={index}` 会被
 * lint/suspicious/noArrayIndexKey 拦下，故由本函数显式派生。
 */
function lineKey(message: ExtractedMessage, index: number): string {
  return `line-${index}-${message.role}`;
}

/** `Read({path: "/x"}) → Write(...)` 形式的工具调用简写。 */
function toolCallsText(calls: unknown): string {
  if (!Array.isArray(calls)) return String(calls ?? "");
  return calls
    .map((call) => {
      const rec = (call ?? {}) as Record<string, unknown>;
      const fn = (rec.function ?? rec) as Record<string, unknown>;
      const name = typeof fn.name === "string" ? fn.name : "tool";
      const args = typeof fn.arguments === "string" ? fn.arguments : JSON.stringify(fn.arguments ?? "");
      return `${name}(${truncate(args, 80)})`;
    })
    .join(" → ");
}

/** 一行消息：角色 + 正文（有工具调用时显示调用简写，那才是这一轮的实际动作）。 */
function MessageLine({ message }: { message: ExtractedMessage }) {
  const text = contentToText(message.content);
  const line = message.toolCalls ? toolCallsText(message.toolCalls) : text;
  return (
    <div className="flex items-baseline gap-1.5 text-xs">
      <span className={cn("w-16 shrink-0 font-mono text-3xs uppercase", ROLE_TEXT[message.role] ?? "text-text-muted")}>
        {message.role}
      </span>
      <span className="min-w-0 truncate text-text-secondary">{truncate(line, MAX_MSG_CHARS)}</span>
    </div>
  );
}

function SectionLabel({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn("text-3xs font-semibold uppercase tracking-wider text-text-muted", className)}>{children}</div>
  );
}

function SnippetBlock({ label, value }: { label: string; value: unknown }) {
  const text = contentToText(value);
  return (
    <div className="space-y-1">
      <SectionLabel>{label}</SectionLabel>
      {text ? (
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
          {truncate(text, MAX_SNIPPET_CHARS)}
        </p>
      ) : (
        <p className="text-xs text-text-muted">—</p>
      )}
    </div>
  );
}

/**
 * GENERATION 输出里见过的答案形状：
 * - `{text, thinking}` —— 推理模型（deepseek 等）；`thinking` 是思维链，`text` 是最终答案；
 * - 消息数组 —— 助手 / 工具轮次，最终答案嵌在其中；
 * - 其它 —— 自由文本或 JSON。
 */
type AnswerView =
  | { kind: "reasoning"; text: string; thinking: string | null }
  | { kind: "chat"; messages: NonNullable<ReturnType<typeof extractMessages>> }
  | { kind: "text"; text: string };

function extractAnswer(output: unknown): AnswerView | null {
  if (output === null || output === undefined) return null;
  if (typeof output === "object" && !Array.isArray(output)) {
    const rec = output as Record<string, unknown>;
    if (typeof rec.text === "string") {
      return {
        kind: "reasoning",
        text: rec.text,
        thinking: typeof rec.thinking === "string" && rec.thinking ? rec.thinking : null,
      };
    }
  }
  if (isChatPayload(output)) {
    return { kind: "chat", messages: extractMessages(output)! };
  }
  return { kind: "text", text: contentToText(output) };
}

export function ObservationPreview({ observation }: { observation: TraceObservation }) {
  const { t } = useTranslation(TRACE_NS);
  const source = observation;
  const isGeneration = source.type === "GENERATION";

  const messages = useMemo(
    () => (isGeneration ? extractMessages(parseMaybeString(source.input)) : null),
    [source.input, isGeneration],
  );

  function AnswerBlock({ answer }: { answer: AnswerView }) {
    if (answer.kind === "chat") {
      // 最后一条「有正文、不是工具调用」的消息才是答案，其余轮次退成灰色上下文。
      const finalIdx = [...answer.messages]
        .reverse()
        .findIndex((message) => !message.toolCalls && contentToText(message.content).trim() !== "");
      const final = finalIdx === -1 ? null : answer.messages.length - 1 - finalIdx;
      return (
        <div className="space-y-0.5">
          {answer.messages.map((message, index) => {
            const text = contentToText(message.content);
            if (message.toolCalls) return <MessageLine key={lineKey(message, index)} message={message} />;
            return (
              <p
                key={lineKey(message, index)}
                className={cn(
                  "whitespace-pre-wrap break-words text-xs leading-relaxed",
                  index === final ? "text-text-secondary" : "text-text-muted",
                )}
              >
                {truncate(text, MAX_ANSWER_CHARS)}
              </p>
            );
          })}
        </div>
      );
    }

    return (
      <div className="space-y-1">
        <p className="whitespace-pre-wrap break-words text-xs leading-relaxed text-text-secondary">
          {truncate(answer.text, MAX_ANSWER_CHARS)}
        </p>
        {answer.kind === "reasoning" && answer.thinking && (
          <details className="group">
            <summary className="flex cursor-pointer select-none items-center gap-0.5 text-3xs font-semibold uppercase tracking-wider text-text-muted hover:text-text-secondary list-none marker:content-none">
              <ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
              {t("detail.thinking")}
            </summary>
            <p className="mt-1 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-muted">
              {truncate(answer.thinking, 600)}
            </p>
          </details>
        )}
      </div>
    );
  }

  // 模型名可能只在输入里（部分 SDK 不回填 observation.model），这里顺手兜底，避免摘要缺一行关键信息。
  const model =
    source.model ??
    (typeof source.input === "object" && source.input !== null
      ? ((source.input as Record<string, unknown>).model as string | undefined)
      : undefined);

  const answer = useMemo(
    () => (isGeneration ? extractAnswer(parseMaybeString(source.output)) : null),
    [source.output, isGeneration],
  );

  const visible = messages ? messages.slice(-MAX_MESSAGES) : [];
  const hiddenCount = messages ? messages.length - visible.length : 0;

  return (
    <div className="space-y-3">
      {isGeneration && (model || messages) && (
        <div className="space-y-1">
          <SectionLabel>{t("detail.context")}</SectionLabel>
          {model && <div className="font-mono text-11 text-text-muted">{t("detail.modelLine", { model })}</div>}
          {visible.length > 0 && (
            <div className="space-y-0.5">
              {visible.map((message, index) => (
                <MessageLine key={lineKey(message, index)} message={message} />
              ))}
              {hiddenCount > 0 && (
                <p className="text-11 text-text-muted">{t("detail.earlierMessages", { count: hiddenCount })}</p>
              )}
            </div>
          )}
        </div>
      )}

      {isGeneration && (
        <div className="space-y-1">
          <SectionLabel className="text-brand">{t("detail.answer")}</SectionLabel>
          {answer ? <AnswerBlock answer={answer} /> : <p className="text-xs text-text-muted">—</p>}
        </div>
      )}

      {!isGeneration && (
        <>
          <SnippetBlock label={t("detail.snippetInput")} value={source.input} />
          <SnippetBlock label={t("detail.snippetOutput")} value={source.output} />
        </>
      )}
    </div>
  );
}
