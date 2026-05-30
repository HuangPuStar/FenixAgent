import { Check, ChevronsUpDown, Pencil, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { WorkflowBoard } from "../../../api/workflow-boards";
import { workflowBoardsApi } from "../../../api/workflow-boards";

interface BoardSelectorProps {
  currentUserId: string;
  selectedBoardId: string | null;
  onSelect: (boardId: string) => void;
  onBoardsChange: () => void;
}

export function BoardSelector({ currentUserId, selectedBoardId, onSelect, onBoardsChange }: BoardSelectorProps) {
  const { t } = useTranslation("kanban");
  const [boards, setBoards] = useState<WorkflowBoard[]>([]);
  const [open, setOpen] = useState(false);

  // 新建看板弹窗
  const [createOpen, setCreateOpen] = useState(false);
  const [createName, setCreateName] = useState("");
  const [creating, setCreating] = useState(false);

  // 重命名弹窗
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);

  const loadBoards = useCallback(async () => {
    try {
      const data = await workflowBoardsApi.list();
      setBoards(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    loadBoards();
  }, [loadBoards]);

  // 自动选择默认或第一个看板
  useEffect(() => {
    if (boards.length === 0 || selectedBoardId) return;
    const defaultBoard = boards.find((b) => b.isDefault) ?? boards[0];
    if (defaultBoard) onSelect(defaultBoard.id);
  }, [boards, selectedBoardId, onSelect]);

  const selectedBoard = boards.find((b) => b.id === selectedBoardId);
  const isOwner = selectedBoard?.userId === currentUserId;

  // 新建看板
  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const board = await workflowBoardsApi.create(createName.trim());
      setCreateOpen(false);
      setCreateName("");
      await loadBoards();
      onSelect(board.id);
      onBoardsChange();
    } catch (err) {
      console.error(err);
      toast.error(t("load_failed", { error: (err as Error).message }));
    } finally {
      setCreating(false);
    }
  }, [createName, loadBoards, onSelect, onBoardsChange, t]);

  // 重命名
  const handleRename = useCallback(async () => {
    if (!selectedBoardId || !renameName.trim()) return;
    setRenaming(true);
    try {
      await workflowBoardsApi.update(selectedBoardId, renameName.trim());
      setRenameOpen(false);
      await loadBoards();
      onBoardsChange();
    } catch (err) {
      console.error(err);
      toast.error(t("load_failed", { error: (err as Error).message }));
    } finally {
      setRenaming(false);
    }
  }, [selectedBoardId, renameName, loadBoards, onBoardsChange, t]);

  // 删除
  const handleDelete = useCallback(async () => {
    if (!selectedBoardId || !selectedBoard) return;
    if (selectedBoard.isDefault) {
      toast.error(t("board_cannot_delete_default"));
      return;
    }
    if (!window.confirm(t("board_delete_confirm", { name: selectedBoard.name }))) return;
    try {
      await workflowBoardsApi.delete(selectedBoardId);
      await loadBoards();
      onBoardsChange();
    } catch (err) {
      console.error(err);
      toast.error(t("load_failed", { error: (err as Error).message }));
    }
  }, [selectedBoardId, selectedBoard, loadBoards, onBoardsChange, t]);

  return (
    <div className="flex items-center gap-1.5">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border-subtle bg-surface-1 text-xs text-text-primary hover:bg-surface-hover transition-colors"
          >
            {selectedBoard?.name ?? t("board_selector_placeholder")}
            <ChevronsUpDown size={12} className="text-text-muted" />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56 p-1" align="start">
          <Command>
            <CommandList>
              <CommandGroup>
                {boards.map((board) => (
                  <CommandItem
                    key={board.id}
                    value={board.name}
                    onSelect={() => {
                      onSelect(board.id);
                      setOpen(false);
                    }}
                    className="flex items-center justify-between"
                  >
                    <span className="truncate text-xs">{board.name}</span>
                    {board.id === selectedBoardId && <Check size={14} className="text-brand" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
          <div className="border-t border-border-subtle p-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setCreateOpen(true);
              }}
              className="flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-xs text-text-secondary hover:bg-surface-hover transition-colors"
            >
              <Plus size={12} />
              {t("board_create")}
            </button>
          </div>
        </PopoverContent>
      </Popover>

      {isOwner && selectedBoardId && (
        <>
          <button
            type="button"
            onClick={() => {
              setRenameName(selectedBoard?.name ?? "");
              setRenameOpen(true);
            }}
            className="p-1.5 rounded-md text-text-muted hover:text-text-primary hover:bg-surface-hover transition-colors"
            title={t("board_rename")}
          >
            <Pencil size={12} />
          </button>
          <button
            type="button"
            onClick={handleDelete}
            className="p-1.5 rounded-md text-text-muted hover:text-red-500 hover:bg-surface-hover transition-colors"
            title={t("board_delete")}
          >
            <Trash2 size={12} />
          </button>
        </>
      )}

      {/* 新建看板弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("board_create_title")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-xs text-text-dim">{t("board_create_placeholder")}</Label>
            <Input
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              placeholder={t("board_create_placeholder")}
              className="mt-1.5 h-8 text-sm"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setCreateOpen(false)}>
              {t("dialog_cancel")}
            </Button>
            <Button size="sm" onClick={handleCreate} disabled={creating || !createName.trim()}>
              {creating ? t("board_create_creating") : t("board_create_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 重命名弹窗 */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("board_rename_title")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Label className="text-xs text-text-dim">{t("board_rename_placeholder")}</Label>
            <Input
              value={renameName}
              onChange={(e) => setRenameName(e.target.value)}
              placeholder={t("board_rename_placeholder")}
              className="mt-1.5 h-8 text-sm"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setRenameOpen(false)}>
              {t("dialog_cancel")}
            </Button>
            <Button size="sm" onClick={handleRename} disabled={renaming || !renameName.trim()}>
              {renaming ? t("board_create_creating") : t("board_rename_confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
