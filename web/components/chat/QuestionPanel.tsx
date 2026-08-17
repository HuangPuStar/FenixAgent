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
import { Check, HelpCircle } from "lucide-react";
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
  const { t } = useTranslation("components");
  if (questions.length === 0) return null;

  return (
    <div className={cn("w-full max-w-3xl mx-auto px-4", className)}>
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <HelpCircle className="h-4 w-4 text-warning-text" />
          <span className="text-sm font-medium text-warning-text">{t("askUser.title")}</span>
          <span className="text-xs text-text-muted">{t("askUser.description")}</span>
        </div>
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
  const allAnswered = question.questions.every((_, i) => selected[i] !== undefined);

  return (
    <div className="rounded-xl border border-warning-border/30 bg-warning-bg/50 p-4">
      {question.questions.map((item, index) => (
        // QuestionItemProjection 无 id 字段，question 文本是同一问题内唯一标识
        // （aggregator extractQuestionItems 已过滤空 question），用作稳定 key
        <div key={item.question} className="mb-3 last:mb-0">
          {item.header && <div className="text-xs font-medium text-warning-text/80 mb-1">{item.header}</div>}
          <div className="text-sm font-medium text-warning-text mb-2">{item.question}</div>
          <div className="flex flex-wrap gap-2">
            {item.options.map((option) => {
              const isSelected = selected[index] === option.label;
              return (
                <Button
                  key={option.label}
                  variant={isSelected ? "default" : "outline"}
                  size="sm"
                  onClick={() => setSelected((prev) => ({ ...prev, [index]: option.label }))}
                  className={cn(
                    "gap-1.5",
                    isSelected
                      ? "bg-brand text-white hover:bg-brand-light"
                      : "border-warning-border/30 text-warning-text hover:bg-warning-bg",
                  )}
                >
                  {isSelected && <Check className="h-3.5 w-3.5" />}
                  {option.label}
                </Button>
              );
            })}
          </div>
        </div>
      ))}
      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          disabled={!allAnswered}
          onClick={() => {
            if (!allAnswered) return;
            onRespond?.(
              question.questionId,
              question.questions.map((_, i) => selected[i] as string),
            );
          }}
          className="h-8 px-4 bg-brand text-white text-xs font-medium hover:bg-brand-light gap-1.5"
        >
          {t("askUser.submit")}
        </Button>
      </div>
    </div>
  );
}
