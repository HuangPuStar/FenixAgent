import { useNavigate } from "@tanstack/react-router";
import { CirclePlus, Eye, EyeOff, MessageSquare, ShieldCheck, Users } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient, signUpWithPhone } from "../lib/auth-client";
import { type AuthMethod, getPreferredAuthMethod, setPreferredAuthMethod } from "../lib/auth-preference";
import { encryptPassword } from "../lib/password-crypto";

const brandTags = ["AI Orchestration", "Multi-Agent", "Intelligent Core"];
const particleKeys = ["particle-1", "particle-2", "particle-3", "particle-4", "particle-5", "particle-6"];

function AuthLightStyles() {
  return (
    <style>{`
      .auth-light-page,
      .auth-light-page * {
        box-sizing: border-box;
      }

      .auth-light-page {
        position: relative;
        display: flex;
        min-height: 100dvh;
        overflow: hidden;
        background: #f0f3f8;
        color: #1a1a2e;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
        -webkit-font-smoothing: antialiased;
      }

      .auth-light-page::before {
        content: "";
        position: fixed;
        inset: 0;
        z-index: 0;
        pointer-events: none;
        background:
          radial-gradient(900px circle at 15% 50%, rgba(18, 46, 141, 0.06), transparent 55%),
          radial-gradient(700px circle at 75% 25%, rgba(19, 85, 216, 0.04), transparent 50%),
          radial-gradient(500px circle at 85% 75%, rgba(18, 46, 141, 0.03), transparent 50%);
        animation: authBgBreathe 12s ease-in-out infinite alternate;
      }

      .auth-light-particles {
        position: fixed;
        inset: 0;
        z-index: 0;
        overflow: hidden;
        pointer-events: none;
      }

      .auth-light-particle {
        position: absolute;
        border-radius: 50%;
        background: radial-gradient(circle, rgba(19, 85, 216, 0.35), transparent 70%);
        animation: authParticleFloat linear infinite;
      }

      .auth-light-particle:nth-child(1) {
        width: 4px;
        height: 4px;
        left: 12%;
        top: 20%;
        animation-duration: 18s;
      }

      .auth-light-particle:nth-child(2) {
        width: 6px;
        height: 6px;
        left: 25%;
        top: 60%;
        animation-duration: 22s;
        animation-delay: 2s;
        background: radial-gradient(circle, rgba(18, 46, 141, 0.3), transparent 70%);
      }

      .auth-light-particle:nth-child(3) {
        width: 3px;
        height: 3px;
        left: 40%;
        top: 30%;
        animation-duration: 15s;
        animation-delay: 4s;
      }

      .auth-light-particle:nth-child(4) {
        width: 5px;
        height: 5px;
        left: 55%;
        top: 70%;
        animation-duration: 20s;
        animation-delay: 1s;
        background: radial-gradient(circle, rgba(19, 85, 216, 0.3), transparent 70%);
      }

      .auth-light-particle:nth-child(5) {
        width: 4px;
        height: 4px;
        left: 70%;
        top: 15%;
        animation-duration: 25s;
        animation-delay: 3s;
      }

      .auth-light-particle:nth-child(6) {
        width: 7px;
        height: 7px;
        left: 82%;
        top: 55%;
        animation-duration: 17s;
        animation-delay: 5s;
        background: radial-gradient(circle, rgba(18, 46, 141, 0.2), transparent 70%);
      }

      .auth-light-brand-panel {
        position: relative;
        z-index: 1;
        display: flex;
        flex: 1.15;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        padding: 60px;
        background: linear-gradient(135deg, #122e8d, #1a4aad);
      }

      .auth-light-brand-panel::before {
        content: "";
        position: absolute;
        inset: 0;
        pointer-events: none;
        background: radial-gradient(800px circle at 30% 40%, rgba(255, 255, 255, 0.08), transparent 60%);
      }

      .auth-light-brand-panel::after {
        content: "";
        position: absolute;
        top: 8%;
        right: 0;
        width: 1px;
        height: 84%;
        background: linear-gradient(to bottom, transparent, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.2), rgba(255, 255, 255, 0.12), transparent);
        animation: authDividerPulse 4s ease-in-out infinite;
      }

      .auth-light-logo {
        position: relative;
        width: 110px;
        height: 110px;
        margin-bottom: 28px;
      }

      .auth-light-logo.auth-light-logo-compact {
        width: 72px;
        height: 72px;
        margin: 0 auto 14px;
      }

      .auth-light-logo img {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .auth-light-logo-glow {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 140px;
        height: 140px;
        border-radius: 50%;
        transform: translate(-50%, -50%);
        pointer-events: none;
        background: radial-gradient(circle, rgba(255, 215, 0, 0.08), transparent 70%);
        animation: authRingExpand 4s ease-in-out infinite;
      }

      .auth-light-logo-compact .auth-light-logo-glow {
        width: 92px;
        height: 92px;
      }

      .auth-light-brand-title {
        margin-bottom: 10px;
        color: #fff;
        font-size: 38px;
        font-weight: 700;
        letter-spacing: 0.15em;
        animation: authTitleFade 0.8s ease-out both;
      }

      .auth-light-brand-sub {
        margin-bottom: 44px;
        color: rgba(255, 255, 255, 0.6);
        font-size: 17px;
        font-weight: 300;
        letter-spacing: 0.08em;
        animation: authTitleFade 0.8s 0.15s ease-out both;
      }

      .auth-light-features {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
        width: 100%;
        max-width: 400px;
        animation: authTitleFade 0.8s 0.3s ease-out both;
      }

      .auth-light-feature {
        padding: 14px 18px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.08);
        transition: all 0.3s;
      }

      .auth-light-feature:hover {
        border-color: rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.14);
        transform: translateY(-2px);
      }

      .auth-light-feature-icon {
        width: 28px;
        height: 28px;
        margin-bottom: 8px;
        color: #b8d4ff;
      }

      .auth-light-feature-icon svg {
        width: 100%;
        height: 100%;
        stroke-width: 1.6;
      }

      .auth-light-feature-label {
        color: rgba(255, 255, 255, 0.55);
        font-size: 12px;
        line-height: 1.4;
        letter-spacing: 0.04em;
      }

      .auth-light-feature-label strong {
        display: block;
        margin-bottom: 2px;
        color: #fff;
        font-size: 13px;
        font-weight: 500;
      }

      .auth-light-tags {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 12px;
        margin-top: 32px;
        animation: authTitleFade 0.8s 0.45s ease-out both;
      }

      .auth-light-tags span {
        padding: 5px 14px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 20px;
        color: rgba(255, 255, 255, 0.35);
        font-size: 12px;
        letter-spacing: 0.04em;
        transition: all 0.3s;
      }

      .auth-light-tags span:hover {
        border-color: rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.7);
      }

      .auth-light-panel {
        position: relative;
        z-index: 1;
        display: flex;
        flex: 0.95;
        flex-direction: column;
        justify-content: center;
        padding: 60px 80px;
      }

      .auth-light-box {
        width: 100%;
        max-width: 420px;
        animation: authPanelSlide 0.7s 0.2s ease-out both;
      }

      .auth-light-mobile-brand {
        display: none;
        margin-bottom: 32px;
        text-align: center;
      }

      .auth-light-mobile-title {
        color: #122e8d;
        font-size: 20px;
        font-weight: 700;
        letter-spacing: 0.15em;
      }

      .auth-light-title {
        margin: 0 0 4px;
        color: #122e8d;
        font-size: 28px;
        font-weight: 600;
        line-height: 1.2;
        letter-spacing: 0.04em;
      }

      .auth-light-sub {
        margin: 0 0 36px;
        color: rgba(26, 26, 46, 0.4);
        font-size: 13px;
        letter-spacing: 0.02em;
      }

      .auth-light-form {
        display: flex;
        flex-direction: column;
        gap: 20px;
      }

      .auth-light-field {
        position: relative;
      }

      .auth-light-field label {
        display: block;
        margin-bottom: 6px;
        color: rgba(26, 26, 46, 0.5);
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.03em;
      }

      .auth-light-input-wrap {
        position: relative;
      }

      .auth-light-input {
        width: 100%;
        padding: 13px 16px;
        border: 1px solid #dce0e8;
        border-radius: 10px;
        outline: none;
        background: #fff;
        color: #1a1a2e;
        font-size: 15px;
        transition: all 0.25s;
      }

      .auth-light-input.auth-light-has-toggle {
        padding-right: 42px;
      }

      .auth-light-input:focus {
        border-color: #1355d8;
        box-shadow: 0 0 0 3px rgba(19, 85, 216, 0.1);
      }

      .auth-light-input::placeholder {
        color: rgba(26, 26, 46, 0.2);
      }

      .auth-light-input:-webkit-autofill {
        -webkit-box-shadow: 0 0 0 30px #fff inset !important;
        -webkit-text-fill-color: #1a1a2e !important;
      }

      .auth-light-toggle {
        position: absolute;
        top: 50%;
        right: 12px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        background: transparent;
        color: rgba(26, 26, 46, 0.25);
        cursor: pointer;
        transform: translateY(-50%);
        transition: color 0.2s;
      }

      .auth-light-toggle:hover {
        color: rgba(26, 26, 46, 0.5);
      }

      .auth-light-toggle svg {
        width: 18px;
        height: 18px;
      }

      .auth-light-options,
      .auth-light-terms {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-top: -2px;
        margin-bottom: 8px;
        color: rgba(26, 26, 46, 0.45);
        font-size: 13px;
      }

      .auth-light-terms {
        align-items: flex-start;
        justify-content: flex-start;
        gap: 8px;
        line-height: 1.5;
      }

      .auth-light-checkbox {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        transition: color 0.2s;
      }

      .auth-light-checkbox:hover,
      .auth-light-terms:hover {
        color: rgba(26, 26, 46, 0.65);
      }

      .auth-light-checkbox input,
      .auth-light-terms input {
        width: 16px;
        height: 16px;
        accent-color: #1355d8;
        cursor: pointer;
      }

      .auth-light-terms input {
        flex: 0 0 auto;
        margin-top: 2px;
      }

      .auth-light-link {
        position: relative;
        border: 0;
        background: transparent;
        color: #1355d8;
        font-size: 13px;
        text-decoration: none;
        opacity: 0.7;
        cursor: pointer;
        transition: opacity 0.2s;
      }

      .auth-light-link::after {
        content: "";
        position: absolute;
        bottom: -1px;
        left: 0;
        width: 0;
        height: 1px;
        background: #1355d8;
        transition: width 0.25s;
      }

      .auth-light-link:hover {
        opacity: 1;
      }

      .auth-light-link:hover::after {
        width: 100%;
      }

      .auth-light-error {
        margin: -4px 0 0;
        padding: 10px 12px;
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 10px;
        background: rgba(239, 68, 68, 0.06);
        color: rgba(200, 38, 38, 0.86);
        font-size: 13px;
      }

      .auth-light-submit {
        position: relative;
        width: 100%;
        min-height: 50px;
        overflow: hidden;
        padding: 15px;
        border: 0;
        border-radius: 10px;
        background: linear-gradient(135deg, #122e8d, #1355d8);
        color: #fff;
        cursor: pointer;
        font-size: 15px;
        font-weight: 600;
        letter-spacing: 0.04em;
        transition: all 0.35s;
      }

      .auth-light-submit::before {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.15), transparent);
        transform: translateX(-100%);
        transition: transform 0.6s;
      }

      .auth-light-submit:hover {
        box-shadow: 0 8px 32px rgba(18, 46, 141, 0.3);
        filter: brightness(1.08);
        transform: translateY(-2px);
      }

      .auth-light-submit:hover::before {
        transform: translateX(100%);
      }

      .auth-light-submit:active {
        transform: translateY(0);
      }

      .auth-light-submit:disabled {
        cursor: not-allowed;
        opacity: 0.78;
      }

      .auth-light-spinner {
        display: inline-block;
        width: 20px;
        height: 20px;
        border: 2px solid rgba(255, 255, 255, 0.25);
        border-top-color: #fff;
        border-radius: 50%;
        animation: authSpin 0.6s linear infinite;
      }

      .auth-light-switch {
        margin-top: 24px;
        color: rgba(26, 26, 46, 0.35);
        font-size: 13px;
        text-align: center;
      }

      .auth-light-footer {
        position: absolute;
        right: 0;
        bottom: 28px;
        left: 0;
        z-index: 1;
        margin: 0;
        color: rgba(26, 26, 46, 0.15);
        font-size: 12px;
        letter-spacing: 0.03em;
        text-align: center;
      }

      @keyframes authBgBreathe {
        0% {
          opacity: 0.8;
          transform: scale(1);
        }
        100% {
          opacity: 1;
          transform: scale(1.04);
        }
      }

      @keyframes authParticleFloat {
        0% {
          opacity: 0;
          transform: translateY(0) translateX(0);
        }
        10%,
        90% {
          opacity: 1;
        }
        100% {
          opacity: 0;
          transform: translateY(-120vh) translateX(40px);
        }
      }

      @keyframes authDividerPulse {
        0%,
        100% {
          opacity: 0.6;
        }
        50% {
          opacity: 1;
        }
      }

      @keyframes authRingExpand {
        0%,
        100% {
          opacity: 0.6;
          transform: translate(-50%, -50%) scale(1);
        }
        50% {
          opacity: 1;
          transform: translate(-50%, -50%) scale(1.25);
        }
      }

      @keyframes authTitleFade {
        0% {
          opacity: 0;
          transform: translateY(12px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }

      @keyframes authPanelSlide {
        0% {
          opacity: 0;
          transform: translateX(20px);
        }
        100% {
          opacity: 1;
          transform: translateX(0);
        }
      }

      @keyframes authSpin {
        to {
          transform: rotate(360deg);
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .auth-light-page::before,
        .auth-light-particle,
        .auth-light-logo img,
        .auth-light-logo-glow,
        .auth-light-brand-title,
        .auth-light-brand-sub,
        .auth-light-features,
        .auth-light-tags,
        .auth-light-box {
          animation: none;
        }
      }

      @media (max-width: 1024px) {
        .auth-light-brand-panel {
          padding: 40px;
        }

        .auth-light-panel {
          padding: 40px 48px;
        }

        .auth-light-brand-title {
          font-size: 32px;
        }

        .auth-light-features {
          grid-template-columns: 1fr;
        }
      }

      @media (max-width: 820px) {
        .auth-light-brand-panel {
          display: none;
        }

        .auth-light-panel {
          flex: 1;
          align-items: center;
          padding: 48px 32px;
        }

        .auth-light-box {
          max-width: 420px;
        }

        .auth-light-mobile-brand {
          display: block;
        }
      }

      @media (max-width: 480px) {
        .auth-light-panel {
          padding: 32px 20px 64px;
        }

        .auth-light-title {
          font-size: 24px;
        }

        .auth-light-options {
          align-items: flex-start;
          flex-direction: column;
          gap: 12px;
        }

        .auth-light-footer {
          bottom: 18px;
        }
      }
    `}</style>
  );
}

