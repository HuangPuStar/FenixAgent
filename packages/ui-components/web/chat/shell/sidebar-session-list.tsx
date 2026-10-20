import { DndContext } from "@dnd-kit/core";
import { AlertCircle, RefreshCw } from "lucide-react";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "../../config/EmptyState";
import { UI_COMPONENTS_NS } from "../../i18n/namespace";
import { Spinner } from "../../ui/spinner";
import { canDeleteSession } from "../lib/session-actions";
import { groupByRecency } from "../lib/session-grouping";
import {
  applyAssignmentOverrides,
  NO_ASSIGNMENT_OVERRIDES,
  pruneSettledOverrides,
  resolveDropTarget,
  type SpaceAssignmentOverrides,
} from "../lib/space-drop-target";
import { groupBySpace } from "../lib/space-grouping";
import { stripHtmlTags } from "../lib/strip-html-tags";
import type { SessionSummary } from "../types";
import type { ChatNotice, ChatSpaceItem } from "./chat-interface-types";
import { CreateSpaceEntry } from "./internal/create-space-entry";
import { DeleteSessionDialog } from "./internal/delete-session-dialog";
import { SessionRow, type SessionRowActions, type SessionRowState } from "./internal/session-row";
import { SpaceGroupSection } from "./internal/space-group-section";
import { SPACE_DROP_COLLISION_DETECTION, useSpaceSessionDrag } from "./internal/space-session-drag";
import { useSpaceActionRunner } from "./internal/use-space-action-runner";

/**
 * 侧边栏会话列表属性。
 * 复制自 `packages/agent-runtime/web/components/chat/sidebar-session-list.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 */
interface SidebarSessionListProps {
  initialActiveSessionId: string | null;
  onSelectSession: (session: SessionSummary) => void;
  sessions?: readonly SessionSummary[];
  loading?: boolean;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  /** 运行时提示出口（替代 sonner toast） */
  onNotice?: (notice: ChatNotice) => void;

  // ── space 分组（会话空间树）──
  /**
   * 空间列表（顺序即分组展示顺序）。**未注入（undefined）时列表保持原有「今天/昨天/更早」时间分组**，
   * 注入后第一组固定为「默认」（未归属会话）—— 因此 `[]` 与 `undefined` 语义不同：
   * 前者是「已加载、暂无空间」，后者是「未接入 space」。
   */
  spaces?: readonly ChatSpaceItem[];
  /** space 数据是否已加载完成；false 且无会话时保持 loading 态（空列表此刻不代表没有会话） */
  spacesLoaded?: boolean;
  /**
   * 分组列表加载失败。失败必须可见：既不能退回时间分组假冒「没有分组这回事」，
   * 也不能停在「尚未加载」的 Spinner 上把失败伪装成加载中。
   */
  spacesError?: boolean;
  /** 重取分组列表（失败提示里的重试入口）；未注入时错误提示只说明情况，不给按钮 */
  onRefreshSpaces?: () => void;
  /** 新建空间（名称已 trim）；刷新由上层负责 */
  onCreateSpace?: (name: string) => void | Promise<void>;
  /** 重命名空间（名称已 trim 且与原值不同）；刷新由上层负责 */
  onRenameSpace?: (spaceId: string, name: string) => void | Promise<void>;
  /**
   * 会话归属写入（spaceId + sessionId）：当前唯一入口是指针拖拽（见 `space-session-drag.tsx`）。
   * 未注入时拖放不会产生乐观归属——本包不持有 space 的权威数据。
   */
  onAssignSession?: (spaceId: string, sessionId: string) => void | Promise<void>;
  /** 清除会话归属（拖到「默认」分组、会话删除成功后调用）；失败会撤销对应的乐观展示并提示 */
  onUnassignSession?: (sessionId: string) => void | Promise<void>;
  /**
   * 在指定分组内新建会话（默认分组传 null）；由上层记录待归属意图并触发新建。
   * 未注入时不渲染组内新建入口。
   */
  onCreateSessionInSpace?: (spaceId: string | null) => void | Promise<void>;
}

