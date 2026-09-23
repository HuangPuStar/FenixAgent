/**
 * LoginPage.tsx — 登录/注册页
 *
 * 按职责拆分为四个部分（前端规范 §4.7 单文件 500 行）：
 *   - 品牌样式层：auth-light-brand.css（页面外壳 + 品牌列）、auth-light-form.css（表单列）
 *   - 工具类层：LoginPage.css（同目录同名，承载本文件里以工具类写成的那部分中无法用扁平工具类
 *     表达的深层样式，如登录方式切换 tab 的阴影）
 *   - 展示组件：login-widgets.tsx（LoginBrandPanel / LoginBrandMark / AuthInput）
 *   - 传输适配：login-transport.ts（注册开关探测、登录/注册提交）
 * 本文件只保留表单状态机与页面布局组合。
 */

import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type AuthMethod, getPreferredAuthMethod, setPreferredAuthMethod } from "../lib/auth-preference";
import "./auth-light-brand.css";
import "./auth-light-form.css";
import "./LoginPage.css";
import { fetchSignupAllowed, submitLogin } from "./login-transport";
import { AuthInput, LoginBrandMark, LoginBrandPanel } from "./login-widgets";

const particleKeys = ["particle-1", "particle-2", "particle-3", "particle-4", "particle-5", "particle-6"];

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
    void fetchSignupAllowed().then(setSignupAllowed);
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
        const result = await submitLogin({ isSignUp, authMethod, identifier, password, name, rememberLogin });
        if (!result.ok) {
          setError(result.message || t(isSignUp ? "signUpFailed" : "signInFailed"));
          return;
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
      <div aria-hidden="true" className="auth-light-particles">
        {particleKeys.map((key) => (
          <div className="auth-light-particle" key={key} />
        ))}
      </div>

      <LoginBrandPanel />

      <main className="auth-light-panel">
        <div className="auth-light-box">
          <div className="auth-light-mobile-brand">
            <LoginBrandMark compact />
            <p className="auth-light-mobile-title">FENIX AGENT</p>
          </div>

          <h1 className="auth-light-title">{isSignUp ? t("createAccountTitle") : t("welcomeBack")}</h1>
          <p className="auth-light-sub">{isSignUp ? t("createAccountSubtitle") : t("welcomeBackSubtitle")}</p>

          <div className="mb-6 grid grid-cols-2 gap-2 rounded-xl bg-slate-100 p-1.5">
            <button
              type="button"
              onClick={() => switchMethod("email")}
              className={[
                "login-method-tab h-10 rounded-lg text-sm font-semibold transition",
                authMethod === "email" ? "bg-white text-blue-600 is-active" : "text-slate-500",
              ].join(" ")}
            >
              {t("emailTab")}
            </button>
            <button
              type="button"
              onClick={() => switchMethod("phone")}
              className={[
                "login-method-tab h-10 rounded-lg text-sm font-semibold transition",
                authMethod === "phone" ? "bg-white text-blue-600 is-active" : "text-slate-500",
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

        <p className="auth-light-footer">© 2026 Fenix AOS. All rights reserved.</p>
      </main>
    </div>
  );
}