const assetBase = import.meta.env.BASE_URL;

function LoginBrandMark({ compact = false }: { compact?: boolean }) {
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

function AuthInput({
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

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("login");
  const [isSignUp, setIsSignUp] = useState(false);
  const [authMethod, setAuthMethod] = useState<AuthMethod>(() => getPreferredAuthMethod());
  const [signupAllowed, setSignupAllowed] = useState(true);
  const [email, setEmail] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [name, setName] = useState("");
  const [rememberLogin, setRememberLogin] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    fetch("/api/auth/signup-status")
      .then((res) => res.json())
      .then((data) => setSignupAllowed(data.signupAllowed === true))
      .catch(() => setSignupAllowed(true));
  }, []);

  const switchMode = useCallback((nextIsSignUp: boolean) => {
    setIsSignUp(nextIsSignUp);
    setError("");
    setConfirmPassword("");
  }, []);

  const switchMethod = useCallback((nextMethod: AuthMethod) => {
    setAuthMethod(nextMethod);
    setPreferredAuthMethod(nextMethod);
    setError("");
    setConfirmPassword("");
  }, []);

  const handleSubmit = useCallback(
    async (e: FormEvent) => {
      e.preventDefault();
      setError("");
      const identifier = authMethod === "phone" ? phoneNumber.trim() : email.trim();

      if (isSignUp && password !== confirmPassword) {
        setError(t("passwordMismatch"));
        return;
      }

      setLoading(true);

      try {
        const encPassword = await encryptPassword(password);
        if (isSignUp && authMethod === "phone") {
          const res = await signUpWithPhone({
            phoneNumber: identifier,
            password: encPassword,
            name: name || identifier,
          });
          if (res.error) {
            setError(res.error.message || t("signUpFailed"));
            return;
          }
        } else if (isSignUp) {
          const res = await authClient.signUp.email({
            email: identifier,
            password: encPassword,
            name: name || identifier.split("@")[0],
          });
          if (res.error) {
            setError(res.error.message || t("signUpFailed"));
            return;
          }
        } else if (authMethod === "phone") {
          const res = await authClient.signIn.phoneNumber({
            phoneNumber: identifier,
            password: encPassword,
            rememberMe: rememberLogin,
          });
          if (res.error) {
            setError(res.error.message || t("signInFailed"));
            return;
          }
        } else {
          const res = await authClient.signIn.email({
            email: identifier,
            password: encPassword,
          });
          if (res.error) {
            setError(res.error.message || t("signInFailed"));
            return;
          }
        }
        await navigate({ to: "/" });
      } catch (err) {
        setError(err instanceof Error ? err.message : t("unknownError"));
      } finally {
        setLoading(false);
      }
    },
    [authMethod, confirmPassword, email, isSignUp, name, navigate, password, phoneNumber, rememberLogin, t],
  );

  return (
    <div className="auth-light-page">
      <AuthLightStyles />
      <div aria-hidden="true" className="auth-light-particles">
        {particleKeys.map((key) => (
          <div className="auth-light-particle" key={key} />
        ))}
      </div>

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

      <main className="auth-light-panel">
        <div className="auth-light-box">
          <div className="auth-light-mobile-brand">
            <LoginBrandMark compact />
            <p className="auth-light-mobile-title">FENIX AGENT</p>
          </div>

          <h1 className="auth-light-title">{isSignUp ? t("createAccountTitle") : t("welcomeBack")}</h1>
          <p className="auth-light-sub">{isSignUp ? t("createAccountSubtitle") : t("welcomeBackSubtitle")}</p>

          <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl bg-[#eef4fb] p-1.5">
            <button
              type="button"
              onClick={() => switchMethod("email")}
              className={[
                "h-10 rounded-lg text-[14px] font-semibold transition",
                authMethod === "email"
                  ? "bg-white text-[#176cff] shadow-[0_8px_20px_rgba(30,108,255,0.12)]"
                  : "text-[#6d7f99]",
              ].join(" ")}
            >
              {t("emailTab")}
            </button>
            <button
              type="button"
              onClick={() => switchMethod("phone")}
              className={[
                "h-10 rounded-lg text-[14px] font-semibold transition",
                authMethod === "phone"
                  ? "bg-white text-[#176cff] shadow-[0_8px_20px_rgba(30,108,255,0.12)]"
                  : "text-[#6d7f99]",
              ].join(" ")}
            >
              {t("phoneTab")}
            </button>
          </div>

          <form className="auth-light-form" onSubmit={handleSubmit}>
            {isSignUp && (
              <AuthInput
                autoComplete="name"
                id="signup-name"
                label={t("username")}
                onChange={setName}
                placeholder={t("usernamePlaceholder")}
                required
                value={name}
              />
            )}

            <AuthInput
              id={authMethod === "phone" ? "auth-phone" : "auth-email"}
              label={authMethod === "phone" ? t("phoneNumber") : isSignUp ? t("email") : t("account")}
              type={authMethod === "phone" ? "tel" : "email"}
              value={authMethod === "phone" ? phoneNumber : email}
              onChange={authMethod === "phone" ? setPhoneNumber : setEmail}
              placeholder={
                authMethod === "phone"
                  ? t("phoneNumberPlaceholder")
                  : isSignUp
                    ? t("enterpriseEmailPlaceholder")
                    : t("accountPlaceholder")
              }
              autoComplete={authMethod === "phone" ? "tel" : "email"}
              required
            />

            <AuthInput
              autoComplete={isSignUp ? "new-password" : "current-password"}
              id="auth-password"
              label={isSignUp ? t("setPassword") : t("password")}
              onChange={setPassword}
              placeholder={isSignUp ? t("setPasswordPlaceholder") : t("passwordPlaceholder")}
              required
              type="password"
              value={password}
            />

            {isSignUp && (
              <AuthInput
                autoComplete="new-password"
                id="signup-confirm-password"
                label={t("confirmPassword")}
                onChange={setConfirmPassword}
                placeholder={t("confirmPasswordPlaceholder")}
                required
                type="password"
                value={confirmPassword}
              />
            )}

            {/* 忘记密码 / 用户协议 / 隐私政策 对应页面暂未实现，先隐藏这些入口；注册也不再强制勾选协议 */}
            {!isSignUp && (
              <div className="auth-light-options">
                <label className="auth-light-checkbox">
                  <input checked={rememberLogin} onChange={(e) => setRememberLogin(e.target.checked)} type="checkbox" />
                  <span>{t("rememberLogin")}</span>
                </label>
              </div>
            )}

            {error && <p className="auth-light-error">{error}</p>}

            <button className="auth-light-submit" disabled={loading} type="submit">
              {loading ? <span className="auth-light-spinner" /> : isSignUp ? t("signupButton") : t("loginButton")}
            </button>
          </form>

          {signupAllowed && (
            <div className="auth-light-switch">
              {isSignUp ? t("alreadyHaveAccount") : t("noAccount")}{" "}
              <button className="auth-light-link" onClick={() => switchMode(!isSignUp)} type="button">
                {isSignUp ? t("backToSignIn") : t("clickSignUp")}
              </button>
            </div>
          )}
        </div>

        <p className="auth-light-footer">© 2026 Fenix Agent. All rights reserved.</p>
      </main>
    </div>
  );
}
