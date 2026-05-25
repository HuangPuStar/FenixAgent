import { useNavigate } from "@tanstack/react-router";
import { Eye, EyeOff } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { authClient } from "../lib/auth-client";
import { encryptPassword } from "../lib/password-crypto";

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation("login");
  const [isSignUp, setIsSignUp] = useState(false);
  const [signupAllowed, setSignupAllowed] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  useEffect(() => {
    fetch("/api/auth/signup-status")
      .then((res) => res.json())
      .then((data) => setSignupAllowed(data.signupAllowed === true))
      .catch(() => setSignupAllowed(true));
  }, []);

  const handleSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError("");
      setLoading(true);

      try {
        const encPassword = await encryptPassword(password);
        if (isSignUp) {
          const res = await authClient.signUp.email({
            email,
            password: encPassword,
            name: name || email.split("@")[0],
          });
          if (res.error) {
            setError(res.error.message || t("signUpFailed"));
            return;
          }
        } else {
          const res = await authClient.signIn.email({
            email,
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
    [email, password, name, isSignUp, navigate, t],
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-surface-0">
      <div className="w-full max-w-sm space-y-6 rounded-lg border border-border bg-surface-1 p-8">
        <div className="text-center">
          <h1 className="text-xl font-semibold text-text-primary">{isSignUp ? t("signUp") : t("signIn")}</h1>
          <p className="mt-1 text-sm text-text-muted">{isSignUp ? t("signUpSubtitle") : t("signInSubtitle")}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isSignUp && (
            <div>
              <label className="block text-sm font-medium text-text-secondary mb-1">{t("name")}</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("namePlaceholder")}
                className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t("email")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              required
              className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">{t("password")}</label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t("passwordPlaceholder")}
                required
                minLength={8}
                className="w-full rounded-md border border-border bg-surface-0 px-3 py-2 pr-10 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-muted hover:text-text-primary"
                tabIndex={-1}
              >
                {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>
          </div>

          {error && <p className="text-sm text-status-error bg-status-error/10 px-3 py-2 rounded-md">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90 disabled:opacity-50"
          >
            {loading ? t("pleaseWait") : isSignUp ? t("signUp") : t("signIn")}
          </button>
        </form>

        {signupAllowed && (
          <div className="text-center text-sm text-text-muted">
            {isSignUp ? (
              <>
                {t("alreadyHaveAccount")}{" "}
                <button
                  onClick={() => {
                    setIsSignUp(false);
                    setError("");
                  }}
                  className="text-brand hover:underline"
                >
                  {t("signIn")}
                </button>
              </>
            ) : (
              <>
                {t("noAccount")}{" "}
                <button
                  onClick={() => {
                    setIsSignUp(true);
                    setError("");
                  }}
                  className="text-brand hover:underline"
                >
                  {t("signUp")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
