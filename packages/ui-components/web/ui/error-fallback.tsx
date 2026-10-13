// web/ui/error-fallback.tsx
// ErrorBoundary 的统一降级 UI（前端开发规范 §7.1 放置矩阵 / §7.2 降级策略）。
//
// 为什么单独抽一个组件：§7.1 要求根布局、Agent 面板布局、ChatPanel、ArtifactsPanel、AgentSidebar 五处
// 各自包裹边界，同一个降级 UI 若在五处手写，措辞、重试出口与容器形态立刻分成五份，§7.2 的两条硬约束
// （必须给重试按钮、降级 UI 不得回显 `error.message`）也随之变成逐处自觉。
//
// **刻意不接收 `error`**：调用方传进来的是整份 `FallbackProps`，本组件只声明其中真正用到的
// `resetErrorBoundary` 一个端口——类型上就拿不到 message，§7.2 的「不回显」由类型保证而不是靠 review
// 记得；原始错误只进调用方的 `onError`（`console.error`）。同理**不叠 `toast.error`**：降级 UI 本身就是
// 用户可见反馈（§7.2 末条）。
//
// 归属（§4.1 按消费者集合判定）：消费者是「宿主 5 处边界 + 包内 `FileViewerPreview`」，故落本包；
// 放 `ui/` 而不是 `config/`——它不认识任何业务域，只是边界机制的另一半（与 `ui/spinner` 同为状态原语）。
// 本组件**不 import `react-error-boundary`**：那会把这个包外运行时依赖带进所有资源包的浏览器可达面
// （§11.2 的 browser-surface 白名单逐包登记），边界机制留在调用方，本组件只收回调端口。

import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../i18n/namespace";
import { cn } from "../lib/cn";
import { Button } from "./button";

/**
 * 降级 UI 的容器形态，二选一（沿用 §2.5 `Spinner` 的同一套词汇，调用点不要用 `className` 复刻）：
 *
 * - `panel`（默认）：撑满所在内容区（面板根组件——ChatPanel / ArtifactsPanel / AgentSidebar / 预览器）；
 * - `screen`：整屏（根布局与整页壳路由——崩溃时页面外壳已不可用，只剩这一屏）。
 */
export type ErrorFallbackVariant = "panel" | "screen";

/** 容器排布：`panel` 走 §2.5 的 `flex-1` 口径（同 `Spinner` 的 `panel`），`screen` 取整屏。 */
const VARIANT_CLASS: Record<ErrorFallbackVariant, string> = {
  panel: "flex-1 min-h-0",
  screen: "h-screen",
};

export interface ErrorFallbackProps {
  /**
   * 重置回调，即 `react-error-boundary` 的 `FallbackProps.resetErrorBoundary`，重试按钮直接调它。
   *
   * 刻意声明成本包自持的 `() => void`（对方的实参多一个是兼容的），从而不把 `react-error-boundary`
   * 变成本包的依赖——见文件头「不 import」的理由。
   */
  resetErrorBoundary: () => void;
  /** 覆盖主文案（如预览器用更贴切的「预览组件加载失败」）；不传时取包内字典 `errors.renderFailed`。 */
  message?: string;
  /** 容器形态，默认 `panel`。 */
  variant?: ErrorFallbackVariant;
}

/**
 * 「这块区域渲染崩了」的统一呈现：一条固定文案 + 一个重试按钮。
 *
 * 呈现刻意保持**最简**（一行文本 + 一个 `outline` 按钮，不带图标、不带 Card 外壳）：降级 UI 不应改变
 * 页面布局结构（§7.2）——它替换掉的可能是侧栏、聊天区或整屏，任何更复杂的版式都会在「原本是什么容器」
 * 这件事上做出假设。容器（有无边框、外边距）由调用方给，与 `EmptyState` 的分工一致。
 *
 * 文案走包内字典（键的最终所在地 = 包的 owner，§9.2），因为它渲染给用户看、必须随语言变化；调用方有更
 * 贴切措辞时经 `message` 覆盖。
 */
export function ErrorFallback({ resetErrorBoundary, message, variant = "panel" }: ErrorFallbackProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center justify-center gap-3 p-6 text-center", VARIANT_CLASS[variant])}
    >
      <p className="text-sm text-text-muted">{message ?? t("errors.renderFailed")}</p>
      <Button variant="outline" onClick={() => resetErrorBoundary()}>
        {t("errors.retry")}
      </Button>
    </div>
  );
}
