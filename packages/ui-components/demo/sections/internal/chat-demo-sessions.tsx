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

import type { ChatSpaceItem } from "@fenix/ui-components";
import { SidebarSessionList } from "@fenix/ui-components";
import { useMockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
    <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
      <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
        SidebarSessionList（按时间分组的会话列表）
      </h2>
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
      <p className="mt-3 text-text-muted text-[12px]">
        支持选中、重命名（铅笔）与删除确认（垃圾桶）：三项都走宿主回调，列表自身不持有会话管理状态。
      </p>
      <p className="mt-3 text-text-muted text-[12px]">{notice ?? "等待交互…"}</p>
    </div>
  );
}

/**
 * space 分组示例组：同一份 mock 会话 + 本地 space overlay。
 *
 * 传入 `spaces` 后列表切换为「空间 → 会话」的折叠树（最后一组「默认」收未归属会话），
 * 不传时仍是时间分组（见上一组）。space 数据的权威在真实宿主，示例用本地 state 兑现
 * 新建、重命名、拖放移入与移出，以及删除会话后的归属清理；组内新建会话走 `onCreateSessionInSpace`，
 * 因示例直接用列表（不经 ACPMain），新会话的归属用列表差集在本组内兑现
 * （真实装配下由 `ACPMain` 用 `ChatInterfaceHandle.newSession()` 的创建回执调用 `onAssignSession`）。
 */
export function ChatSessionSpaceExamples() {
  const session = useMockChatSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<ChatSpaceItem[]>(() => {
    const [first, second] = session.chatState.sessions;
    return [
      { id: "space-design", name: "架构设计", sessionIds: first ? [first.sessionId] : [] },
      { id: "space-debug", name: "缺陷排查", sessionIds: second ? [second.sessionId] : [] },
    ];
  });
  // 组内新建会话的待归属 space；mock 的 createSession 立即产生新会话，见下方 effect。
  const pendingSpaceRef = useRef<string | null>(null);
  const knownSessionIdsRef = useRef(new Set(session.chatState.sessions.map((item) => item.sessionId)));

  useEffect(() => {
    const sessions = session.chatState.sessions;
    const fresh = sessions.find((item) => !knownSessionIdsRef.current.has(item.sessionId));
    knownSessionIdsRef.current = new Set(sessions.map((item) => item.sessionId));
    const spaceId = pendingSpaceRef.current;
    if (!fresh || !spaceId) return;
    pendingSpaceRef.current = null;
    setSpaces((current) =>
      current.map((space) =>
        space.id === spaceId ? { ...space, sessionIds: [...space.sessionIds, fresh.sessionId] } : space,
      ),
    );
    setNotice(`新会话已归入空间（${fresh.sessionId}）`);
  }, [session.chatState.sessions]);

  const handleCreateSpace = useCallback((name: string) => {
    // 新分组插到最前：真实宿主按创建时间倒序下发（见 `IChatSpaceRepo.listByScope`），示例必须同序。
    setSpaces((current) => [{ id: `space-${current.length + 1}-${Date.now()}`, name, sessionIds: [] }, ...current]);
    setNotice(`已新建空间「${name}」`);
  }, []);

  const handleRenameSpace = useCallback((spaceId: string, name: string) => {
    setSpaces((current) => current.map((space) => (space.id === spaceId ? { ...space, name } : space)));
    setNotice(`空间已重命名为「${name}」`);
  }, []);

  const handleUnassignSession = useCallback((sessionId: string) => {
    setSpaces((current) =>
      current.map((space) => ({ ...space, sessionIds: space.sessionIds.filter((id) => id !== sessionId) })),
    );
    setNotice(`已移出归属（${sessionId}）`);
  }, []);

  // 归属写入：真实宿主是「写后端 → 重取列表」，示例用本地 state 直接兑现同一语义。
  // 一个会话至多属于一个分组，因此写入前先从其它分组摘掉（与后端同一事务内的原子摘除等价）。
  const handleAssignSession = useCallback((spaceId: string, sessionId: string) => {
    setSpaces((current) =>
      current.map((space) => ({
        ...space,
        sessionIds:
          space.id === spaceId
            ? [...space.sessionIds.filter((id) => id !== sessionId), sessionId]
            : space.sessionIds.filter((id) => id !== sessionId),
      })),
    );
    setNotice(`已移入分组（${sessionId} → ${spaceId}）`);
  }, []);

  return (
    <div className="mb-5 p-5 border border-border rounded-lg bg-surface-1">
      <h2 data-slot="demo-example-title" className="mb-4 text-text-secondary text-[13px] font-medium">
        SidebarSessionList（space 分组的会话列表）
      </h2>
      <div className="max-w-xs rounded-lg border border-border p-2">
        <SidebarSessionList
          initialActiveSessionId={session.chatState.activeSessionId}
          sessions={session.chatState.sessions}
          spaces={spaces}
          spacesLoaded
          onSelectSession={(selected) => {
            session.selectSession(selected.sessionId);
            setNotice(`已切换会话：${selected.title}`);
          }}
          onRenameSession={() => setNotice("会话改名属宿主职责，本组只演示 space 层")}
          onDeleteSession={() => setNotice("会话删除属宿主职责，本组只演示 space 层")}
          onCreateSpace={handleCreateSpace}
          onRenameSpace={handleRenameSpace}
          onAssignSession={handleAssignSession}
          onUnassignSession={handleUnassignSession}
          onCreateSessionInSpace={(spaceId) => {
            pendingSpaceRef.current = spaceId;
            void session.createSession();
          }}
          onNotice={(listNotice) => setNotice(`${listNotice.level}: ${listNotice.message}`)}
        />
      </div>
      <p className="mt-3 text-text-muted text-[12px]">
        分组头可折叠；悬浮分组名显示「重命名」与「在该分组新建会话」，默认分组只保留新建。列表顶部可新建空间。
      </p>
      <p className="mt-3 text-text-muted text-[12px]">
        会话行可拖到任意分组（拖到「默认」即移出归属）；归属只能靠指针拖拽写入，触屏与键盘暂不支持。
      </p>
      <p className="mt-3 text-text-muted text-[12px]">{notice ?? "等待交互…"}</p>
    </div>
  );
}
