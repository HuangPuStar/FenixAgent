/**
 * chat 分区示例：面板层（权限 / 问答 / 待办 / 状态三 Tab）。
 *
 * 全部面板都直接吃 mock 会话的投影：权限与问答的应答经 `session.respondPermission` /
 * `respondQuestion` 回到 mock 状态机（卡片随即消失），待办与变更文件用包内纯函数
 * （`deriveTodoItems` / `extractChangedFiles`）从 mock 时间线派生 —— 正是 ChatInterface 的取数方式。
 */

import {
  Button,
  ChatStatusPanel,
  derivePendingPermissions,
  deriveTodoItems,
  extractChangedFiles,
  PermissionPanel,
  QuestionPanel,
  TodoPanel,
} from "@fenix/ui-components";
import type { MockChatSession } from "@fenix/ui-components/chat/mocks/mock-chat-store";
import { useMemo, useState } from "react";

/** 面板示例组。 */
export function ChatPanelsExamples({ session }: { session: MockChatSession }) {
  const [lastAction, setLastAction] = useState<string | null>(null);

  // 与 ChatInterface 相同的取数路径：结构化消息 → 渲染条目 → 派生待办与变更文件。
  const entries = useMemo(
    () => session.projectEntries(session.sessionState.structuredMessages),
    [session.projectEntries, session.sessionState.structuredMessages],
  );
  const todos = useMemo(() => deriveTodoItems(entries), [entries]);
  const changedFiles = useMemo(() => extractChangedFiles(entries), [entries]);
  const permissions = useMemo(
    () => derivePendingPermissions(session.chatState.permissions),
    [session.chatState.permissions],
  );
  const questions = useMemo(
    () => Array.from(session.sessionState.pendingQuestions.values()),
    [session.sessionState.pendingQuestions],
  );

  return (
    <>
      <div className="demo-example">
        <h2 className="demo-example-title">ChatStatusPanel（todo / tasks / changes 三 Tab）</h2>
        <ChatStatusPanel
          todos={todos}
          tasks={session.periTasks}
          tasksLoaded={session.periTasksLoaded}
          changedFiles={changedFiles}
          onOpenTask={(task) => setLastAction(`打开任务详情：${task.title}`)}
          onPreviewFile={(path) => setLastAction(`预览文件：${path}`)}
        />
        <p className="demo-hint">
          {lastAction ?? "三个 tab 都可点：todo 折叠清单、tasks 打开详情、changes 触发文件预览回调。"}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">PermissionPanel</h2>
        <PermissionPanel requests={permissions} onRespond={session.respondPermission} />
        <p className="demo-hint">
          {permissions.length === 0
            ? "权限已应答（空列表时组件返回 null，不占位）。"
            : "点击「允许一次 / 本会话始终允许 / 拒绝」会把该请求从 mock 快照中移除。"}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">QuestionPanel</h2>
        <QuestionPanel questions={questions} onRespond={session.respondQuestion} />
        <p className="demo-hint">
          {questions.length === 0
            ? "问题已提交（空列表时组件返回 null）。"
            : "每个问题项都要选中一个选项，提交按钮才会启用。"}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">TodoPanel</h2>
        <TodoPanel todos={todos} title="来自 plan 快照的待办" />
        <p className="demo-hint">
          {todos.length === 0
            ? "当前时间线还没有 plan 快照：在下方「会话外壳」里发送一条消息即可生成。"
            : "待办取自最后一条 plan 快照（与 ChatInterface 的 deriveTodoItems 一致）。"}
        </p>
      </div>

      <div className="demo-example">
        <h2 className="demo-example-title">重置 mock 会话</h2>
        <Button size="sm" variant="outline" onClick={session.reset}>
          恢复初始消息 / 权限 / 问答
        </Button>
        <p className="demo-hint">重置后时间线、待应答权限与问题都会回到 mock 的初始样本。</p>
      </div>
    </>
  );
}
