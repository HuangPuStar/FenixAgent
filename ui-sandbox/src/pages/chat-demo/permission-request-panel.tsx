import { Check, ChevronDown, ChevronUp, CircleAlert, KeyRound, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { Button } from "./demo-ui";
import { useDemoTranslation } from "./use-demo-copy";

type PermissionDecision = "allowOnce" | "allowSession" | "deny";

/** Permission request shown in the input-adjacent interaction region. */
export function PermissionRequestPanel() {
  const { t } = useDemoTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [decision, setDecision] = useState<PermissionDecision | null>(null);

  return (
    <section
      className="chat-demo__interaction-region chat-demo__permission-request"
      aria-label="权限确认"
      aria-live="polite"
    >
      <header>
        <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)}>
          <span className="chat-demo__interaction-icon">
            <KeyRound />
          </span>
          <strong>权限确认</strong>
          <small>{decision ? "已选择" : "Agent 正在等待"}</small>
          {collapsed ? <ChevronUp /> : <ChevronDown />}
        </button>
      </header>
      {!collapsed && (
        <div className="chat-demo__permission-request-body">
          {decision ? (
            <div className="chat-demo__permission-result" data-decision={decision === "deny" ? "deny" : "allow"}>
              <span>{decision === "deny" ? <CircleAlert /> : <Check />}</span>
              <div>
                <strong>{t(`controls.${decision}`)}</strong>
                <small>{decision === "deny" ? "Agent 不会执行这条命令" : "Agent 将按所选范围继续执行"}</small>
              </div>
              <Button type="button" variant="ghost" size="sm" onClick={() => setDecision(null)}>
                修改选择
              </Button>
            </div>
          ) : (
            <>
              <div className="chat-demo__permission-request-copy">
                <span>即将执行</span>
                <strong>{t("permission.title")}</strong>
                <p>{t("permission.risk")}</p>
              </div>
              <code>{t("permission.command")}</code>
              <div className="chat-demo__permission-scope">
                <span>{t("permission.scopeLabel")}</span>
                <strong>{t("permission.scope")}</strong>
              </div>
              <p className="chat-demo__permission-request-audit">
                <ShieldCheck />
                {t("permission.audit")}
              </p>
              <footer>
                <Button type="button" variant="ghost" size="sm" onClick={() => setDecision("deny")}>
                  {t("controls.deny")}
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={() => setDecision("allowSession")}>
                  {t("controls.allowSession")}
                </Button>
                <Button type="button" size="sm" onClick={() => setDecision("allowOnce")}>
                  {t("controls.allowOnce")}
                </Button>
              </footer>
            </>
          )}
        </div>
      )}
    </section>
  );
}
