// web/components/chat/QuestionPanel.tsx
// AskUserQuestion 交互问题面板（ACP 标准能力，仿 PermissionPanel 的暖色警示卡片风格，
// 显示在输入框上方，不遮挡消息流）。
//
// 数据流：后端聚合层把 interactive_question 帧投影到 Session Doc root.pendingQuestions
// （60s expiresAt），前端 use-session-state 投影过滤后传入；用户选中选项后点击"提交"
// 按钮 → onRespond 回传 questionId + optionIds（选项 label 数组，按问题顺序），服务端
// CAS 迁移后以 control_response 帧回给 acp-link，组装 content[q_id] = label 注入 agent。
//
// 交互语义：
// - 一个问题投影（questionId）内可能含多个独立问题（requestedSchema.properties 多个），
//   每个问题项独立选中互不干扰；点击"提交"按钮才回传（未全部选中时提交禁用，
//   ACP content 需要每个 q_id 都有答案）
// - 空列表返回 null；pendingQuestions 投影过滤后自动隐藏（用户应答 resolved
//   或 60s 过期 expired）

import type { QuestionProjection } from "@fenix/chat-channel";
import { Check, ChevronDown, ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../src/lib/utils";
import { Button } from "../ui/button";

interface QuestionPanelProps {
  /** 待应答问题列表（已由 use-session-state 做 pending + 未过期过滤） */
  questions: QuestionProjection[];
  /** 选项回传（questionId + 选中选项 label 数组，按问题顺序） */
  onRespond?: (questionId: string, optionIds: string[]) => void;
  className?: string;
}

export function QuestionPanel({ questions, onRespond, className }: QuestionPanelProps) {
  if (questions.length === 0) return null;

  return (
    <div className={cn("chat-interaction-stack", className)}>
      <div className="space-y-2">
        {questions.map((question) => (
          <QuestionCard key={question.questionId} question={question} onRespond={onRespond} />
        ))}
      </div>
    </div>
  );
}

// =============================================================================
// 单个问题卡片 — 多个独立问题项（header + 问题文本 + 选项按钮）+ 提交按钮
// 每个问题项独立选中（index → label），全部选中后提交按钮才可用，
// 提交时按问题顺序合并回传
// =============================================================================

interface QuestionCardProps {
  question: QuestionProjection;
  onRespond?: (questionId: string, optionIds: string[]) => void;
}

function QuestionCard({ question, onRespond }: QuestionCardProps) {
  const { t } = useTranslation("components");
  /** 每个问题项的选中 label（key = 问题项 index；缺省 = 未选择，提交按钮禁用） */
  const [selected, setSelected] = useState<Record<number, string>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const allAnswered = question.questions.every((_, i) => selected[i] !== undefined);
  const item = question.questions[questionIndex];

  if (!item) return null;

  return (
    <section className="chat-interaction-region chat-question-region" aria-label={t("askUser.title")}>
      <header>
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          <strong>{t("askUser.title")}</strong>
          <small>
            {questionIndex + 1}/{question.questions.length}
          </small>
          <ChevronDown className={collapsed ? "is-collapsed" : undefined} />
        </button>
      </header>
      {!collapsed && (
        <div className="chat-question-body">
          <div className="chat-question-copy">
            {item.header && <span>{item.header}</span>}
            <strong>{item.question}</strong>
          </div>
          <div className="chat-question-options">
            {item.options.map((option, optionIndex) => {
              const isSelected = selected[questionIndex] === option.label;
              return (
                <button
                  key={option.label}
                  type="button"
                  className={isSelected ? "is-selected" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => setSelected((previous) => ({ ...previous, [questionIndex]: option.label }))}
                >
                  <span>{isSelected ? <Check /> : String.fromCharCode(65 + optionIndex)}</span>
                  <div>
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </div>
                </button>
              );
            })}
          </div>
          <footer>
            <div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={questionIndex === 0}
                aria-label={t("askUser.previous")}
                onClick={() => setQuestionIndex((index) => Math.max(0, index - 1))}
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                disabled={questionIndex === question.questions.length - 1}
                aria-label={t("askUser.next")}
                onClick={() => setQuestionIndex((index) => Math.min(question.questions.length - 1, index + 1))}
              >
                <ChevronRight />
              </Button>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={!allAnswered}
              onClick={() => {
                if (!allAnswered) return;
                onRespond?.(
                  question.questionId,
                  question.questions.map((_, index) => selected[index] as string),
                );
              }}
            >
              {t("askUser.submit")}
            </Button>
          </footer>
        </div>
      )}
    </section>
  );
}
