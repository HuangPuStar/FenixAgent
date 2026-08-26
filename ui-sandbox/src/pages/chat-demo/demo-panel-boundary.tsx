import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./demo-ui";
import { useDemoTranslation } from "./use-demo-copy";

interface BoundaryState {
  failed: boolean;
}

/** Isolates a demo panel so one failed mock scene does not hide the other review surfaces. */
export class DemoPanelBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Chat demo panel failed", error, info.componentStack);
  }

  render() {
    if (this.state.failed) {
      return <DemoPanelFallback onRetry={() => this.setState({ failed: false })} />;
    }
    return this.props.children;
  }
}

function DemoPanelFallback({ onRetry }: { onRetry: () => void }) {
  const { t } = useDemoTranslation();
  return (
    <section className="chat-demo__panel-fallback" role="alert">
      <strong>{t("controls.panelError")}</strong>
      <p>{t("controls.panelErrorDescription")}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        {t("controls.tryAgain")}
      </Button>
    </section>
  );
}
