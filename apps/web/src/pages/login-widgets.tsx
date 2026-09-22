/**
 * login-widgets.tsx — 登录页本地展示组件
 *
 * 只做展示：左侧品牌列（LoginBrandPanel，含 LoginBrandMark / FeatureCard）与表单输入控件（AuthInput）。
 * 文案全部经 t()，className 与 auth-light-brand.css / auth-light-form.css 成对维护；
 * 表单状态机在 LoginPage.tsx，取数与提交在 login-transport.ts。
 *
 * 这些组件只服务登录页，未出现第二个消费者前不进 `@fenix/ui-components`（§1.2 按包外真实消费点收敛）。
 */

import { CirclePlus, Eye, EyeOff, MessageSquare, ShieldCheck, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";

const assetBase = import.meta.env.BASE_URL;
const brandTags = ["AI Orchestration", "Multi-Agent", "Intelligent Core"];

/** 品牌 Logo；compact 供表单列在窄屏下的小尺寸展示。 */
export function LoginBrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? "auth-light-logo auth-light-logo-compact" : "auth-light-logo"}>
      <div className="auth-light-logo-glow" />
      <img
        className="auth-light-logo-mark"
        src={`${assetBase}brand/fenix-agent-logo-mark.png`}
        alt=""
        aria-hidden="true"
      />
    </div>
  );
}

/** 表单输入行：密码类型自带明文/密文切换。 */
export function AuthInput({
  id,
  label,
  type = "text",
  value,
  placeholder,
  autoComplete,
  required = false,
  onChange,
}: {
  id: string;
  label: string;
  type?: string;
  value: string;
  placeholder: string;
  autoComplete?: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("login");
  const [visible, setVisible] = useState(false);
  const isPassword = type === "password";
  const inputType = isPassword && visible ? "text" : type;

  return (
    <div className="auth-light-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-light-input-wrap">
        <input
          autoComplete={autoComplete}
          className={isPassword ? "auth-light-input auth-light-has-toggle" : "auth-light-input"}
          id={id}
          minLength={isPassword ? 8 : undefined}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          type={inputType}
          value={value}
        />
        {isPassword && (
          <button
            aria-label={visible ? t("hidePassword") : t("showPassword")}
            className="auth-light-toggle"
            onClick={() => setVisible((current) => !current)}
            type="button"
          >
            {visible ? <EyeOff /> : <Eye />}
          </button>
        )}
      </div>
    </div>
  );
}

/** 品牌列中的单张能力卡（图标与文案由调用方传入，保持纯展示）。 */
function FeatureCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  return (
    <div className="auth-light-feature">
      <div className="auth-light-feature-icon">{icon}</div>
      <div className="auth-light-feature-label">
        <strong>{title}</strong>
        {description}
      </div>
    </div>
  );
}

/** 左侧品牌列：Logo、标语、能力卡与能力标签。 */
export function LoginBrandPanel() {
  const { t } = useTranslation("login");

  return (
    <section className="auth-light-brand-panel">
      <LoginBrandMark />
      <div className="auth-light-brand-title">FENIX AGENT</div>
      <div className="auth-light-brand-sub">{t("brandSubtitle")}</div>

      <div className="auth-light-features">
        {[
          { icon: <CirclePlus />, titleKey: "features.orchestration", descKey: "features.orchestrationDesc" },
          { icon: <ShieldCheck />, titleKey: "features.security", descKey: "features.securityDesc" },
          { icon: <MessageSquare />, titleKey: "features.conversation", descKey: "features.conversationDesc" },
          { icon: <Users />, titleKey: "features.organization", descKey: "features.organizationDesc" },
        ].map((feature) => (
          <FeatureCard
            description={t(feature.descKey)}
            icon={feature.icon}
            key={feature.titleKey}
            title={t(feature.titleKey)}
          />
        ))}
      </div>

      <div className="auth-light-tags">
        {brandTags.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
    </section>
  );
}
