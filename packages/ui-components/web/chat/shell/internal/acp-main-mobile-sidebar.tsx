/**
 * ACPMain 的移动端会话侧边栏（Sheet 抽屉 + 会话列表）。
 *
 * 来源：从 `packages/chat-channel/web/components/ACPMain.tsx`（旧路径，已于 2026-09-21 由 8f364c109 删除） 的移动端 `Sheet` 分支原样抽出
 * （抽出后 ACPMain 保持在单文件 500 行红线内）。
 * 纯化改动点：UI 组件与 i18n 改为包内导入（键前缀 `chat.components.`）；JSX、类名与文案逐字保留。
 */

import { Plus } from "lucide-react";
import { useTranslation } from "react-i18next";
import { UI_COMPONENTS_NS } from "../../../i18n/namespace";
import { Button } from "../../../ui/button";
import { ScrollArea } from "../../../ui/scroll-area";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "../../../ui/sheet";
import type { SessionSummary } from "../../types";
import type { ChatNotice, ChatSpaceItem } from "../chat-interface-types";
import { SidebarSessionList } from "../sidebar-session-list";

/** 移动端会话抽屉属性。 */
export interface AcpMainMobileSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 新建会话（关闭抽屉后触发） */
  onNewSession: () => void;
  sessions?: readonly SessionSummary[];
  initialActiveSessionId: string | null;
  onSelectSession: (session: SessionSummary) => void;
  onRenameSession: (sessionId: string, title: string) => void;
  onDeleteSession: (sessionId: string) => void;
  /** 会话重命名 / 删除失败的提示出口（源实现在 `SidebarSessionList` 内直连 sonner） */
  onNotice?: (notice: ChatNotice) => void;
  // ── space 分组（与 `SidebarSessionList` / `ACPMain` 同名同义，逐项透传）──
  spaces?: readonly ChatSpaceItem[];
  spacesLoaded?: boolean;
  spacesError?: boolean;
  onRefreshSpaces?: () => void;
  onCreateSpace?: (name: string) => void | Promise<void>;
  onRenameSpace?: (spaceId: string, name: string) => void | Promise<void>;
  onAssignSession?: (spaceId: string, sessionId: string) => void | Promise<void>;
  onUnassignSession?: (sessionId: string) => void | Promise<void>;
  /** 在指定分组内新建会话（默认分组传 null） */
  onCreateSessionInSpace?: (spaceId: string | null) => void | Promise<void>;
}

/** 窄屏（`md:hidden`）会话抽屉：标题 + 新建入口 + 会话列表。复制自 `ACPMain.tsx` 的 Sheet 分支。 */
export function AcpMainMobileSidebar({
  open,
  onOpenChange,
  onNewSession,
  sessions,
  initialActiveSessionId,
  onSelectSession,
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
}: AcpMainMobileSidebarProps) {
  const { t } = useTranslation(UI_COMPONENTS_NS);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[85vw] max-w-sm gap-0 p-0 md:hidden">
        <SheetHeader className="border-b border-border/40 pr-12">
          <SheetTitle>{t("chat.components.acpMain.sessions")}</SheetTitle>
          <SheetDescription className="sr-only">{t("chat.components.acpMain.historySessions")}</SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-end px-3 py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onNewSession();
              }}
              className="gap-1.5 text-text-muted hover:bg-brand/10 hover:text-brand"
            >
              <Plus className="h-4 w-4" />
              {t("chat.components.acpMain.newSession")}
            </Button>
          </div>
          <ScrollArea className="min-h-0 flex-1">
            <SidebarSessionList
              initialActiveSessionId={initialActiveSessionId}
              onSelectSession={onSelectSession}
              sessions={sessions}
              onRenameSession={onRenameSession}
              onDeleteSession={onDeleteSession}
              onNotice={onNotice}
              spaces={spaces}
              spacesLoaded={spacesLoaded}
              spacesError={spacesError}
              onRefreshSpaces={onRefreshSpaces}
              onCreateSpace={onCreateSpace}
              onRenameSpace={onRenameSpace}
              onAssignSession={onAssignSession}
              onUnassignSession={onUnassignSession}
              onCreateSessionInSpace={onCreateSessionInSpace}
            />
          </ScrollArea>
        </div>
      </SheetContent>
    </Sheet>
  );
}
