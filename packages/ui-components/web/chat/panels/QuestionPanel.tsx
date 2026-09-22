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
//   每个问题项独立选中互不干扰；点击"提交"按钮才回传（未全部选中时提交禁用，
//   ACP content 需要每个 q_id 都有答案）
// - 空列表返回 null；pendingQuestions 投影过滤后自动隐藏（用户应答 resolved
//   或 60s 过期 expired）
//
// 复制自 packages/agent-runtime/web/components/chat/QuestionPanel.tsx。
// 纯化改动：QuestionProjection 改从包内 ../types 导入（不再 import @fenix/chat-channel）；
//   cn 改为包内 ../../lib/cn；Button 改为包内 ../../ui/button；
//   i18n 由宿主 ns=components 收敛到 UI_COMPONENTS_NS 的 chat.components.* key。

import { Check, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
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
 * 复制自 `packages/agent-runtime/web/components/chat/QuestionPanel.tsx`。
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
// 单个问题卡片 — 多个独立问题项（header + 问题文本 + 选项按钮）+ 提交按钮
// 每个问题项独立维护选中 label 数组；单选题替换当前选择，多选题切换选项。
// 全部问题至少选择一项后才可提交。
// =============================================================================

interface QuestionCardProps {
  question: QuestionProjection;
  onRespond?: (questionId: string, answers: Array<string | string[]>) => void;
}

function QuestionCard({ question, onRespond }: QuestionCardProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  /** 每个问题项的选中 label（key = 问题项 index；空数组 = 未选择） */
  const [selected, setSelected] = useState<Record<number, string[]>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const allAnswered = question.questions.every((_, index) => (selected[index]?.length ?? 0) > 0);
  const item = question.questions[questionIndex];

  if (!item) return null;

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
              disabled={questionIndex === 0}
              aria-label={t("chat.components.askUser.previous")}
              onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
            >
              <ChevronLeft />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              disabled={questionIndex === question.questions.length - 1}
              aria-label={t("chat.components.askUser.nextQuestion")}
              onClick={() => setQuestionIndex((index) => Math.min(question.questions.length - 1, index + 1))}
            >
              <ChevronRight />
            </Button>
          </div>
          <div className="flex items-center gap-2">
            {(selected[questionIndex]?.length ?? 0) > 0 && questionIndex < question.questions.length - 1 && (
              <Button type="button" variant="outline" size="sm" onClick={() => setQuestionIndex((index) => index + 1)}>
                {t("chat.components.askUser.next")}
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              disabled={!allAnswered}
              onClick={() => {
                if (!allAnswered) return;
                onRespond?.(
                  question.questionId,
                  question.questions.map((questionItem, index) => {
                    const answers = selected[index] ?? [];
                    return questionItem.multiSelect ? answers : (answers[0] ?? "");
                  }),
                );
              }}
            >
              {t("chat.components.askUser.submit")}
            </Button>
          </div>
        </>
      }
    >
      <div>
        {item.header && <span className="block text-[11px] text-[#8a96a8]">{item.header}</span>}
        <strong className="mt-[3px] block text-[14px] text-[#26364f]">{item.question}</strong>
      </div>
      <div className="mt-[9px] grid gap-[5px]">
        {item.options.map((option, optionIndex) => {
          const isSelected = selected[questionIndex]?.includes(option.label) ?? false;
          return (
            <button
              key={option.label}
              type="button"
              // 源 `.chat-question-options > button`（+ `:hover`/`.is-selected` 两态；两态互斥，不靠生成顺序）
              className={cn(
                "flex items-start gap-[9px] rounded-lg p-2 text-left",
                isSelected ? "bg-[#f0f5ff] text-[#245fc9]" : "text-[#53627a] hover:bg-[#f0f5ff] hover:text-[#245fc9]",
              )}
              aria-pressed={isSelected}
              onClick={() =>
                setSelected((previous) => {
                  const current = previous[questionIndex] ?? [];
                  const next = item.multiSelect
                    ? current.includes(option.label)
                      ? current.filter((label) => label !== option.label)
                      : [...current, option.label]
                    : [option.label];
                  return { ...previous, [questionIndex]: next };
                })
              }
            >
              <span className="grid h-[21px] w-[21px] flex-[0_0_21px] place-items-center rounded-[5px] bg-[#eef1f5] text-[11px]">
                {isSelected ? <Check className="h-[13px] w-[13px]" /> : String.fromCharCode(65 + optionIndex)}
              </span>
              <div>
                <strong className="block text-[12px]">{option.label}</strong>
                {option.description && (
                  <small className="mt-0.5 block text-[11px] text-[#8a96a8]">{option.description}</small>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </ChatInteractionRegion>
  );
}
