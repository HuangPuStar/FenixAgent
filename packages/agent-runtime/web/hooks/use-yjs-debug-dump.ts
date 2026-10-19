// packages/agent-runtime/web/hooks/use-yjs-debug-dump.ts
// DEV 调试出口：控制台 `__yjs_dump__()` 打印最新 Chat/Session 状态；不持有状态、不阻止 GC。

import { useEffect, useRef } from "react";

export function useYjsDebugDump(chatState: unknown, sessionState: unknown): void {
  const chatRef = useRef(chatState);
  const sessionRef = useRef(sessionState);
  chatRef.current = chatState;
  sessionRef.current = sessionState;
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__yjs_dump__ = () => {
      console.log("── YJS Chat State ──", chatRef.current);
      console.log("── YJS Session State ──", sessionRef.current);
    };
    return () => {
      delete (window as unknown as Record<string, unknown>).__yjs_dump__;
    };
  }, []);
}
