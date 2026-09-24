// web/components/chat/QuestionPanel.tsx
// AskUserQuestion 交互问题面板（ACP 标准能力，仿 PermissionPanel 的暖色警示卡片风格，
// 显示在输入框上方，不遮挡消息流）。
//
// 数据流：后端聚合层把 interactive_question 帧投影到 Session Doc root.pendingQuestions
// （60s expiresAt），前端 use-session-state 投影过滤后传入；用户选中选项后点击"提交"
// 按钮 → onRespond 回传 questionId + answers（按问题顺序；单选为 string，多选为
// string[]），服务端 CAS 迁移后以 control_response 帧回给 acp-link。
//
// 交互语义：
// - 一个问题投影（questionId）内可能含多个独立问题（requestedSchema.properties 多个），
//   每个问题项独立选中互不干扰；点击"提交"按钮才回传（未全部作答时提交禁用，
//   ACP content 需要每个 q_id 都有答案）
// - 每个问题项除选项外还提供"自定义回答"输入框：**答案就是这段自由文本本身**，
//   走与选项答案完全相同的 `answers` 数组（无新增字段、无第二套消息类型）——
//   协议侧 `answers` 的元素本就是任意非空字符串：session-channel 的
//   `normalizeQuestionAnswers` 保留任意字符串、translator 原样放入
//   `control_response.extra.answers`、acp-link `buildElicitationContent` 以
//   `content[q_id] = <文本>` 组装 elicitation 结果（peri 侧作为回答文本注入 LLM），
//   因此斜杠命令等文本无需任何额外处理。自定义文本与选项**互斥**：输入文本即清空
//   该题的选项选中，反之亦然（一个 q_id 只该有一个答案来源）
// - 空列表返回 null；pendingQuestions 投影过滤后自动隐藏（用户应答 resolved
//   或 60s 过期 expired）
//
// 复制自 packages/agent-runtime/web/components/chat/QuestionPanel.tsx（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
// 纯化改动：QuestionProjection 改从包内 ../types 导入（不再 import @fenix/chat-channel）；
//   cn 改为包内 ../../lib/cn；Button 改为包内 ../../ui/button；
//   i18n 由宿主 ns=components 收敛到 UI_COMPONENTS_NS 的 chat.components.* key。
//
// 深层样式（选项序号徽标的 `flex` 基准值）下沉到同目录 `./QuestionPanel.css`，语义类名为
// `.chat-question-option-index`，源选择器 `.chat-question-options > button > span`。

import "./QuestionPanel.css";

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Spinner } from "../../ui/spinner";
import type { QuestionProjection } from "../types";
import { ChatInteractionRegion, ChatInteractionStack } from "./chat-interaction-region";

interface QuestionPanelProps {
  /** 待应答问题列表（已由 use-session-state 做 pending + 未过期过滤） */
  questions: QuestionProjection[];
  /** 答案回传（按问题顺序；单选为 string，多选为 string[]） */
  onRespond?: (questionId: string, answers: Array<string | string[]>) => void;
  className?: string;
}

/**
 * 交互问题面板：把待应答的 AskUserQuestion 投影渲染成输入框上方的问题卡片列表。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/QuestionPanel.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动：类型、cn、Button 与 i18n 改为包内导入；问题数据与应答由 props 注入，
 * 组件不做投影过滤、不订阅传输层；空列表返回 null（不占位）。
 */
export function QuestionPanel({ questions, onRespond, className }: QuestionPanelProps) {
  if (questions.length === 0) return null;

  return (
    <ChatInteractionStack className={className}>
      {questions.map((question) => (
        <QuestionCard key={question.questionId} question={question} onRespond={onRespond} />
      ))}
    </ChatInteractionStack>
  );
}

// =============================================================================
// 单个问题卡片 — 多个独立问题项（header + 问题文本 + 选项按钮 + 自定义回答输入框）+ 提交按钮
// 每个问题项独立维护选中 label 数组与自定义文本；单选项替换当前选择，多选项切换选项。
// 自定义文本与选项互斥（输入文本清空该题选项，点击选项清空该题文本）。
// 全部问题至少有一个答案（选项或非空文本）后才可提交。
// =============================================================================

