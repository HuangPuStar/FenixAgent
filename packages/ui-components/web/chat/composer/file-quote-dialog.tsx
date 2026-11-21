import { Check } from "lucide-react";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Button } from "../../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { QuoteTruncatedBadge } from "./quote-truncated-badge";
import type { useFileQuotes } from "./use-file-quotes";

/** Compact optional-comment confirmation shared by every file selection adapter. */
export function FileQuoteDialog({ quotes }: { quotes: ReturnType<typeof useFileQuotes> }) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const errorId = useId();
  const { pending, prepared } = quotes;
  if (!pending) return null;
  const source = pending.source;
  const error = quotes.error ?? prepared?.error;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) quotes.close();
      }}
    >
      <DialogPortal>
        <DialogOverlay className="z-[1001] bg-transparent" />
      </DialogPortal>
      <DialogContent
        aria-modal="true"
        showOverlay={false}
        showCloseButton={false}
        className="z-[1002] gap-2 border-0 bg-transparent p-0 shadow-none sm:max-w-md"
        onEscapeKeyDown={(event) => event.stopPropagation()}
      >
        <DialogTitle className="sr-only">{t("fileQuotes.title")}</DialogTitle>
        <DialogDescription className="sr-only">
          {source.path}
          {source.location ? ` · ${source.location}` : ""}
          {source.unsaved ? ` · ${t("fileQuotes.unsaved")}` : ""}
        </DialogDescription>
        <div className="flex items-center gap-2 rounded-xl border border-border-subtle bg-background p-2 shadow-lg focus-within:border-brand/40 focus-within:ring-2 focus-within:ring-brand/10">
          <Input
            aria-label={t("fileQuotes.comment")}
            aria-invalid={!!error}
            aria-describedby={error ? errorId : undefined}
            value={quotes.comment}
            placeholder={t("fileQuotes.commentPlaceholder")}
            onChange={(event) => quotes.setComment(event.target.value)}
            onKeyDown={(event) => {
              // IME confirmation must finish composing before Enter can add the quote.
              if (event.key !== "Enter" || event.nativeEvent.isComposing || event.keyCode === 229) return;
              event.preventDefault();
              if (prepared?.quote) quotes.confirm();
            }}
            className="h-9 flex-1 rounded-lg border-0 bg-transparent px-3 shadow-none focus-visible:ring-0"
          />
          <Button
            aria-label={t("fileQuotes.confirm")}
            title={t("fileQuotes.confirm")}
            size="icon"
            disabled={!prepared?.quote}
            onClick={quotes.confirm}
            className="rounded-lg"
          >
            <Check className="size-4" />
          </Button>
        </div>
        {(error || (prepared?.quote?.omittedCharacterCount ?? 0) > 0) && (
          <div className="rounded-xl border border-border-subtle bg-background px-4 py-2 shadow-sm">
            <QuoteTruncatedBadge omittedCharacterCount={prepared?.quote?.omittedCharacterCount ?? 0} />
            {error && (
              <p id={errorId} role="alert" className="text-sm text-red-500">
                {t(`fileQuotes.${error}`)}
              </p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
