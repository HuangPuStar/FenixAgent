/**
 * 侧栏 space 分组容器（折叠 + 组头 + 组内会话行 + 放置目标）。
 *
 * 折叠状态是纯展示态（非受控数据）：它不随宿主数据刷新而消失，因此由本组件自持；
 * space 数据（名称、归属）一律来自 `group`，本组件不缓存副本。
 *
 * 整组是一个放置目标（含组头的折叠态）：拖到收起来的分组上同样应该归入它，
 * 否则「先折叠再拖」会得到「拖哪儿都没反应」。
 * 高亮与提示取自 `useDroppable` 的 `isOver`，不为悬停另设一份状态——静止的侧栏因此不因拖动而重渲染。
 */

import { useDroppable } from "@dnd-kit/core";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { cn } from "../../../lib/cn";
import { Collapsible, CollapsibleContent } from "../../../ui/collapsible";
import { toSpaceDropId } from "../../lib/space-drop-target";
import type { ChatSpaceGroup } from "../../lib/space-grouping";
import type { SessionRowActions, SessionRowState } from "./session-row";
import { SpaceHeader } from "./space-header";
import { DraggableSessionRow } from "./space-session-drag";

export interface SpaceGroupSectionProps {
  group: ChatSpaceGroup;
  rowState: SessionRowState;
  rowActions: SessionRowActions;
  /** 在该分组内新建会话（默认分组传 null）；未注入时不渲染该入口 */
  onCreateSessionInSpace?: (spaceId: string | null) => void | Promise<void>;
  /** 提交重命名；未注入或分组不可重命名时不渲染该入口 */
  onRenameSpace?: (spaceId: string, name: string) => void;
}

/** 单个 space 分组：默认展开，组内渲染可拖会话行，空组给一行占位。 */
export function SpaceGroupSection({
  group,
  rowState,
  rowActions,
  onCreateSessionInSpace,
  onRenameSpace,
}: SpaceGroupSectionProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);
  const [open, setOpen] = useState(true);
  const spaceId = group.spaceId;
  // 只有真实 space 才可能重命名：窄化在闭包外完成，避免在事件回调里做断言。
  const renameHandler = spaceId !== null && onRenameSpace ? (name: string) => onRenameSpace(spaceId, name) : undefined;

  // `isOver` 只在拖拽期间为真（`over` 由 dnd-kit 在拖动中维护），静止时不留高亮痕迹。
  const { setNodeRef, isOver } = useDroppable({ id: toSpaceDropId(spaceId) });

  return (
    <div
      ref={setNodeRef}
      data-space-drop-id={toSpaceDropId(spaceId)}
      data-drop-target={isOver ? "true" : undefined}
      className={cn(isOver && "rounded-md bg-brand-subtle ring-1 ring-border-active")}
    >
      <Collapsible open={open} onOpenChange={setOpen}>
        <SpaceHeader
          name={group.name}
          open={open}
          canRename={group.canRename}
          onRename={renameHandler}
          onCreateSession={onCreateSessionInSpace ? () => onCreateSessionInSpace(spaceId) : undefined}
          dropHint={isOver ? t("chat.components.acpMain.dropHereHint") : undefined}
        />
        <CollapsibleContent>
          {group.sessions.map((session) => (
            <DraggableSessionRow key={session.sessionId} session={session} state={rowState} actions={rowActions} />
          ))}
          {/* 空分组保留一行占位：分组头始终在，空内容无法与「没加载出来」区分。 */}
          {group.sessions.length === 0 && (
            <p className="px-3 pb-1 text-3xs text-text-muted">{t("chat.components.acpMain.noSessions")}</p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