/**
 * 提交确认窗口：提交后问题投影未在此时限内消失（服务端 CAS 未生效 / 帧未送达）即回落到
 * 「未确认」态并重新开放提交按钮，避免 WS 静默失败时用户面对一个永久置灰的按钮。
 * 正常往返（action → 服务端 CAS → Yjs 投影）在秒级完成，取 15s 只用于兜底误报。
 */
const SUBMIT_CONFIRM_TIMEOUT_MS = 15_000;

/** 提交态：`submitting` 防重复提交，`unconfirmed` 是超时兜底（可重试）。 */
type SubmitState = "idle" | "submitting" | "unconfirmed";

interface QuestionCardProps {
  question: QuestionProjection;
  onRespond?: (questionId: string, answers: Array<string | string[]>) => void;
}

function QuestionCard({ question, onRespond }: QuestionCardProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  /** 每个问题项的选中 label（key = 问题项 index；空数组 = 未选择） */
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  /** 每个问题项的自定义回答文本（key = 问题项 index；与 selected 分键保存，切题返回后保留已输入内容） */
  const [customAnswers, setCustomAnswers] = useState<Record<number, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const isSubmitting = submitState === "submitting";
  /** 该题是否已有答案：非空自定义文本或至少一个选中选项 */
  const isAnswered = (index: number) =>
    (customAnswers[index] ?? "").trim().length > 0 || (selected[index]?.length ?? 0) > 0;
  const allAnswered = question.questions.every((_, index) => isAnswered(index));
  const item = question.questions[questionIndex];
  const customValue = customAnswers[questionIndex] ?? "";

  // 提交超时兜底：仅在"提交中"计时，问题投影消失（卡片卸载）时随 effect 清理取消。
  useEffect(() => {
    if (submitState !== "submitting") return;
    const timer = setTimeout(() => setSubmitState("unconfirmed"), SUBMIT_CONFIRM_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [submitState]);

  if (!item) return null;

  /** 提交载荷：按问题顺序，单选 string / 多选 string[]；自定义文本与选项答案同形（见文件头）。 */
  const answers = question.questions.map((questionItem, index) => {
    const custom = (customAnswers[index] ?? "").trim();
    if (custom.length > 0) return questionItem.multiSelect ? [custom] : custom;
    const labels = selected[index] ?? [];
    return questionItem.multiSelect ? labels : (labels[0] ?? "");
  });

  const handleSubmit = () => {
    if (!allAnswered || isSubmitting) return;
    setSubmitState("submitting");
    onRespond?.(question.questionId, answers);
  };

  /** 答案一旦改动，上一次提交的「未确认」提示即失效（它描述的是旧载荷）。 */
  const clearUnconfirmed = () => setSubmitState((state) => (state === "unconfirmed" ? "idle" : state));

  const selectOption = (label: string) => {
    clearUnconfirmed();
    // 选中选项即该题的答案来源变为选项：清掉该题自定义文本（一个 q_id 只有一个答案）
    setCustomAnswers((previous) => {
      if (!(questionIndex in previous)) return previous;
      const next = { ...previous };
      delete next[questionIndex];
      return next;
    });
    setSelected((previous) => {
      const current = previous[questionIndex] ?? [];
      const next = item.multiSelect
        ? current.includes(label)
          ? current.filter((selectedLabel) => selectedLabel !== label)
          : [...current, label]
        : [label];
      return { ...previous, [questionIndex]: next };
    });
  };

  return (
    <ChatInteractionRegion
      slot="chat-question-region"
      label={t("chat.components.askUser.title")}
      collapsed={collapsed}
      onToggleCollapsed={() => setCollapsed((value) => !value)}
      title={t("chat.components.askUser.title")}
      hint={`${questionIndex + 1}/${question.questions.length}`}
      footer={
        <>
          <div className="mr-auto flex">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={questionIndex === 0 || isSubmitting}
              aria-label={t("chat.components.askUser.previous")}
              onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={questionIndex === question.questions.length - 1 || isSubmitting}
              aria-label={t("chat.components.askUser.nextQuestion")}
              onClick={() => setQuestionIndex((index) => Math.min(question.questions.length - 1, index + 1))}
            >
              <ChevronRight />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {submitState === "unconfirmed" && (
              <span role="status" className="text-3xs text-destructive">
                {t("chat.components.askUser.submitUnconfirmed")}
              </span>
            )}
            {isAnswered(questionIndex) && questionIndex < question.questions.length - 1 && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={isSubmitting}
                onClick={() => setQuestionIndex((index) => index + 1)}
              >
                {t("chat.components.askUser.next")}
              </Button>
            )}
            <Button type="button" size="sm" disabled={!allAnswered || isSubmitting} onClick={handleSubmit}>
              {isSubmitting && <Spinner size="xs" className="text-current" />}
              {isSubmitting ? t("chat.components.askUser.submitting") : t("chat.components.askUser.submit")}
            </Button>
          </div>
        </>
      }
    >
      <div>
        {item.header && <span className="block text-3xs text-gray-400">{item.header}</span>}
        <strong className="mt-0.75 block text-sm text-slate-700">{item.question}</strong>
      </div>
      <div className="mt-2.25 grid gap-1.25">
        {item.options.map((option, optionIndex) => {
          const isSelected = selected[questionIndex]?.includes(option.label) ?? false;
          return (
            <button
              key={option.label}
              type="button"
              // 源 `.chat-question-options > button`（+ `:hover`/`.is-selected` 两态；两态互斥，不靠生成顺序）
              className={cn(
                "flex items-start gap-2.25 rounded-lg p-2 text-left",
                isSelected ? "bg-blue-50 text-blue-700" : "text-slate-600 hover:bg-blue-50 hover:text-blue-700",
              )}
              aria-pressed={isSelected}
              disabled={isSubmitting}
              onClick={() => selectOption(option.label)}
            >
              {/* 源 `.chat-question-options > button > span`（序号/勾选徽标；`flex` 基准值在 ./QuestionPanel.css）。 */}
              <span className="chat-question-option-index grid h-5.25 w-5.25 place-items-center rounded-sm bg-gray-100 text-3xs">
                {isSelected ? <Check className="h-3.25 w-3.25" /> : String.fromCharCode(65 + optionIndex)}
              </span>
              <div>
                <strong className="block text-xs">{option.label}</strong>
                {option.description && (
                  <small className="mt-0.5 block text-3xs text-gray-400">{option.description}</small>
                )}
              </div>
            </button>
          );
        })}
      </div>
      {/* 自定义回答：输入即成为该题答案（提交载荷与选项答案同形），Enter 提交；空文本不算作答。 */}
      <label className="mt-2.25 grid gap-1.25">
        <span className="text-3xs text-gray-400">{t("chat.components.askUser.customLabel")}</span>
        <Input
          className="h-8 text-xs"
          value={customValue}
          disabled={isSubmitting}
          placeholder={t("chat.components.askUser.customPlaceholder")}
          onChange={(event) => {
            clearUnconfirmed();
            const value = event.currentTarget.value;
            setCustomAnswers((previous) => ({ ...previous, [questionIndex]: value }));
            // 输入文本即该题的答案来源变为自定义文本：清掉该题选项选中（一个 q_id 只有一个答案）
            setSelected((previous) =>
              (previous[questionIndex]?.length ?? 0) === 0 ? previous : { ...previous, [questionIndex]: [] },
            );
          }}
          onKeyDown={(event) => {
            // Enter 提交（与提交按钮同一条载荷）；Shift+Enter / 输入法组合中不拦截。
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            handleSubmit();
          }}
        />
      </label>
    </ChatInteractionRegion>
  );
}
