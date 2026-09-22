// 整屏错误落地页：403（无权限）与 404（路由未命中）共用一份。
//
// 2026-09-22 前端去重：这两张页面此前逐字复制在 `routes/no-access.tsx` 与 `routes/__root.tsx` 的
// `NotFoundPage` 里——同样的 `h-screen` 居中、同样的锚点文案、同样的返回 `/agent` 按钮，只有状态码与
// 文案 key 不同；按钮还是手写的（`bg-brand px-4 py-2 ...`），绕过了 `ui/button`。
//
// 放宿主而不是组件库：它是宿主路由的落地页，跳转目标（`/agent`）是宿主路由表的知识，目前也只有宿主
// 这两处消费；进库会把宿主的路由结构泄漏到通用层。
//
// 顺带把按钮换成 `ui/button`：手写版用 `bg-brand`，`Button` 用 `bg-primary`——两者在浅色主题下是同一个
// 色值（#1677ff），深色下 `brand` 亮一档（#4096ff），这里按「主按钮」语义取 `primary`。

import { Button } from "@fenix/ui-components/ui/button";
import { useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

export interface ErrorPageProps {
  /** 展示的状态码，如 `"403"` / `"404"`。 */
  code: string;
  /** 说明文案，由调用方传入 i18n 结果。 */
  message: ReactNode;
  /** 「返回控制台」按钮文案，由调用方传入 i18n 结果。 */
  backLabel: ReactNode;
}

export function ErrorPage({ code, message, backLabel }: ErrorPageProps) {
  const navigate = useNavigate();

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-bold text-text-primary">{code}</h1>
      <p className="text-sm text-text-muted">{message}</p>
      <Button onClick={() => void navigate({ to: "/agent" })}>{backLabel}</Button>
    </div>
  );
}
