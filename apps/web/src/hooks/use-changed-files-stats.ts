import { useEffect, useState } from "react";
import type { ChatStatsSummary } from "@/src/lib/chat-stats";
import type { ChangedFile } from "@/src/lib/extract-changed-files";

/**
 * 消费 chat:stats 摘要事件，返回当前 agent 的 changedFiles 投影。
 *
 * - 按 `detail.agentName` 过滤：ChatArea 维护跨 agent 的 session keep-alive 槽位，
 *   后台隐藏槽位（节流 flush / 重连收流中）派发的事件不得污染当前 agent 的 ArtifactsPanel。
 * - agentId 变化时重置，避免展示上一个 agent 的残留摘要。
 * - `agent:reconnect`（实例重启）时清空同 agent 的 changedFiles，与重启后重建面板的行为对齐。
 */
export function useChangedFilesFromStats(agentId: string | null): ChangedFile[] {
  const [changedFiles, setChangedFiles] = useState<ChangedFile[]>([]);

  useEffect(() => {
    // 切换 agent 时重置，防止旧 agent 的摘要残留到新 agent 的面板
    setChangedFiles([]);
    const statsHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail as Partial<ChatStatsSummary> | undefined;
      if (!detail) return;
      if (detail.agentName && agentId && detail.agentName !== agentId) return;
      setChangedFiles(detail.changedFiles ?? []);
    };
    const reconnectHandler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.envId && detail.envId === agentId) {
        setChangedFiles([]);
      }
    };
    window.addEventListener("chat:stats", statsHandler);
    window.addEventListener("agent:reconnect", reconnectHandler);
    return () => {
      window.removeEventListener("chat:stats", statsHandler);
      window.removeEventListener("agent:reconnect", reconnectHandler);
    };
  }, [agentId]);

  return changedFiles;
}
