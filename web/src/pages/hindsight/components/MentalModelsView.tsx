import { Brain, Loader2, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { hindsightApi } from "@/src/api/hindsight";
import { NS } from "@/src/i18n";

import type { MentalModel } from "../types";

/** 内容预览截断长度 */
const PREVIEW_LENGTH = 200;

/** 删除确认弹窗 */
function DeleteConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  modelName,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  modelName: string;
}) {
  const { t } = useTranslation(NS.HINDSIGHT);
  const [deleting, setDeleting] = useState(false);

  const handleDelete = async () => {
    setDeleting(true);
    try {
      onConfirm();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("mentalModels.delete")}</DialogTitle>
          <DialogDescription>{t("mentalModels.deleteConfirm")}</DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium break-words">{modelName}</p>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={deleting}>
            {t("common:cancel", { defaultValue: "Cancel" })}
          </Button>
          <Button variant="destructive" onClick={handleDelete} disabled={deleting}>
            {deleting && <Loader2 className="size-4 animate-spin" />}
            {t("mentalModels.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 模型详情弹窗 */
function ModelDetailDialog({
  model,
  open,
  onOpenChange,
  onDelete,
}: {
  model: MentalModel | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDelete: (model: MentalModel) => void;
}) {
  const { t } = useTranslation(NS.HINDSIGHT);

  if (!model) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {model.name}
            {model.is_stale && (
              <Badge variant="secondary" className="text-xs">
                {t("mentalModels.stale")}
              </Badge>
            )}
          </DialogTitle>
          <DialogDescription>{model.source_query}</DialogDescription>
        </DialogHeader>

        {/* 标签 */}
        {model.tags.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {model.tags.map((tag) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        )}

        {/* 完整内容 */}
        <div className="flex-1 overflow-auto">
          <div className="rounded-md border bg-muted/30 p-4">
            <p className="text-sm whitespace-pre-wrap break-words leading-relaxed">{model.content}</p>
          </div>
        </div>

        {/* 底部元信息 + 删除按钮 */}
        <DialogFooter className="flex items-center justify-between gap-4 sm:justify-between">
          <div className="text-xs text-muted-foreground space-y-0.5">
            {model.last_refreshed_at && (
              <p>
                {t("mentalModels.lastRefreshed")}: {new Date(model.last_refreshed_at).toLocaleString()}
              </p>
            )}
            <p>
              {t("memories.createdAt")}: {new Date(model.created_at).toLocaleString()}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="text-destructive hover:text-destructive"
            onClick={() => onDelete(model)}
          >
            <Trash2 className="size-3.5" />
            {t("mentalModels.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function MentalModelsView() {
  const { t } = useTranslation(NS.HINDSIGHT);

  // 数据状态
  const [models, setModels] = useState<MentalModel[]>([]);
  const [loading, setLoading] = useState(true);

  // 搜索状态
  const [search, setSearch] = useState("");

  // 详情弹窗
  const [detailModel, setDetailModel] = useState<MentalModel | null>(null);

  // 删除确认弹窗
  const [deleteTarget, setDeleteTarget] = useState<MentalModel | null>(null);

  /** 加载心理模型列表 */
  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const res = await hindsightApi.listMentalModels();
      setModels(Array.isArray(res.items) ? res.items : []);
    } catch (err) {
      console.error("Failed to load mental models:", err);
      toast.error(err instanceof Error ? err.message : t("mentalModels.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  /** 按搜索关键词过滤 */
  const filteredModels = useMemo(() => {
    if (!search.trim()) return models;
    const q = search.toLowerCase();
    return models.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.content.toLowerCase().includes(q) ||
        m.tags.some((tag) => tag.toLowerCase().includes(q)),
    );
  }, [models, search]);

  /** 删除模型 */
  const handleDelete = async (model: MentalModel) => {
    try {
      await hindsightApi.deleteMentalModel(model.id);
      toast.success(t("mentalModels.delete"));
      // 关闭可能打开的详情弹窗
      if (detailModel?.id === model.id) {
        setDetailModel(null);
      }
      setDeleteTarget(null);
      loadModels();
    } catch (err) {
      console.error("Failed to delete mental model:", err);
      toast.error(err instanceof Error ? err.message : t("mentalModels.deleteFailed"));
    }
  };

  /** 截断内容预览 */
  const truncateContent = (content: string) => {
    if (content.length <= PREVIEW_LENGTH) return content;
    return `${content.slice(0, PREVIEW_LENGTH)}...`;
  };

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* 工具栏：搜索 + 总数 */}
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("mentalModels.search")}
            className="pl-8 h-8"
          />
          {search && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              onClick={() => setSearch("")}
            >
              <X className="size-3.5" />
            </Button>
          )}
        </div>

        <span className="text-xs text-muted-foreground">
          {t("mentalModels.totalCount", { count: filteredModels.length })}
        </span>
      </div>

      {/* 卡片网格 */}
      <div className="flex-1 overflow-auto p-4">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : filteredModels.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted-foreground">
            <Brain className="size-10 mb-3 opacity-40" />
            <p className="text-sm">{t("mentalModels.noModels")}</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filteredModels.map((model) => (
              <Card
                key={model.id}
                className="cursor-pointer hover:shadow-md transition-shadow py-4"
                onClick={() => setDetailModel(model)}
              >
                <CardHeader className="pb-0">
                  <CardTitle className="text-sm flex items-center gap-2">
                    <span className="truncate">{model.name}</span>
                    {model.is_stale && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">
                        {t("mentalModels.stale")}
                      </Badge>
                    )}
                  </CardTitle>
                  <CardAction>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      className="text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDeleteTarget(model);
                      }}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </CardAction>
                </CardHeader>

                <CardContent className="pb-0">
                  {/* 内容预览 */}
                  <p className="text-xs text-muted-foreground line-clamp-3 leading-relaxed">
                    {truncateContent(model.content)}
                  </p>
                </CardContent>

                <CardFooter className="pt-2 flex-col items-start gap-2">
                  {/* 标签 */}
                  {model.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {model.tags.slice(0, 3).map((tag) => (
                        <Badge key={tag} variant="outline" className="text-[10px] px-1.5 py-0">
                          {tag}
                        </Badge>
                      ))}
                      {model.tags.length > 3 && (
                        <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                          +{model.tags.length - 3}
                        </Badge>
                      )}
                    </div>
                  )}

                  {/* 时间 */}
                  {model.last_refreshed_at && (
                    <p className="text-[10px] text-muted-foreground">
                      {t("mentalModels.lastRefreshed")}: {new Date(model.last_refreshed_at).toLocaleDateString()}
                    </p>
                  )}
                </CardFooter>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* 模型详情弹窗 */}
      <ModelDetailDialog
        model={detailModel}
        open={detailModel !== null}
        onOpenChange={(open) => {
          if (!open) setDetailModel(null);
        }}
        onDelete={(model) => {
          setDetailModel(null);
          setDeleteTarget(model);
        }}
      />

      {/* 删除确认弹窗 */}
      <DeleteConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        modelName={deleteTarget?.name ?? ""}
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget);
        }}
      />
    </div>
  );
}
