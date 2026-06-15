import { useEffect, useRef, useState } from "react";
import { ensureMetaAgent } from "@/src/api/meta-agent";

export interface UseMetaAgentOptions {
  /** localStorage key for persisting chatOpen state */
  storageKey: string;
}

export interface UseMetaAgentReturn {
  /** Meta Agent environment ID, null until ensureMetaAgent completes */
  metaAgentId: string | null;
  /** Whether the chat panel is open */
  chatOpen: boolean;
  /** Set chat open state, persists to localStorage */
  setChatOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
}

/**
 * 通用 Meta Agent hook。
 * 封装 ensureMetaAgent 调用、chatOpen 状态 + localStorage 持久化。
 * 调用方传入唯一的 storageKey 以区分不同场景（workflow/skills）。
 */
export function useMetaAgent({ storageKey }: UseMetaAgentOptions): UseMetaAgentReturn {
  const [chatOpen, setChatOpen] = useState(() => {
    const saved = localStorage.getItem(storageKey);
    return saved !== "false"; // 默认打开，用户关闭后持久化为 "false"
  });
  const [metaAgentId, setMetaAgentId] = useState<string | null>(null);
  // 防止快速 toggle 重复请求
  const pendingRef = useRef(false);

  useEffect(() => {
    localStorage.setItem(storageKey, String(chatOpen));
    // 仅在面板打开且尚未加载时请求 ensure
    if (chatOpen && !metaAgentId && !pendingRef.current) {
      pendingRef.current = true;
      ensureMetaAgent()
        .then((res) => setMetaAgentId(res.environmentId))
        .catch((err) => console.error("Meta Agent failed:", err))
        .finally(() => {
          pendingRef.current = false;
        });
    }
  }, [chatOpen, metaAgentId, storageKey]);

  return { metaAgentId, chatOpen, setChatOpen };
}
