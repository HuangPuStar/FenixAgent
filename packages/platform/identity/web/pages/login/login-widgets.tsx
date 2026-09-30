/**
 * login-widgets.tsx — 登录页本地展示组件
 *
 * 只做展示：左侧品牌列（LoginBrandPanel，含 LoginBrandMark / FeatureCard）与表单输入控件（AuthInput）。
 * 文案全部经 t()，className 与同目录同名的 login-widgets.css 成对维护：本文件顶部 import 该表，它只承载
 * 本文件渲染的元素（`.auth-light-brand-*` / `.auth-light-logo*` / `.auth-light-feature*` /
 * `.auth-light-field` / `.auth-light-input*` / `.auth-light-toggle`），不包 `@layer`；页壳、粒子层、右侧
 * 面板与表单外壳、提交按钮与页脚等 `LoginPage.tsx` 渲染的元素在 LoginPage.css，两份表的选择器互不重叠
 * （类名集合交集为零），故加载顺序不影响结果。2026-09-28 按 **DOM 归属**重拆，原按视觉分区切的两份表
 * `auth-light-brand.css` / `auth-light-form.css` 删除，规则一条不落。同日 dimensional 取值（Logo 与光晕盒子、
 * 能力卡内距、标签与图标尺寸、输入框内距与切换按钮几何、各档字号）也按令牌层裁定撤回本文件的 `className`
 * （`w-27.5 h-27.5` / `size-7` / `py-3.25 px-4` / `top-1/2 right-3 size-6.5 -translate-y-1/2` 一类）；
 * 留在 CSS 里的声明（伪元素、与关键帧成对的位移、不等价轨道、档外取值与配色）逐条写在两份伴随表的文件头。
 * 表单状态机在 LoginPage.tsx，取数与提交在 login-transport.ts。
 *
 * 这些组件只服务登录页，未出现第二个消费者前不进 `@fenix/ui-components`（§1.2 按包外真实消费点收敛）。
 */

import { CirclePlus, Eye, EyeOff, MessageSquare, ShieldCheck, Users } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { LOGIN_NS } from "../../i18n/namespace";
import "./login-widgets.css";

const assetBase = import.meta.env.BASE_URL;
const brandTags = ["AI Orchestration", "Multi-Agent", "Intelligent Core"];

/** 品牌 Logo；compact 供表单列在窄屏下的小尺寸展示。 */
export function LoginBrandMark({ compact = false }: { compact?: boolean }) {
  // 三轮收口（2026-09-28）：Logo 与光晕的几何从 login-widgets.css 撤回渲染点——刻度类写的就是设计值，
  // `w-27.5` / `h-27.5` = 110px、`w-18` / `h-18` = 72px、`mb-7` = 28px、compact 的 `mb-3.5` / `mx-auto`
  // = 14px / 水平居中、`w-35` / `w-23` = 140px / 92px、`top-1/2 left-1/2` = 原 `top: 50%` / `left: 50%`；
  // 光晕的 `absolute` / `pointer-events-none` 也由本类串给。
  // 光晕的 `transform: translate(-50%, -50%)` **不撤**：它与 `@keyframes authRingExpand` 里的同一条位移
  // 成对，而 `-translate-*` 落的是 `translate` 属性（v4 的独立变换属性），会与关键帧的 `transform` 叠成
  // 双重位移——属「与关键帧成对的位移」保留项。
  const logoClass = `auth-light-logo relative ${compact ? "auth-light-logo-compact w-18 h-18 mt-0 mb-3.5 mx-auto" : "w-27.5 h-27.5 mb-7"}`;
  const glowClass = `auth-light-logo-glow absolute pointer-events-none top-1/2 left-1/2 ${compact ? "w-23 h-23" : "w-35 h-35"}`;

  return (
    <div className={logoClass}>
      <div className={glowClass} />
      <img
        className="auth-light-logo-mark w-full h-full object-contain"
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
  const { t } = useTranslation(LOGIN_NS);
  const [visible, setVisible] = useState(false);
  const isPassword = type === "password";
  const inputType = isPassword && visible ? "text" : type;

  return (
    <div className="auth-light-field relative">
      {/* 三轮收口的落点（2026-09-28）：字段标签 `block font-medium text-slate-900/50`（原 `display: block` /
          字重 500 / `rgba(26, 26, 46, 0.5)` ΔE 3.75）+ 6px 下边距 `mb-1.5`；输入框 `w-full border
          border-slate-200 rounded-10 bg-white text-slate-900 text-15 outline-none`（原描边 `#dce0e8` ΔE 1.95、
          10px 圆角、`#fff`、`#1a1a2e` ΔE 3.75、15px）+ 内距（密码态 `pl-4 pr-10.5` = 原 `padding-right: 42px`）
          + 占位符 `placeholder:text-slate-900/20`；切换按钮 `absolute inline-flex items-center justify-center
          p-0 border-0 bg-transparent text-slate-900/25 cursor-pointer hover:text-slate-900/50` 与几何
          `top-1/2 right-3 size-6.5 -translate-y-1/2`，图标 `size-4.5`。 */}
      <label className="mb-1.5 block text-xs font-medium tracking-3 text-slate-900/50" htmlFor={id}>
        {label}
      </label>
      <div className="auth-light-input-wrap relative">
        <input
          autoComplete={autoComplete}
          className={`auth-light-input w-full border border-slate-200 rounded-10 bg-white py-3.25 text-15 text-slate-900 outline-none placeholder:text-slate-900/20 ${
            isPassword ? "auth-light-has-toggle pl-4 pr-10.5" : "px-4"
          }`}
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
            className="auth-light-toggle absolute inline-flex items-center justify-center top-1/2 right-3 size-6.5 -translate-y-1/2 cursor-pointer border-0 bg-transparent p-0 text-slate-900/25 hover:text-slate-900/50"
            onClick={() => setVisible((current) => !current)}
            type="button"
          >
            {visible ? <EyeOff className="size-4.5" /> : <Eye className="size-4.5" />}
          </button>
        )}
      </div>
    </div>
  );
}

