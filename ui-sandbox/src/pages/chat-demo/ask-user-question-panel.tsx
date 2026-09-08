import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from "lucide-react";
import { useState } from "react";
import { Button } from "./demo-ui";
import { useDemoTranslation } from "./use-demo-copy";

const QUESTIONS = [
  { id: "scope", options: ["preview", "patch", "both", "research"] },
  { id: "density", options: ["compact", "balanced", "comfortable"] },
  { id: "validation", options: ["visual", "prototype", "production"] },
] as const;

/** AskUserQuestion flow shown in the input-adjacent interaction region. */
export function AskUserQuestionPanel() {
  const { t } = useDemoTranslation();
  const [questionIndex, setQuestionIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const question = QUESTIONS[questionIndex];
  const selected = answers[question.id];

  const move = (nextIndex: number) => setQuestionIndex(Math.max(0, Math.min(QUESTIONS.length - 1, nextIndex)));

  return (
    <section className="chat-demo__interaction-region chat-demo__questions" aria-label={t("askUser.dialogTitle")}>
      <header>
        <button type="button" onClick={() => setCollapsed(!collapsed)}>
          <strong>{t("askUser.questions")}</strong>
          <small>
            {questionIndex + 1}/{QUESTIONS.length}
          </small>
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </button>
      </header>
      {!collapsed && (
        <div className="chat-demo__questions-body">
          <div className="chat-demo__question-copy">
            <span>{t(`askUser.items.${question.id}.header`)}</span>
            <strong>{t(`askUser.items.${question.id}.question`)}</strong>
          </div>
          <div className="chat-demo__question-options">
            {question.options.map((option, index) => {
              const isSelected = selected === option;
              return (
                <button
                  key={option}
                  type="button"
                  className={isSelected ? "is-selected" : undefined}
                  aria-pressed={isSelected}
                  onClick={() => setAnswers((current) => ({ ...current, [question.id]: option }))}
                >
                  <span>{isSelected ? <Check /> : String.fromCharCode(65 + index)}</span>
                  <div>
                    <strong>{t(`askUser.items.${question.id}.options.${option}.label`)}</strong>
                    <small>{t(`askUser.items.${question.id}.options.${option}.description`)}</small>
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
                size="icon-xs"
                disabled={questionIndex === 0}
                aria-label={t("askUser.previous")}
                onClick={() => move(questionIndex - 1)}
              >
                <ChevronLeft />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                disabled={questionIndex === QUESTIONS.length - 1}
                aria-label={t("askUser.next")}
                onClick={() => move(questionIndex + 1)}
              >
                <ChevronRight />
              </Button>
            </div>
            <Button type="button" variant="ghost" size="sm" onClick={() => move(questionIndex + 1)}>
              {t("askUser.skip")}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!selected}
              onClick={() => (questionIndex === QUESTIONS.length - 1 ? setCollapsed(true) : move(questionIndex + 1))}
            >
              {questionIndex === QUESTIONS.length - 1 ? t("askUser.submit") : t("askUser.continue")}
            </Button>
          </footer>
        </div>
      )}
    </section>
  );
}
