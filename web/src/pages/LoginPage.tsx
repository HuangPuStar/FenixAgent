import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient, signUpWithPhone } from "../lib/auth-client";
import { type AuthMethod, getPreferredAuthMethod, setPreferredAuthMethod } from "../lib/auth-preference";
import { encryptPassword } from "../lib/password-crypto";

function LoginBrandMark({ compact = false }: { compact?: boolean }) {
  const assetBase = import.meta.env.BASE_URL;

  return (
    <div
      className={
        compact
          ? "mx-auto flex h-16 w-16 items-center justify-center rounded-[18px] border border-white/35 bg-white/12 shadow-[0_18px_42px_rgba(11,40,118,0.22)]"
          : "mx-auto flex h-24 w-24 items-center justify-center rounded-full border border-white/24 bg-white/12 shadow-[0_22px_55px_rgba(11,40,118,0.28)]"
      }
    >
      <img
        src={`${assetBase}brand/fenix-agent-logo-mark.png`}
        alt="Fenix Agent"
        className={compact ? "h-12 w-12 object-contain" : "h-[72px] w-[72px] object-contain"}
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
  return (
    <div>
      <label htmlFor={id} className="mb-2 block text-[13px] font-semibold text-[#31415e]">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        required={required}
        minLength={type === "password" ? 8 : undefined}
        className="h-11 w-full rounded-md border border-[#d8e2ef] bg-white/85 px-4 text-[14px] text-[#17233d] shadow-[0_5px_18px_rgba(38,75,123,0.06)] outline-none transition placeholder:text-[#9aa9bf] focus:border-[#2386ff] focus:bg-white focus:ring-4 focus:ring-[#2386ff]/10"
      />
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
  const [acceptedTerms, setAcceptedTerms] = useState(false);
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
    setAcceptedTerms(false);
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

      if (isSignUp && !acceptedTerms) {
        setError(t("termsRequired"));
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
    [
      acceptedTerms,
      authMethod,
      confirmPassword,
      email,
      isSignUp,
      name,
      navigate,
      password,
      phoneNumber,
      rememberLogin,
      t,
    ],
  );

  return (
    <div className="flex min-h-screen w-full overflow-hidden bg-[#f6f9fd] text-[#14213d]">
      <section
        className="relative hidden min-h-screen w-[55.5%] items-center justify-center overflow-hidden lg:flex"
        style={{ background: "linear-gradient(135deg, #071846 0%, #1043B7 52%, #268DFF 100%)" }}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_28%,rgba(91,177,255,0.34),transparent_31%),radial-gradient(circle_at_78%_73%,rgba(255,255,255,0.14),transparent_30%)]" />
        <div className="relative z-10 -mt-6 text-center">
          <LoginBrandMark />
          <h1 className="mt-9 text-[44px] font-bold tracking-[0.16em] text-white">FENIX AGENT</h1>
          <p className="mt-5 text-[18px] font-medium tracking-[0.18em] text-white/82">{t("brandSubtitle")}</p>
          <div className="mt-11 flex flex-wrap justify-center gap-4">
            {["AI Orchestration", "Multi-Agent", "Intelligent Core"].map((label) => (
              <span
                key={label}
                className="rounded-full border border-white/22 bg-white/10 px-5 py-2 text-[13px] font-medium text-white/78 backdrop-blur"
              >
                {label}
              </span>
            ))}
          </div>
        </div>
      </section>

      <main className="relative flex min-h-screen flex-1 items-center justify-center overflow-hidden px-6 py-12 sm:px-10">
        <div className="pointer-events-none absolute left-[8%] top-[28%] hidden h-[430px] w-[430px] opacity-70 lg:block">
          <div className="absolute left-0 top-16 h-[330px] w-[150px] rounded-[10px] bg-[#e9f1f9]" />
          <div className="absolute left-[110px] top-0 h-[152px] w-[315px] rounded-[10px] bg-[#edf4fb]" />
          <div className="absolute left-[110px] top-[205px] h-[152px] w-[255px] rounded-[10px] bg-[#edf4fb]" />
        </div>
        <div className="pointer-events-none absolute right-[-18%] top-[-10%] h-[420px] w-[420px] rounded-full bg-[#dfeeff]/70 blur-3xl" />

        <div className="relative z-10 w-full max-w-[410px]">
          <div className="mb-9 text-center lg:hidden">
            <LoginBrandMark compact />
            <p className="mt-4 text-[18px] font-bold tracking-[0.12em] text-[#176cff]">FENIX AGENT</p>
          </div>

          <div className="mb-8">
            <h1 className="text-[28px] font-bold leading-tight text-[#111c35]">
              {isSignUp ? t("createAccountTitle") : t("welcomeBack")}
            </h1>
            <p className="mt-3 text-[14px] font-medium text-[#7888a0]">
              {isSignUp ? t("createAccountSubtitle") : t("welcomeBackSubtitle")}
            </p>
          </div>

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

          <form onSubmit={handleSubmit} className="space-y-[18px]">
            {isSignUp && (
              <AuthInput
                id="signup-name"
                label={t("username")}
                value={name}
                onChange={setName}
                placeholder={t("usernamePlaceholder")}
                autoComplete="name"
                required
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
              id="auth-password"
              label={isSignUp ? t("setPassword") : t("password")}
              type="password"
              value={password}
              onChange={setPassword}
              placeholder={isSignUp ? t("setPasswordPlaceholder") : t("passwordPlaceholder")}
              autoComplete={isSignUp ? "new-password" : "current-password"}
              required
            />

            {isSignUp && (
              <AuthInput
                id="signup-confirm-password"
                label={t("confirmPassword")}
                type="password"
                value={confirmPassword}
                onChange={setConfirmPassword}
                placeholder={t("confirmPasswordPlaceholder")}
                autoComplete="new-password"
                required
              />
            )}

            {!isSignUp ? (
              <div className="flex items-center justify-between pt-1 text-[13px] text-[#7f8da4]">
                <label className="flex cursor-pointer items-center gap-2">
                  <input
                    type="checkbox"
                    checked={rememberLogin}
                    onChange={(e) => setRememberLogin(e.target.checked)}
                    className="h-4 w-4 rounded border-[#c7d3e2] accent-[#1f7cff]"
                  />
                  <span>{t("rememberLogin")}</span>
                </label>
                {/* <button type="button" className="font-medium text-[#2078ff] transition hover:text-[#0d5fe5]">
                  {t("forgotPassword")}
                </button> */}
              </div>
            ) : (
              <label className="flex cursor-pointer items-start gap-2 pt-1 text-[13px] leading-5 text-[#7f8da4]">
                <input
                  type="checkbox"
                  checked={acceptedTerms}
                  onChange={(e) => setAcceptedTerms(e.target.checked)}
                  className="mt-0.5 h-4 w-4 rounded border-[#c7d3e2] accent-[#1f7cff]"
                />
                <span>
                  {t("termsPrefix")}
                  <button type="button" className="mx-0.5 font-medium text-[#2078ff]">
                    {t("userAgreement")}
                  </button>
                  {t("termsConnector")}
                  <button type="button" className="mx-0.5 font-medium text-[#2078ff]">
                    {t("privacyPolicy")}
                  </button>
                </span>
              </label>
            )}

            {error && (
              <p className="rounded-md border border-[#ffd6d6] bg-[#fff2f2] px-3 py-2 text-[13px] text-[#d73535]">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="h-12 w-full rounded-md bg-[linear-gradient(90deg,#0f74ff_0%,#2fb9ff_100%)] text-[15px] font-bold text-white shadow-[0_12px_28px_rgba(27,126,255,0.28)] transition hover:shadow-[0_16px_32px_rgba(27,126,255,0.32)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {loading ? t("pleaseWait") : isSignUp ? t("signupButton") : t("loginButton")}
            </button>
          </form>

          {signupAllowed && (
            <div className="mt-7 text-center text-[14px] font-medium text-[#7f8da4]">
              {isSignUp ? t("alreadyHaveAccount") : t("noAccount")}{" "}
              <button
                type="button"
                onClick={() => switchMode(!isSignUp)}
                className="font-semibold text-[#2078ff] transition hover:text-[#0d5fe5]"
              >
                {isSignUp ? t("backToSignIn") : t("clickSignUp")}
              </button>
            </div>
          )}
        </div>

        <p className="absolute bottom-7 left-1/2 hidden -translate-x-1/2 text-[12px] text-[#9aa9bf] sm:block">
          © 2026 Fenix Agent. All rights reserved.
        </p>
      </main>
    </div>
  );
}
