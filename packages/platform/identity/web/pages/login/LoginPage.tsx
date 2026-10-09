/**
 * LoginPage.tsx — 登录/注册页
 *
 * 按职责拆分为四个部分（前端规范 §4.7 单文件 500 行）：
 *   - 样式伴随表：LoginPage.css（同目录同名，由本文件顶部 import）、login-widgets.css（同目录同名，由
 *     login-widgets.tsx 顶部 import）——2026-09-28 按 **DOM 归属**重拆：各表只承载「渲染方是自己」的
 *     元素，两份表的选择器互不重叠（类名集合交集为零），都不包 `@layer`，因此加载顺序不影响结果。
 *     原 `auth-light-brand.css`（页面外壳 + 品牌列）/ `auth-light-form.css`（表单列）两份按**视觉分区**
 *     切的表随本批删除，规则一条不落（集合相等，只有空白差异）。
 *   - 展示组件：login-widgets.tsx（LoginBrandPanel / LoginBrandMark / AuthInput）
 *   - 传输适配：login-transport.ts（注册开关探测、登录/注册提交）
 * 本文件只保留表单状态机与页面布局组合。dimensional 取值（内距、外边距、间隙、字号、尺寸）已按
 * 2026-09-28 令牌层裁定撤回本文件的 `className`（刻度类写的就是设计值）——例如右侧面板的 `py-15 px-20`
 * / `max-lg:py-10 max-lg:px-12`、标题的 `m-0 mb-1`、提交按钮的 `min-h-12.5 p-3.75`；同日四轮把字距
 * （`tracking-15 / -4 / -3 / -2`）与主标题的 1.2 无单位行高（`leading-[1.2]`）也撤回 `className`；
 * 留在伴随表里的声明（伪元素、粒子层的逐子成组几何、非标准断点块、品牌深蓝、复合值与状态成对的
 * `transform`）逐条写在两份表的文件头。
 *
 * 归属：登录/注册是身份域的第一个界面（凭据提交、加密、注册开关探测全部落在本包 `web/lib`），
 * 因此整簇（页面 + 两个本地组件文件 + 传输适配 + 偏好存储 + 两份样式伴随表 + `login` 字典）从宿主
 * `apps/web/src/pages/` 迁入本包 `web/pages/login/`。宿主只保留 `/login` 路由适配器，经包出口
 * `@fenix/identity/web/pages/login/LoginPage` 懒加载本文件——不走包根 `./web` 桶出口，那是身份
 * 控制台页（组织 / API Key 页与 better-auth 客户端图）的入口，未登录用户的首屏不该驮着它们。
 *
 * 路由耦合：`navigate({ to: "/" })` 是宿主路由表的目标，与本包其余页面同款（页面由宿主路由渲染，
 * 路由上下文由宿主提供）。
 */

import { useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { LOGIN_NS } from "../../i18n/namespace";
import { type AuthMethod, getPreferredAuthMethod, setPreferredAuthMethod } from "../../lib/auth-preference";
import "./LoginPage.css";
import { fetchSignupAllowed, submitLogin } from "./login-transport";
import { AuthInput, LoginBrandMark, LoginBrandPanel } from "./login-widgets";

const particleKeys = ["particle-1", "particle-2", "particle-3", "particle-4", "particle-5", "particle-6"];

export function LoginPage() {
  const navigate = useNavigate();
  const { t } = useTranslation(LOGIN_NS);
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
    <div className="auth-light-page relative flex min-h-dvh overflow-hidden bg-slate-100 text-slate-900 before:fixed before:inset-0 before:z-0 before:pointer-events-none">
      <div aria-hidden="true" className="auth-light-particles fixed inset-0 z-0 overflow-hidden pointer-events-none">
        {particleKeys.map((key) => (
          <div className="auth-light-particle absolute" key={key} />
        ))}
      </div>

      <LoginBrandPanel />

      {/* 三轮收口的落点（2026-09-28）：页壳（`relative flex min-h-dvh overflow-hidden bg-slate-100
          text-slate-900` + 底纹伪元素的 `before:fixed before:inset-0 before:z-0 before:pointer-events-none`，
          原 `#f0f3f8` → `bg-slate-100` ΔE 0.87、`#1a1a2e` → `text-slate-900` ΔE 3.75）；面板布局与内距
          （`relative z-1 flex flex-col justify-center` / `py-15 px-20`，≤1024px `max-lg:py-10 max-lg:px-12`
          ——标准档 `max-lg` 是 `width < 1024`，1024px 整点由 40/48 回到 60/80）；`max-w-105` = 原 420px 上限。 */}
      <main className="auth-light-panel relative z-1 flex flex-col justify-center py-15 px-20 max-lg:py-10 max-lg:px-12">
        <div className="auth-light-box w-full max-w-105">
          <div className="auth-light-mobile-brand hidden mb-8 text-center">
            <LoginBrandMark compact />
            <p className="auth-light-mobile-title text-xl font-bold tracking-15">FENIX AGENT</p>
          </div>

          <h1 className="auth-light-title m-0 mb-1 text-28 leading-[1.2] font-semibold tracking-4">
            {isSignUp ? t("createAccountTitle") : t("welcomeBack")}
          </h1>
          <p className="auth-light-sub m-0 mb-9 text-13 tracking-2 text-slate-900/40">
            {isSignUp ? t("createAccountSubtitle") : t("welcomeBackSubtitle")}
          </p>

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

          {/* 字段纵向节奏由本行的 `flex flex-col gap-5` 承载：原 `.auth-light-form`
              （`display:flex; flex-direction:column; gap:20px`）在 2026-09-28 按 DOM 归属重拆样式表时整条丢失，
              字段两两相贴（实测 0px，相邻行 18/6/12px）。gap 按紧凑标尺同档收回（`--gap-5` = 16px，与
              切换 tab 的 `mb-6` = 18px 同族，略小于区段间距即是设计意图），因此该节奏必须留在本类串上。 */}
          <form className="auth-light-form flex flex-col gap-5" onSubmit={handleSubmit}>
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

            {/* 忘记密码 / 用户协议 / 隐私政策 对应页面暂未实现，先隐藏这些入口；注册也不再强制勾选协议。
                本行不补上下内距：内距只加在父 div 上、`label` 是内容宽的 inline-flex，点到的是 label 自身，
                多出的 `py-4` 只是白（2026-10-08 单行补偿的正是上一条丢失的 gap）。行距由表单 `gap-5` 统一给出，
                下方 8px `mb-2` 保留提交按钮与选项行的分离。 */}
            {!isSignUp && (
              <div className="auth-light-options -mt-0.5 mb-2 flex items-center justify-between text-13 text-slate-900/45">
                <label className="auth-light-checkbox inline-flex items-center gap-2 cursor-pointer hover:text-slate-900/65">
                  <input
                    checked={rememberLogin}
                    className="size-4 cursor-pointer"
                    onChange={(e) => setRememberLogin(e.target.checked)}
                    type="checkbox"
                  />
                  <span>{t("rememberLogin")}</span>
                </label>
              </div>
            )}

            {error && (
              <p className="auth-light-error m-0 -mt-1 rounded-10 border border-red-500/20 bg-red-500/6 py-2.5 px-3 text-13 text-red-700/86">
                {error}
              </p>
            )}

            <button
              className="auth-light-submit relative min-h-12.5 w-full overflow-hidden rounded-10 border-0 p-3.75 text-15 font-semibold tracking-4 text-white cursor-pointer"
              disabled={loading}
              type="submit"
            >
              {loading ? (
                <span className="auth-light-spinner inline-block size-5 border-2 border-white/25 border-t-white" />
              ) : isSignUp ? (
                t("signupButton")
              ) : (
                t("loginButton")
              )}
            </button>
          </form>

          {signupAllowed && (
            <div className="auth-light-switch mt-6 text-center text-13 text-slate-900/35">
              {isSignUp ? t("alreadyHaveAccount") : t("noAccount")}{" "}
              <button
                className="auth-light-link relative border-0 bg-transparent text-13 no-underline opacity-70 cursor-pointer hover:opacity-100 after:absolute after:-bottom-0.25 after:left-0 after:h-0.25 after:w-0 hover:after:w-full"
                onClick={() => switchMode(!isSignUp)}
                type="button"
              >
                {isSignUp ? t("backToSignIn") : t("clickSignUp")}
              </button>
            </div>
          )}
        </div>

        <p className="auth-light-footer absolute right-0 bottom-7 left-0 z-1 m-0 text-center text-xs tracking-3 text-slate-900/15">
          © 2026 Fenix AOS. All rights reserved.
        </p>
      </main>
    </div>
  );
}
