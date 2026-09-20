/**
 * chat 分区示例：会话列表层（SidebarSessionList，按时间分组的会话列表）。
 *
 * 会话列表吃 mock 会话的 `chatState.sessions`，选中会话回到 mock 的 `selectSession`；
 * mock 不持有会话的改名与删除（真实系统里那是宿主的会话管理职责），示例用本组 overlay 兑现。
 * 真实宿主把同一份 overlay 接到 ACPMain 的侧栏，两处显示才一致 —— 本组自持 mock 会话，
 * 因此这里的改名/删除只作用于这一组示例。
 *
 * 本组由 chat-l2.tsx 组装；L1（外壳）与 L2 分属不同页面，不共享同一份 mock 会话。
 */

import { SidebarSessionList } from "@fenix/ui-components";
import { useMockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { useCallback, useMemo, useState } from "react";

/** 会话列表示例组。 */
export function ChatSessionListExamples() {
  const session = useMockChatSession();
  const [notice, setNotice] = useState<string | null>(null);
  // 会话改名/删除的宿主 overlay：mock 只提供消息与会话选择。
  const [renamedTitles, setRenamedTitles] = useState<Record<string, string>>({});
  const [deletedSessionIds, setDeletedSessionIds] = useState<string[]>([]);

  const sessions = useMemo(
    () =>
      session.chatState.sessions
        .filter((candidate) => !deletedSessionIds.includes(candidate.sessionId))
        .map((candidate) =>
          renamedTitles[candidate.sessionId] ? { ...candidate, title: renamedTitles[candidate.sessionId] } : candidate,
        ),
    [deletedSessionIds, renamedTitles, session.chatState.sessions],
  );

  const handleRenameSession = useCallback((sessionId: string, title: string) => {
    setRenamedTitles((current) => ({ ...current, [sessionId]: title }));
    setNotice(`会话已重命名为「${title}」`);
  }, []);

  const handleDeleteSession = useCallback((sessionId: string) => {
    setDeletedSessionIds((current) => [...current, sessionId]);
    setNotice("会话已从列表移除（宿主 overlay，mock 不持有会话管理）");
  }, []);

  return (
    <div className="demo-example">
      <h2 className="demo-example-title">SidebarSessionList（按时间分组的会话列表）</h2>
      <div className="max-w-xs rounded-lg border border-border p-2">
        <SidebarSessionList
          initialActiveSessionId={session.chatState.activeSessionId}
          sessions={sessions}
          onSelectSession={(selected) => {
            session.selectSession(selected.sessionId);
            setNotice(`已切换会话：${selected.title}`);
          }}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          onNotice={(listNotice) => setNotice(`${listNotice.level}: ${listNotice.message}`)}
        />
      </div>
      <p className="demo-hint">
        支持选中、重命名（铅笔）与删除确认（垃圾桶）：三项都走宿主回调，列表自身不持有会话管理状态。
      </p>
      <p className="demo-hint">{notice ?? "等待交互…"}</p>
    </div>
  );
}
