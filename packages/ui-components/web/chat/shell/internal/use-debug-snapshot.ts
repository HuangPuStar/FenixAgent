/**
 * Chat 面板的调试快照（Ctrl + Alt + Shift + D 即时输出当前完整状态）。
 *
 * 来源：从 `packages/chat-channel/web/components/ChatInterface.tsx`（旧路径，已于 2026-09-21 由 8f364c109 删除） 抽出（原为组件内的
 * `DEBUG_SENSITIVE_KEY`、`createDebugSnapshot` 与 keydown effect；抽出后 ChatInterface 保持在
 * 单文件 500 行红线内）。
 * 纯化改动点：effect 的依赖数组由"列出全部状态字段"改为"渲染期快照工厂 + 空依赖"，避免
 * 每次状态变化重建监听器；快照内容与敏感字段遮蔽规则逐字保留（对象结构全保留，仅遮蔽
 * api key / token / password 等明确敏感字段）。
 */

import { useEffect, useRef } from "react";

const DEBUG_SENSITIVE_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token|connectionString)/i;

/** 创建可安全打印的静态快照：保留完整结构，仅遮蔽明确的敏感字段并处理 Map/Set。 */
function createDebugSnapshot(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries(), ([key, item]) => [
        String(key),
        DEBUG_SENSITIVE_KEY.test(String(key)) ? "[REDACTED]" : createDebugSnapshot(item, seen),
      ]),
    );
  }
  if (value instanceof Set) return Array.from(value, (item) => createDebugSnapshot(item, seen));
  if (Array.isArray(value)) return value.map((item) => createDebugSnapshot(item, seen));

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      DEBUG_SENSITIVE_KEY.test(key) ? "[REDACTED]" : createDebugSnapshot(item, seen),
    ]),
  );
}

/**
 * 注册 Ctrl + Alt + Shift + D 快捷键，按下时以 `[chat-debug-snapshot]` 打印 `snapshot()` 的脱敏结果。
 *
 * @param snapshot 快照工厂，在按键时求值（读取当次渲染的最新状态）
 */
export function useChatDebugSnapshot(snapshot: () => unknown): void {
  const snapshotRef = useRef(snapshot);
  // 每次渲染后刷新工厂，使按键时读到最新状态；effect 本身保持空依赖、只注册一次监听
  useEffect(() => {
    snapshotRef.current = snapshot;
  });

  useEffect(() => {
    const handleDebugShortcut = (event: KeyboardEvent) => {
      if (!(event.ctrlKey && event.altKey && event.shiftKey && event.code === "KeyD")) return;
      event.preventDefault();
      console.warn("[chat-debug-snapshot]", createDebugSnapshot(snapshotRef.current()));
    };

    window.addEventListener("keydown", handleDebugShortcut);
    return () => window.removeEventListener("keydown", handleDebugShortcut);
  }, []);
}
