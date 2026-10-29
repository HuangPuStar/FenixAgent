/**
 * OpenUI 渲染 chunk（重）：parser + 组件库 + canvas。
 *
 * 本模块**只能**经 `openui-block.tsx` 的 `lazy()` 边界到达。静态引入会把 `@openuidev/react-lang`
 * 与图表打进聊天入口 chunk。
 */

import type { OpenUIActionEvent } from "@peri-code/sdk/openui";
import { installOpenUITheme } from "@peri-code/sdk/openui";
import { OpenUIErrorBoundary, OpenUIProgram } from "@peri-code/sdk/openui/renderer";
import type { ReactNode } from "react";

// 主题桥只读 document 上的三个 CSS 变量并推给 canvas；模块级一次即可。HMR 重求值不会重复安装，
// 因为这段判断在模块体内、安装本身是幂等的（同一 document 重复 addEventListener 才会叠加）。
let themeInstalled = false;
// SSR 没有 document，SDK 会直接返回；此时不能置位，否则同进程后续客户端挂载会跳过安装。
if (!themeInstalled && typeof document !== "undefined") {
  themeInstalled = true;
  installOpenUITheme();
}

export interface OpenUIRendererProps {
  program: string;
  isStreaming: boolean;
  actionsEnabled: boolean;
  before?: string;
  after?: string;
  fallbackText: string;
  renderText?: (text: string) => ReactNode;
  onAction?: (event: OpenUIActionEvent) => void;
  /** 渲染异常时的回退内容（已由调用方转成 ReactNode）。 */
  fallback: ReactNode;
  /** 程序变化时重置错误态。 */
  resetKey?: string;
}

export default function OpenUIRenderer({ fallback, resetKey, ...programProps }: OpenUIRendererProps) {
  return (
    <OpenUIErrorBoundary fallback={fallback} resetKey={resetKey}>
      <OpenUIProgram {...programProps} />
    </OpenUIErrorBoundary>
  );
}
