import { Spinner } from "@fenix/ui-components/ui/spinner";
import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { NS } from "@/src/i18n";

interface PanelRouteFallbackProps {
  /** 环径，默认 `md`（面板级内容区）；标签页内容区按 §2.5 取 `sm`。 */
  size?: ComponentProps<typeof Spinner>["size"];
  /** 附加类名（只用于外边距一类的调整）；容器形态固定为 `panel`，不在调用点复刻。 */
  className?: string;
}

/**
 * 路由 `Suspense` fallback 的等待态：**面板内容区只有这一个写法**（前端规范 §2.5 的 `panel` 口径）。
 *
 * 2026-09-22 前端去重：同一行 `<Spinner variant="panel" label={<span className="sr-only">…</span>} />`
 * 此前作为「标准路由壳」被复制到宿主路由里逐字重复；它同时承载三件事——`panel` 容器、品牌色环、
 * 以及面板 fallback 的读屏文案（§2.5：没有可见文案的加载区要给 sr-only 的 `label`，整块对读屏隐藏
 * 会让用户听不到任何「正在加载」）。三件事分开传就会各自漂移，故收敛到本组件，调用点只声明差异项。
 *
 * 放宿主 `components/` 而不是组件库：它是一条**宿主路由壳的约定**（配 §2.5 的骨架），不是通用 UI 原语；
 * 页面内的整块加载提示按各自场景直接用 `Spinner`。
 *
 * 整屏等待（`__root.tsx` 的会话分支、`/login`、全屏路由壳）**不用本组件**：那些场景按 §2.5 用
 * `variant="screen"`。
 */
export function PanelRouteFallback({ size, className }: PanelRouteFallbackProps) {
  const { t } = useTranslation(NS.COMMON);
  return (
    <Spinner
      variant="panel"
      size={size}
      className={className}
      label={<span className="sr-only">{t("loading")}</span>}
    />
  );
}
