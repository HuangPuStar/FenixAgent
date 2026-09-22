// web/hooks/use-admin-key-gate.ts
// 管理页 Master Key 门的状态机（读取 key / 解锁 / 401 失败路径）。
//
// 归属：`AdminKeyGate` 是纯展示组件（`@fenix/ui-components/config/AdminKeyGate`，不依赖本包），
// 而「key 存哪里、401 怎么回门」是渲染无关的取数与状态逻辑，必须落在中性共享基建 `@fenix/web-runtime`。
// 此前这段样板在 5 个管理页（sandbox 1 / observer 3 / model-management 1）各抄一遍：
// `useState(getAdminKey() !== null)` + `useState<string | null>(null)` + 两处 `clearAdminKey()` 收敛。
//
// 与 `./admin-key` 的分工：那里是 master key 的唯一读写实现（含权限取舍说明），本模块只编排它的调用顺序。

import { useCallback, useEffect, useRef, useState } from "react";
import { clearAdminKey, getAdminKey, setAdminKey } from "../lib/admin-key";

/** 门的状态与两个回调；`unlock` / `fail` 的引用稳定，可直接挂到请求的 `onError` 上。 */
export interface AdminKeyGateController {
  /** 本会话是否已解锁（初始值取 sessionStorage 里是否已有 key）。 */
  unlocked: boolean;
  /** 上次鉴权失败的用户可见提示；未失败为 null。 */
  error: string | null;
  /** 提交密钥：写入 sessionStorage、清错误提示并解锁。 */
  unlock: (key: string) => void;
  /** 面板内请求 401：清 key、带提示回门。 */
  fail: () => void;
}

/**
 * 管理页 Master Key 门的状态机。
 *
 * @param authErrorMessage 401 回门时展示的提示（各页分属不同命名空间，措辞由调用方决定）。
 *
 * 为什么错误提示走 `ref` 而不是 `useCallback` 依赖：`fail` 会被挂到 `useRequest` 的 `onError` 上，
 * 引用随语言切换变化会让请求重建；提示文案在调用时取最新值即可。
 */
export function useAdminKeyGate(authErrorMessage: string): AdminKeyGateController {
  const [unlocked, setUnlocked] = useState(() => getAdminKey() !== null);
  const [error, setError] = useState<string | null>(null);
  const messageRef = useRef(authErrorMessage);

  useEffect(() => {
    messageRef.current = authErrorMessage;
  }, [authErrorMessage]);

  const unlock = useCallback((key: string) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setAdminKey(trimmed);
    setError(null);
    setUnlocked(true);
  }, []);

  const fail = useCallback(() => {
    clearAdminKey();
    setError(messageRef.current);
    setUnlocked(false);
  }, []);

  return { unlocked, error, unlock, fail };
}
