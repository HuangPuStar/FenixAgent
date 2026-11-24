import { Button } from "@fenix/ui-components/ui/button";
import { Spinner } from "@fenix/ui-components/ui/spinner";
import { Component, lazy, type ReactNode, Suspense, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FILE_EDITING_NS } from "../i18n/namespace";
import type { MarkdownEditorProps } from "./markdown-editor";

/** Contains a failed editor chunk so the workspace and its drafts remain usable. */
class EditorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}
/** A fresh lazy component on explicit retry avoids React retaining a rejected chunk promise. */
export function LazyMarkdownEditor(props: MarkdownEditorProps) {
  const { t } = useTranslation(FILE_EDITING_NS);
  const [retry, setRetry] = useState(0);
  const Editor = useMemo(() => {
    void retry;
    return lazy(() => import("./markdown-editor").then((module) => ({ default: module.MarkdownEditor })));
  }, [retry]);
  return (
    <EditorBoundary
      key={retry}
      fallback={
        <div role="alert" className="flex items-center gap-2 p-4 text-sm text-red-500">
          {t("loadFailed")}
          <Button variant="outline" size="sm" onClick={() => setRetry((old) => old + 1)}>
            {t("retry")}
          </Button>
        </div>
      }
    >
      <Suspense fallback={<Spinner variant="panel" label={t("loading")} />}>
        <Editor {...props} />
      </Suspense>
    </EditorBoundary>
  );
}
