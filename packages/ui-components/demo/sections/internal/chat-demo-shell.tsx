/**
 * chat 分区示例：会话外壳层（ACPMain 全貌）。
 *
 * ACPMain 吃 mock 会话的两份快照：发送、取消、权限/问答应答、模式切换、新建与切换会话全部回到
 * mock 状态机。mock 不持有会话的改名与删除（真实系统里那是宿主的会话管理职责），示例用本层
 * overlay 兑现，并通过 `chatState` 回灌给 ACPMain 的侧栏 —— 与 chat-demo-sessions.tsx 里那份
 * 同名 overlay 相互独立（两个分区各持一份 mock 会话）。
 *
 * 这一层只做组装：外壳内部依次用到会话列表、消息流、输入岛（L2）、工具时间线与面板（L3）、
 * 消息基元（L4），示例本身不新增任何 Chat 元件。
 */

import { ACPMain } from "@fenix/ui-components";
import type { MockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { MOCK_AGENT_ID } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useCallback, useMemo, useState } from "react";

/** 会话外壳示例组。 */
export function ChatShellExamples({ session }: { session: MockChatSession }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
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

  const chatState = useMemo(() => ({ ...session.chatState, sessions }), [session.chatState, sessions]);

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
        ACPMain（侧栏 + 会话头 + 消息流 + 输入岛全貌）
      </h2>
      {/* ACPMain 根节点为 h-full，外层必须给出确定高度；内部分栏与滚动由组件自理。 */}
      <div className="h-[760px] overflow-hidden rounded-lg border border-border">
        <ACPMain
          agentId={MOCK_AGENT_ID}
          chatState={chatState}
          sessionState={session.sessionState}
          connectionState={session.connectionState}
          detailSessionId={chatState.activeSessionId}
          supportsLoadSession
          supportsResumeSession
          supportsImages={session.supportsImages}
          supportsModeSelection={session.supportsModeSelection}
          availableCommands={session.availableCommands}
          availableModes={session.availableModes}
          currentModeId={session.currentModeId}
          onSetMode={session.setSessionMode}
          modelName={session.modelName}
          tokenUsage={session.tokenUsage}
          periTasks={session.periTasks}
          periTasksLoaded={session.periTasksLoaded}
          sidebarOpen={sidebarOpen}
          onSidebarOpenChange={setSidebarOpen}
          projectEntries={session.projectEntries}
          onSendPrompt={session.sendPrompt}
          onCancel={session.cancel}
          onCreateSession={session.createSession}
          onLoadSession={session.selectSession}
          onResumeSession={session.selectSession}
          onRenameSession={handleRenameSession}
          onDeleteSession={handleDeleteSession}
          onRespondPermission={session.respondPermission}
          onRespondQuestion={session.respondQuestion}
          onNotice={(shellNotice) => setNotice(`${shellNotice.level}: ${shellNotice.message}`)}
        />
      </div>
      <p className="mt-3 text-text-muted text-[12px]">
        在输入岛回车即可看到流式回放：推理 → 工具 → 计划 → 权限（暂停等待应答）→ 问答 → 完成。
      </p>
      <p className="mt-3 text-text-muted text-[12px]">{notice ?? "等待交互…"}</p>
    </div>
  );
}
