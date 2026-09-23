import React, { createContext, useContext, useEffect } from "react";

/**
 * 主题上下文 —— 全局强制亮色。
 *
 * 本包不再提供任何把界面切回深色的能力：
 * - 不读也不写 localStorage（旧实现在 `theme` 键上持久化用户选择）；
 * - 不监听 `matchMedia("(prefers-color-scheme: dark)")`（旧实现在 theme === "system"
 *   时跟随系统偏好并实时切换）；
 * - 不向 `document.documentElement` 写 `dark` 类。
 *
 * 三处一起拿掉之后，「系统深色偏好」与「残留的持久化选择」都不再能影响渲染，
 * 亮色是常量而非默认值。
 */

export type Theme = "light" | "dark" | "system";

/** 已解析生效的外观。当前恒为 `"light"`，但类型保留 `"dark"`，理由见下方 `ThemeContextValue`。 */
export type ResolvedTheme = "light" | "dark";

interface ThemeContextValue {
  /**
   * 唯一存在的外观。原先表示「用户的选择」，切换能力移除后不再有取值空间，
   * 因此收窄为字面量 —— 消费方没有拿它做 `=== "dark"` 之类的比较。
   */
  theme: "light";
  /**
   * 当前生效的外观：**运行时恒为 `"light"`**。
   *
   * 类型上刻意保留 `"light" | "dark"` 的联合：这是本包对外的既有契约，消费方
   * （`memory/hindsight/components/Graph2d.tsx`、`Constellation.tsx`）用它选画布配色，
   * 形如 `resolvedTheme === "dark"`。把这里收窄成 `"light"` 会让那些比较变成
   * 「无重叠比较」并直接编译失败（TS2367）——用类型改动去逼消费方删分支，等于把
   * 「强制亮色」实现成一次跨包的破坏性 API 变更，而它们的分支只是不再命中。
   *
   * 因此「不可能是 dark」由实现保证（唯一的上下文值 `FORCED_THEME` 是常量），
   * 而不是由类型保证。**不要把这个联合收窄。**
   */
  resolvedTheme: ResolvedTheme;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

/** 上下文值：两个字面量都是常量，无需 state，也就没有触发重渲染的路径。 */
const FORCED_THEME: ThemeContextValue = { theme: "light", resolvedTheme: "light" };

/**
 * 收掉 `documentElement` 上可能残留的 `dark` 类。
 *
 * 本仓库已无任何写入 `.dark` 的代码，这里兜的是两类**外部**来源：上一版本写过之后
 * 留在 DOM 上的残留，以及浏览器扩展 / 第三方脚本直接往 `<html>` 上塞类。`.dark`
 * 一旦存在，token 变量与 `dark:` 变体都会随之生效，故挂载时必须清掉。
 *
 * 只移除、不添加：`.light` 在本仓库没有任何选择器依赖（旧实现会写它，属噪声）。
 */
function enforceLight() {
  document.documentElement.classList.remove("dark");
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}

interface ThemeProviderProps {
  children: React.ReactNode;
}

/**
 * 保留 Provider 与 `useTheme` 是刻意的：宿主与 demo 的组件树依赖这层上下文，
 * 而 `resolvedTheme` 仍被需要布尔判定的消费方（如 canvas / SVG 渲染器，
 * `packages/resources/memory/web/pages/hindsight`）用来选择自身配色分支。
 */
export function ThemeProvider({ children }: ThemeProviderProps) {
  useEffect(() => {
    enforceLight();
  }, []);

  return React.createElement(ThemeContext.Provider, { value: FORCED_THEME }, children);
}
