// web/config/AdminKeyGate.tsx
// 管理员 Master Key 门（纯展示层）：受控的解锁态 + 错误态 + 提交回调，解锁后直接渲染 children。
//
// 归属：本组件由 sandbox / observer（3 页） / model-management 四处的管理页共用，按「归属由消费者
// 集合决定」落在共享组件库；此前它住在 sandbox 包（`packages/resources/sandbox/web/src/pages/admin/
// components/MasterKeyGate.tsx`），迫使 observer 与 model-management 为一道门依赖整个沙盒资源包。
//
// 为什么本组件不读 key、不知道 sessionStorage：`@fenix/ui-components` 是纯展示包，依赖矩阵里不允许
// 依赖 `@fenix/web-runtime`（后者反向依赖本包）。写入/读取 master key 与 401 失败路径由
// `@fenix/web-runtime/hooks/use-admin-key-gate` 承担，页面把它的 `unlock` / `fail` 接到这里的
// `onUnlock` 与子页面。
//
// 文案全部由调用方传入：库内组件不绑定 i18n 命名空间（四个消费方分属 sandbox / observer / models
// 三个命名空间，且同一页面的标题与错误提示措辞不同）。

import { KeyRound } from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";

export interface AdminKeyGateProps {
  /** 本会话是否已解锁：true 时只渲染 `children`（管理面板），false 时渲染密钥表单。 */
  unlocked: boolean;
  /** 上次鉴权失败的用户可见提示（由面板 401 路径回传）；无失败传 `null`。 */
  error?: string | null;
  /** 表单提交：参数是已 `trim` 且非空的 key，由调用方写入并解锁。 */
  onUnlock: (key: string) => void;
  /** 表单标题。 */
  title: string;
  /** 表单说明（key 的用途与存放位置）。 */
  description: string;
  /** 输入框占位符，同时用作其 `aria-label`。 */
  inputPlaceholder: string;
  /** 提交按钮文案。 */
  submitLabel: string;
  /** 解锁后渲染的页面内容。 */
  children: ReactNode;
}

/**
 * 系统 Master Key 输入门（docs/arch/21 §5）：写入 sessionStorage → 触发面板加载。
 *
 * 不纳入 better-auth 会话体系；面板内请求返回 401 时由 `useAdminKeyGate().fail` 清 key 并带错误提示回到本门。
 *
 * 键输入是本地 UI 状态（组件内 `useState`），凭据本身不落本组件：`onUnlock(key)` 交给调用方，
 * 本组件不 import `@fenix/web-runtime`，因此可以在没有宿主基建设置的环境里单独渲染。
 */
export function AdminKeyGate({
  unlocked,
  error,
  onUnlock,
  title,
  description,
  inputPlaceholder,
  submitLabel,
  children,
}: AdminKeyGateProps) {
  const [key, setKey] = useState("");
  const errorId = "admin-key-error";

  // 401 回门时清空上一次输入：本组件在解锁后不再卸载（改为渲染 children），不清空会把失效的 key
  // 留在输入框里，与迁移前「门随页面重新挂载、输入为空」的可见行为不一致。
  useEffect(() => {
    if (!unlocked) setKey("");
  }, [unlocked]);

  if (unlocked) return <>{children}</>;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = key.trim();
    if (!trimmed) return;
    onUnlock(trimmed);
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-4 text-brand" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="flex flex-col gap-3">
            <Input
              type="password"
              value={key}
              onChange={(event) => setKey(event.target.value)}
              placeholder={inputPlaceholder}
              aria-label={inputPlaceholder}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              autoFocus
            />
            {/* 鉴权失败提示用 role="alert"：它在提交后异步出现，需要主动播报。 */}
            {error ? (
              <p id={errorId} role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
            <Button type="submit" disabled={!key.trim()}>
              {submitLabel}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