/** 品牌列中的单张能力卡（图标与文案由调用方传入，保持纯展示）。 */
function FeatureCard({ icon, title, description }: { icon: ReactNode; title: string; description: string }) {
  // 三轮收口（2026-09-28）：卡片 `border border-white/12 rounded-10 bg-white/8`（白系 ΔE 0）与悬停
  // `hover:border-white/20 hover:bg-white/14 hover:-translate-y-0.5`，内距 `py-3.5 px-4.5`；图标盒
  // `size-7 mb-2 text-blue-200`（原 `#b8d4ff` ΔE 2.37），内部 svg 由调用方的 `size-full` 管；文案
  // `text-white/55 text-xs`，标题 `block font-medium text-white mb-0.5 text-13`。
  // 四轮收口：文案的 1.4 无单位行高与 0.04em 字距撤回 `leading-[1.4] tracking-4`；四个能力图标的
  // `strokeWidth={1.6}`（原 `.auth-light-feature-icon svg` 的 `stroke-width: 1.6`，该规则随四轮删除）。
  return (
    <div className="auth-light-feature border border-white/12 rounded-10 bg-white/8 py-3.5 px-4.5 hover:border-white/20 hover:bg-white/14 hover:-translate-y-0.5">
      <div className="auth-light-feature-icon size-7 mb-2 text-blue-200">{icon}</div>
      <div className="auth-light-feature-label text-xs leading-[1.4] tracking-4 text-white/55">
        <strong className="mb-0.5 block text-13 font-medium text-white">{title}</strong>
        {description}
      </div>
    </div>
  );
}

/** 左侧品牌列：Logo、标语、能力卡与能力标签。 */
export function LoginBrandPanel() {
  const { t } = useTranslation(LOGIN_NS);

  return (
    <section className="auth-light-brand-panel relative z-1 flex flex-col items-center justify-center overflow-hidden p-15 max-lg:p-10 before:absolute before:inset-0 before:pointer-events-none after:absolute after:right-0 after:w-0.25">
      {/* 三轮收口的落点（2026-09-28）：品牌列壳 `relative z-1 flex flex-col items-center justify-center
          overflow-hidden` + 内距 `p-15` / `max-lg:p-10`（60 / ≤1024px 40px）+ 两条装饰伪元素的
          `before:*` / `after:*`（`after:w-0.25` = 原 1px 竖线）；标题 `text-white text-38 font-bold mb-2.5
          max-lg:text-32`（38px / 10px / ≤1024px 32px）、副标题 `text-white/60 text-17 font-light mb-11`
          （60% 白 / 17px / 44px）、网格 `grid w-full gap-3 max-w-100`（12 / 400px）、标签
          `flex flex-wrap justify-center gap-3 mt-8` 与 `border border-white/12 py-1.25 px-3.5 text-xs
          text-white/35 hover:border-white/20 hover:bg-white/6 hover:text-white/70`（12 / 32px / 5px 14px /
          12px 与三态，白系 ΔE 0；20px 圆角无 token，仍留在伴随表里）。 */}
      <LoginBrandMark />
      <div className="auth-light-brand-title mb-2.5 text-38 font-bold tracking-15 text-white max-lg:text-32">
        FENIX AGENT
      </div>
      <div className="auth-light-brand-sub mb-11 text-17 font-light tracking-8 text-white/60">{t("brandSubtitle")}</div>

      <div className="auth-light-features grid w-full gap-3 max-w-100">
        {[
          {
            icon: <CirclePlus className="size-full" strokeWidth={1.6} />,
            titleKey: "features.orchestration",
            descKey: "features.orchestrationDesc",
          },
          {
            icon: <ShieldCheck className="size-full" strokeWidth={1.6} />,
            titleKey: "features.security",
            descKey: "features.securityDesc",
          },
          {
            icon: <MessageSquare className="size-full" strokeWidth={1.6} />,
            titleKey: "features.conversation",
            descKey: "features.conversationDesc",
          },
          {
            icon: <Users className="size-full" strokeWidth={1.6} />,
            titleKey: "features.organization",
            descKey: "features.organizationDesc",
          },
        ].map((feature) => (
          <FeatureCard
            description={t(feature.descKey)}
            icon={feature.icon}
            key={feature.titleKey}
            title={t(feature.titleKey)}
          />
        ))}
      </div>

      <div className="auth-light-tags flex flex-wrap justify-center gap-3 mt-8">
        {brandTags.map((label) => (
          <span
            className="border border-white/12 rounded-20 py-1.25 px-3.5 text-xs tracking-4 text-white/35 hover:border-white/20 hover:bg-white/6 hover:text-white/70"
            key={label}
          >
            {label}
          </span>
        ))}
      </div>
    </section>
  );
}
