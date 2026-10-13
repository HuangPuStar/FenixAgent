import type { ReactNode } from "react";
import { I18nextProvider } from "react-i18next";

import { getRegisteredTags, registerTagRenderer } from "../web/lib/card-renderer";
import { ThemeProvider } from "../web/lib/theme";
import { demoI18n, setupDemoI18n } from "./i18n";

/**
 * demo 的基础设施组合：i18n 实例 + 主题上下文，并演示 card-renderer 的注册方式。
 */

const DEMO_TAG = "demo-card";

/**
 * 示例标签渲染器。
 *
 * 标签属性在经过 markdown 解析后只会以字符串形式到达组件，因此这里对每个属性做运行时收窄，
 * 而不是声明具体的 props 类型 —— 注册表的组件签名是 `ComponentType<Record<string, unknown>>`。
 */
function DemoTagCard(props: Record<string, unknown>) {
  const title = typeof props.title === "string" ? props.title : DEMO_TAG;
  const body = typeof props.children === "string" ? props.children : null;

  return (
    <span className="inline-flex items-center gap-2 px-2.5 py-1.5 border border-dashed border-border-active rounded-[var(--radius)] text-[13px]">
      <strong>{title}</strong>
      {body}
    </span>
  );
}

/**
 * 注册表默认拒绝一切未注册标签（XSS 安全默认），所以示例标签必须在此显式注册，
 * AI 分区的 `MessageResponse` 才会渲染它；未注册时该标签会被 rehype-sanitize 直接剥离。
 *
 * 先判断再注册是为了幂等：Vite HMR 会重新执行本模块，重复注册会触发覆盖警告。
 */
if (!getRegisteredTags().includes(DEMO_TAG)) {
  registerTagRenderer(DEMO_TAG, { component: DemoTagCard });
}

// 在任何组件渲染前完成初始化（内联资源 + initAsync: false，因此是同步的）。
setupDemoI18n();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <I18nextProvider i18n={demoI18n}>
      <ThemeProvider>{children}</ThemeProvider>
    </I18nextProvider>
  );
}