/**
 * 会话切换失败的回退信号（`token` 递增即表示「把高亮拉回 `sessionId`」）。
 *
 * 列表高亮在点击瞬间乐观置位（本组件 `activeId`），切换失败后没有任何东西会把它拉回来，
 * 界面会持续停在错误的高亮上。仅把 `initialActiveSessionId` 设回原值不构成回退：它值未变，
 * 依赖它的同步 effect 不会重跑，因此必须由 `ACPMain` 下发一个显式信号。
 */
export interface SessionSelectFallback {
  /** 真实的当前会话（会话投影实际展示的会话）；null 表示当前没有会话 */
  sessionId: string | null;
  /** 回退序号，每次失败递增；同一会话连续失败也要重新生效 */
  token: number;
}

/**
 * 回退信号通道：用 Context 而非逐层 prop，是因为侧边栏列表还被移动端抽屉
 * （`internal/acp-main-mobile-sidebar.tsx`）与 `ChatHeader` 间接渲染，`ACPMain` 无法在不改动
 * 这两个包装组件的前提下把新增 prop 传进去；Context 在 `ACPMain` 根节点注入一次即可覆盖
 * 全部 `SidebarSessionList` 实例（Radix Portal 不切断 React Context）。
 * 未注入 Provider 时（独立使用本组件、演示页）值为 null，行为与新增信号前完全一致。
 */
const SessionSelectFallbackContext = createContext<SessionSelectFallback | null>(null);

/** 注入会话切换失败回退信号（Provider 由 `ACPMain` 在根节点装配）。 */
export function SessionSelectFallbackProvider({
  fallback,
  children,
}: {
  fallback: SessionSelectFallback | null;
  children: ReactNode;
}) {
  return <SessionSelectFallbackContext.Provider value={fallback}>{children}</SessionSelectFallbackContext.Provider>;
}

/**
 * 紧凑的会话历史列表，负责会话的重命名与删除确认，以及 space 分组树（折叠、组内新建、组名重命名）。
 *
 * 复制自 `packages/agent-runtime/web/components/chat/sidebar-session-list.tsx`（旧路径，已于 2026-09-21 由 f2741a82d 删除）。
 * 纯化改动点：`toast.error` 改为 `onNotice` 回调；`stripHtmlTags` / `cn` / UI 组件 / 类型
 * 全部改为包内导入；i18n 收敛到 `UI_COMPONENTS_NS`（键前缀 `chat.components.`）。
 * 拆分改动点：会话行抽到 `internal/session-row`，分组头与折叠抽到 `internal/space-header` /
 * `internal/space-group-section`，分组算法抽到 `lib/space-grouping`（单文件 500 行红线）。
 * 2026-10-15 拖放批次：会话行可拖到任意分组（拖到「默认」即移出归属），拖拽装配在
 * `internal/space-session-drag`、放置决策与乐观覆盖在 `lib/space-drop-target`；本组件只做接线与写入。
 */
