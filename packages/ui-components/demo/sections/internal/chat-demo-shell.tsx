/**
 * chat 分区示例：会话外壳层（ACPMain 全貌 / ContextPanel / 会话列表）。
 *
 * ACPMain 吃 mock 会话的两份快照：发送、取消、权限/问答应答、模式切换、新建与切换会话全部回到 mock 状态机。
 * mock 不持有会话的改名与删除（真实系统里那是宿主的会话管理职责），示例用本层 overlay 兑现，
 * 并与 ContextPanel / 会话列表共享，保证三处显示一致。
 */

import { ACPMain, ContextPanel, SidebarSessionList } from "@fenix/ui-components";
import type { MockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { MOCK_AGENT_ID } from "@fenix/ui-components/chat/mocks/mock-fixtures";
import { useCallback, useMemo, useState } from "react";

/** 会话外壳示例组。 */
export function ChatShellExamples({ session }: { session: MockChatSession }) {
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [contextCollapsed, setContextCollapsed] = useState(false);
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

  const entries = useMemo(
    () => session.projectEntries(session.sessionState.structuredMessages),
    [session.projectEntries, session.sessionState.structuredMessages],
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
    <>
      <div className="demo-example">
        <h2 className="demo-example-title">ACPMain（侧栏 + 会话头 + 消息流 + 输入岛全貌）</h2>
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
        <p className="demo-hint">
          在输入岛回车即可看到流式回放：推理 → 工具 → 计划 → 权限（暂停等待应答）→ 问答 → 完成。
        </p>
        <p className="demo-hint">{notice ?? "等待交互…"}</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">ContextPanel（模型 / 用量 / 工具统计 / 待确认队列）</h2>
        <div className="flex h-[420px] overflow-hidden rounded-lg border border-border">
          <ContextPanel
            entries={entries}
            agentName="Fenix Agent"
            modelName={session.modelName}
            duration="00:42"
            collapsed={contextCollapsed}
            onToggle={() => setContextCollapsed((collapsed) => !collapsed)}
            acpUsage={session.tokenUsage}
          />
        </div>
        <p className="demo-hint">点左侧边缘的折叠按钮可切换收起态（收起后只留一条窄边）。</p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">SidebarSessionList（按时间分组的会话列表）</h2>
        <div className="max-w-xs rounded-lg border border-border p-2">
          <SidebarSessionList
            initialActiveSessionId={chatState.activeSessionId}
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
        <p className="demo-hint">支持选中、重命名（铅笔）与删除确认（垃圾桶），改动同步反映在上方的 ACPMain 侧栏。</p>
      </div>
    </>
  );
}