export function SidebarSessionList({
  initialActiveSessionId,
  onSelectSession,
  sessions = [],
  loading = false,
  onRenameSession,
  onDeleteSession,
  onNotice,
  spaces,
  spacesLoaded,
  spacesError,
  onRefreshSpaces,
  onCreateSpace,
  onRenameSpace,
  onAssignSession,
  onUnassignSession,
  onCreateSessionInSpace,
}: SidebarSessionListProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{ sessionId: string; title: string } | null>(null);
  // 归属写入的本地覆盖（见 `lib/space-drop-target`）：界面先动，宿主快照追上来后退场。
  const [assignmentOverrides, setAssignmentOverrides] = useState<SpaceAssignmentOverrides>(NO_ASSIGNMENT_OVERRIDES);
  const pendingDeletes = useRef(new Set<string>());
  const assignmentVersions = useRef(new Map<string, symbol>());
  const pendingAssignments = useRef(new Set<string>());
  const [settledAssignment, setSettledAssignment] = useState(0);
  const runSpaceAction = useSpaceActionRunner(onNotice);

  const handleSelect = useCallback(
    (session: SessionSummary) => {
      setActiveId(session.sessionId);
      onSelectSession(session);
    },
    [onSelectSession],
  );
  const handleStartRename = useCallback((session: SessionSummary) => {
    setEditingId(session.sessionId);
    setEditTitle(session.title ?? "");
  }, []);
  const handleEditTitleChange = useCallback((title: string) => setEditTitle(title), []);
  const handleSaveRename = useCallback(
    (sessionId: string) => {
      const title = editTitle.trim();
      if (!title) return;
      try {
        onRenameSession(sessionId, title);
      } catch (error) {
        onNotice?.({
          level: "error",
          message: t("chat.components.acpMain.renameFailed", { message: error instanceof Error ? error.message : "" }),
        });
      }
      setEditingId(null);
      setEditTitle("");
    },
    [editTitle, onRenameSession, t, onNotice],
  );
  const handleCancelRename = useCallback(() => {
    setEditingId(null);
    setEditTitle("");
  }, []);

  const handleDelete = useCallback(
    (sessionId: string) => {
      if (!canDeleteSession(sessionId, initialActiveSessionId)) return;
      const target = sessions.find((session) => session.sessionId === sessionId);
      setDeleteTarget({
        sessionId,
        title: stripHtmlTags(target?.title?.trim() ?? "") || t("chat.components.acpMain.newSession"),
      });
    },
    [initialActiveSessionId, sessions, t],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!deleteTarget) return;
    const { sessionId } = deleteTarget;
    try {
      onDeleteSession(sessionId);
      if (activeId === sessionId) setActiveId(null);
      // onDeleteSession 只发送 ACP 动作；列表确认消失之前，不能把发送成功当作删除成功。
      pendingDeletes.current.add(sessionId);
    } catch (error) {
      onNotice?.({
        level: "error",
        message: t("chat.components.acpMain.deleteFailed", { message: error instanceof Error ? error.message : "" }),
      });
    } finally {
      setDeleteTarget(null);
    }
  }, [activeId, deleteTarget, onDeleteSession, t, onNotice]);

  useEffect(() => {
    if (loading) return;
    const remaining = new Set(sessions.map((session) => session.sessionId));
    for (const sessionId of pendingDeletes.current) {
      if (remaining.has(sessionId)) continue;
      pendingDeletes.current.delete(sessionId);
      runSpaceAction(
        "chat.components.acpMain.assignSpaceFailed",
        onUnassignSession ? () => onUnassignSession(sessionId) : undefined,
      );
    }
  }, [sessions, loading, onUnassignSession, runSpaceAction]);

  const handleCreateSpace = useCallback(
    (name: string) => {
      runSpaceAction(
        "chat.components.acpMain.createSpaceFailed",
        onCreateSpace ? () => onCreateSpace(name) : undefined,
      );
    },
    [onCreateSpace, runSpaceAction],
  );
  const handleRenameSpace = useCallback(
    (spaceId: string, name: string) => {
      runSpaceAction(
        "chat.components.acpMain.renameSpaceFailed",
        onRenameSpace ? () => onRenameSpace(spaceId, name) : undefined,
      );
    },
    [onRenameSpace, runSpaceAction],
  );

  /**
   * 乐观写入 + 失败回退（拖放落点的唯一写入出口）。
   *
   * 覆盖表在写入发起前置位、在失败出口撤销：两者绑定才能保证界面要么停在已落库的归属上，
   * 要么回到宿主快照，不会停在一个从没写成功的中间态。
   */
  const commitAssignment = useCallback(
    (sessionId: string, spaceId: string | null, write: () => void | Promise<void>) => {
      const version = Symbol();
      assignmentVersions.current.set(sessionId, version);
      pendingAssignments.current.add(sessionId);
      setAssignmentOverrides((current) => new Map(current).set(sessionId, spaceId));
      const finish = () => {
        if (assignmentVersions.current.get(sessionId) !== version) return;
        pendingAssignments.current.delete(sessionId);
        setSettledAssignment((value) => value + 1);
      };
      const perform = () => {
        try {
          const result = write();
          if (result instanceof Promise) return result.finally(finish);
          finish();
        } catch (error) {
          finish();
          throw error;
        }
      };
      runSpaceAction("chat.components.acpMain.moveToSpaceFailed", perform, () => {
        // 迟到失败只撤回它自己的覆盖，不能删除用户随后一次移动的意图。
        if (assignmentVersions.current.get(sessionId) !== version) return;
        assignmentVersions.current.delete(sessionId);
        setAssignmentOverrides((current) => {
          const next = new Map(current);
          next.delete(sessionId);
          return next;
        });
      });
    },
    [runSpaceAction],
  );

  /**
   * 归属写入的入口（拖放落点解析后的唯一出口）：按目标选出宿主回调，回调缺失时**什么都不做**。
   *
   * 不置位乐观状态是刻意的：宿主没接写入能力时画出一个永远不会落库的归属，比不做任何事更糟。
   */
  const handleMoveSession = useCallback(
    (sessionId: string, spaceId: string | null) => {
      if (spaceId === null) {
        if (!onUnassignSession) return;
        commitAssignment(sessionId, null, () => onUnassignSession(sessionId));
        return;
      }
      if (!onAssignSession) return;
      commitAssignment(sessionId, spaceId, () => onAssignSession(spaceId, sessionId));
    },
    [onAssignSession, onUnassignSession, commitAssignment],
  );

  useEffect(() => setActiveId(initialActiveSessionId), [initialActiveSessionId]);

  // 切换失败回退：按整体信号对象触发（token 变化），把乐观置位的高亮拉回真实会话。
  // 失败前 initialActiveSessionId 未变（成功路径才会更新它），所以不能依赖上一行的 effect。
  const fallback = useContext(SessionSelectFallbackContext);
  useEffect(() => {
    if (!fallback) return;
    setActiveId(fallback.sessionId);
  }, [fallback]);

  const rowState: SessionRowState = { activeId, editingId, editTitle, initialActiveSessionId };
  const rowActions: SessionRowActions = {
    onSelect: handleSelect,
    onEditTitleChange: handleEditTitleChange,
    onStartRename: handleStartRename,
    onSaveRename: handleSaveRename,
    onCancelRename: handleCancelRename,
    onDelete: handleDelete,
  };

  // space 分组与时间分组互斥：未注入 spaces 才构造时间分组，避免两份分组数据同时驻留。
  // 分组消费的是叠加了乐观覆盖的列表：拖放后界面立刻按新归属重排，不必等宿主重取。
  const effectiveSpaces = useMemo(
    () => (spaces === undefined ? undefined : applyAssignmentOverrides(spaces, assignmentOverrides)),
    [spaces, assignmentOverrides],
  );
  const spaceGroups = useMemo(
    () =>
      effectiveSpaces === undefined
        ? null
        : groupBySpace(sessions, effectiveSpaces, t("chat.components.acpMain.defaultSpace")),
    [effectiveSpaces, sessions, t],
  );
  const recencyGroups = useMemo(
    () =>
      spaces === undefined
        ? groupByRecency(sessions, {
            today: t("chat.components.acpMain.today"),
            yesterday: t("chat.components.acpMain.yesterday"),
            earlier: t("chat.components.acpMain.earlier"),
          })
        : [],
    [spaces, sessions, t],
  );

  // 拖动结束：先把落点翻译成归属意图，再走归属写入出口。
  const handleDropSession = useCallback(
    (sessionId: string, overId: string) => {
      const intent = resolveDropTarget(sessionId, overId, spaceGroups ?? []);
      if (!intent) return;
      handleMoveSession(sessionId, intent.kind === "assign" ? intent.spaceId : null);
    },
    [spaceGroups, handleMoveSession],
  );
  const drag = useSpaceSessionDrag(handleDropSession);

  // 宿主快照体现过的乐观覆盖退场；快照未变（重取失败或尚未回来）时保留本地结果。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 写落定也需重检已到达的快照，ref 变化不会触发 effect。
  useEffect(() => {
    if (spaces === undefined) return;
    setAssignmentOverrides((current) => pruneSettledOverrides(spaces, current, pendingAssignments.current));
  }, [spaces, settledAssignment]);
  useEffect(() => {
    for (const sessionId of assignmentVersions.current.keys()) {
      if (!assignmentOverrides.has(sessionId) && !pendingAssignments.current.has(sessionId)) {
        assignmentVersions.current.delete(sessionId);
      }
    }
  }, [assignmentOverrides]);

  // 分组列表加载失败：失败必须可见且可恢复（前端规范 §3.4「失败不得映射成 empty 或成功」、
  // §5.8「禁止在用户可感知失败处只写 console.error」）。
  // 有会话时用紧凑排布（`py-4` 覆盖默认 `py-10`）：提示与列表并存，会话仍可切换。
  const spaceLoadFailure = spacesError ? (
    <EmptyState
      tone="danger"
      role="alert"
      className={sessions.length > 0 ? "py-4" : undefined}
      icon={<AlertCircle />}
      title={t("chat.components.acpMain.spacesLoadFailed")}
      action={
        onRefreshSpaces
          ? { label: t("chat.components.acpMain.retry"), onClick: onRefreshSpaces, icon: <RefreshCw /> }
          : undefined
      }
    />
  ) : undefined;

  // 无会话可显示时整区接管（与 knowledge / prod-view 同判据：先谈「有没有别的内容可显示」）；
  // 仍有会话时只提示、不接管——会话列表是另一路数据且仍然可用，为分组失败阻断会话切换代价更大。
  if (sessions.length === 0 && spaceLoadFailure) {
    return spaceLoadFailure;
  }
  // space 数据未到达时空列表不代表「没有会话」，必须继续显示 loading；spacesLoaded 未注入时不参与判定。
  if (sessions.length === 0 && (loading || spacesLoaded === false)) {
    // `inline-flex` 上的 `mx-auto` 不产生水平居中（auto 外边距只对块级盒生效），补 `flex` 保持原先「随外层居中」的视觉。
    return <Spinner size="sm" className="mx-auto my-8 flex" />;
  }
  if (sessions.length === 0 && !spaceGroups) {
    return (
      <div className="flex flex-col items-center justify-center gap-1 py-8">
        <span className="text-xs font-display text-text-muted">{t("chat.components.acpMain.noSessions")}</span>
        <span className="text-3xs text-text-muted">{t("chat.components.acpMain.clickToCreate")}</span>
      </div>
    );
  }

  return (
    <nav className="py-1" aria-label={t("chat.components.acpMain.historySessions")}>
      {spaceLoadFailure}
      {spaceGroups ? (
        <>
          {/* 桌面侧栏与移动端抽屉各自渲染一份 SidebarSessionList，因此「新建空间」两侧各一处。 */}
          <CreateSpaceEntry onCreate={onCreateSpace ? handleCreateSpace : undefined} />
          {/* 拖拽上下文只包住 space 分组：时间分组路径没有归属可写，也不该注册传感器。 */}
          <DndContext
            sensors={drag.sensors}
            collisionDetection={SPACE_DROP_COLLISION_DETECTION}
            onDragEnd={drag.onDragEnd}
          >
            {spaceGroups.map((group) => (
              <SpaceGroupSection
                key={group.spaceId ?? "default"}
                group={group}
                rowState={rowState}
                rowActions={rowActions}
                onCreateSessionInSpace={onCreateSessionInSpace}
                onRenameSpace={onRenameSpace ? handleRenameSpace : undefined}
              />
            ))}
          </DndContext>
        </>
      ) : (
        recencyGroups.map((group) => (
          <div key={group.label}>
            <div className="px-3 pb-1.5 pt-3">
              <span className="text-3xs font-semibold uppercase tracking-widest text-text-muted/70">{group.label}</span>
            </div>
            {group.sessions.map((session) => (
              <SessionRow key={session.sessionId} session={session} state={rowState} actions={rowActions} />
            ))}
          </div>
        ))
      )}

      <DeleteSessionDialog
        open={deleteTarget !== null}
        title={deleteTarget?.title}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </nav>
  );
}
