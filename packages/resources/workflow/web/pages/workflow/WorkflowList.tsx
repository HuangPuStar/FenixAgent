import { AgentCardList } from "@fenix/ui-components/components/AgentCardList";
import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { Button } from "@fenix/ui-components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@fenix/ui-components/ui/dialog";
import { Input } from "@fenix/ui-components/ui/input";
import { Label } from "@fenix/ui-components/ui/label";
import { Textarea } from "@fenix/ui-components/ui/textarea";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertTriangle, Inbox, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";
import { SkeletonTable } from "./components/SkeletonRows";
import { isUnauthorizedError } from "./utils";

interface WorkflowListProps {
  onEditWorkflow: (workflowId: string) => void;
  onViewVersions: (workflowId: string) => void;
  createRequested?: number;
}

export function WorkflowList({ onEditWorkflow, onViewVersions, createRequested }: WorkflowListProps) {
  const { t } = useTranslation("workflows");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<WorkflowDefItem | null>(null);

  // 恢复相关
  const [recoverableIds, setRecoverableIds] = useState<string[]>([]);
  const [selectedRecoverIds, setSelectedRecoverIds] = useState<Set<string>>(new Set());
  const [showRecoverPanel, setShowRecoverPanel] = useState(false);
  const [searchQuery] = useState("");

  // 加载 workflow 列表
  const { data: workflows = [], loading, error, refresh } = useRequest(() => unwrap(workflowDefApi.list()));
  const workflowsSafe = Array.isArray(workflows) ? workflows : [];
  const errorMsg = error ? (error instanceof Error ? error.message : String(error)) : null;
  const unauthorized = isUnauthorizedError(error);

  // 静默轮询：meta agent 等外部修改后自动刷新列表，不触发 loading 骨架屏
  const pollList = useCallback(async () => {
    try {
      const _data = await unwrap(workflowDefApi.list());
      // 通过 mutate 静默更新数据
      refresh();
    } catch {
      // 轮询失败静默处理，保留上次数据
    }
  }, [refresh]);

  useEffect(() => {
    const timer = setInterval(pollList, 15_000);
    return () => clearInterval(timer);
  }, [pollList]);

  // 响应外部新建请求（createRequested 递增时触发）
  const prevCreateRequestedRef = useRef(createRequested);
  useEffect(() => {
    if (createRequested !== 0 && createRequested !== prevCreateRequestedRef.current) {
      setShowCreateDialog(true);
    }
    prevCreateRequestedRef.current = createRequested;
  }, [createRequested]);

  // 创建 workflow
  const { run: runCreate, loading: creating } = useRequest(
    (name: string, desc: string) => unwrap(workflowDefApi.create(name, desc || undefined)),
    {
      manual: true,
      onSuccess: (wf) => {
        setShowCreateDialog(false);
        setCreateName("");
        setCreateDesc("");
        // 成功后立即跳到编辑器，表单消失本身就是可见反馈；toast 负责把「确实创建成功」说清楚
        // （同页删除/恢复都走 toast.success，三处反馈口径保持一致）。
        toast.success(t("list.create_success"));
        refresh();
        onEditWorkflow(wf.id);
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("list.create_error"), { description: (err as Error).message });
      },
    },
  );

  // 删除 workflow
  const { run: runDelete } = useRequest((id: string) => unwrap(workflowDefApi.delete(id)), {
    manual: true,
    onSuccess: () => {
      toast.success(t("list.delete_success"));
      refresh();
      setDeleteTarget(null);
    },
    onError: (err) => {
      console.error(err);
      toast.error(t("list.delete_failed"), { description: (err as Error).message });
      setDeleteTarget(null);
    },
  });

  // 扫描可恢复的 workflow
  const _handleScanRecover = async () => {
    try {
      const ids = await unwrap(workflowDefApi.recover());
      setRecoverableIds(ids);
      setSelectedRecoverIds(new Set());
      setShowRecoverPanel(true);
    } catch (err) {
      console.error(err);
      toast.error(t("list.scan_failed"), { description: (err as Error).message });
    }
  };

  // 执行恢复
  const { run: runRecoverApply, loading: recovering } = useRequest(
    (ids: string[]) => unwrap(workflowDefApi.recoverApply(ids)),
    {
      manual: true,
      onSuccess: () => {
        toast.success(t("list.recover_success"));
        setShowRecoverPanel(false);
        refresh();
      },
      onError: (err) => {
        console.error(err);
        toast.error(t("list.recover_failed"), { description: (err as Error).message });
      },
    },
  );

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return t("list.relative_now");
    if (diff < 3600) return t("list.relative_minutes", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("list.relative_hours", { count: Math.floor(diff / 86400) });
    return new Date(iso).toLocaleDateString();
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* 恢复面板 */}
      {showRecoverPanel && (
        <div className="mb-4 p-3 border border-warning-border rounded-lg bg-warning-bg text-xs">
          <div className="font-semibold mb-2 text-warning-text">
            {t("list.recoverable_title", { count: recoverableIds.length })}
          </div>
          {recoverableIds.length === 0 ? (
            <p className="text-text-muted">{t("list.no_recoverable")}</p>
          ) : (
            <>
              {recoverableIds.map((id) => (
                <label key={id} className="flex items-center gap-1.5 mb-1 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selectedRecoverIds.has(id)}
                    onChange={(e) => {
                      setSelectedRecoverIds((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(id);
                        else next.delete(id);
                        return next;
                      });
                    }}
                  />
                  <span className="font-mono text-[11px]">{id}</span>
                </label>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => runRecoverApply(Array.from(selectedRecoverIds))}
                disabled={recovering || selectedRecoverIds.size === 0}
              >
                {recovering ? t("list.recovering") : t("list.recover_selected", { count: selectedRecoverIds.size })}
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowRecoverPanel(false)}
            className="mt-1 text-warning-text"
          >
            {t("list.close")}
          </Button>
        </div>
      )}

      {/* 新建对话框 */}
      <Dialog
        open={showCreateDialog}
        onOpenChange={(open) => {
          setShowCreateDialog(open);
          if (!open) {
            setCreateName("");
            setCreateDesc("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("list.create_title")}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-2">
              <Label htmlFor="wf-name">{t("list.name_label")}</Label>
              <Input
                id="wf-name"
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-workflow"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="wf-desc">{t("list.desc_label")}</Label>
              <Textarea
                id="wf-desc"
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder={t("list.desc_placeholder")}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowCreateDialog(false);
                setCreateName("");
                setCreateDesc("");
              }}
            >
              {t("list.cancel")}
            </Button>
            <Button
              size="sm"
              onClick={() => runCreate(createName.trim(), createDesc.trim())}
              disabled={creating || !createName.trim()}
            >
              {creating ? t("list.creating") : t("list.create_and_edit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 内容 */}
      {loading ? (
        // role="status" + aria-busy 让屏幕阅读器知道这里是「正在加载」而不是空列表；
        // aria-label 提供可见文本之外的语义（骨架屏本身没有可读文案）。
        <div role="status" aria-busy="true" aria-label={t("list.loading")}>
          <SkeletonTable cols="2fr 100px 120px 80px" rows={4} />
        </div>
      ) : error ? (
        // 失败必须是**持久**分支：只弹 toast 会落回「暂无工作流」空态，用户看到的是「没有数据」
        // 而不是「没取到数据」。无权限单独成一个分支且不给重试（原因见 isUnauthorizedError）。
        unauthorized ? (
          <div className="text-center py-10" role="alert">
            <ShieldAlert size={32} className="text-status-error mx-auto mb-2" />
            <p className="text-[13px] text-text-secondary font-medium">{t("list.unauthorized_title")}</p>
            <p className="text-[11px] text-text-dim mt-1">{t("list.unauthorized_hint")}</p>
          </div>
        ) : (
          <div className="text-center py-10" role="alert">
            <AlertTriangle size={32} className="text-status-error mx-auto mb-2" />
            <p className="text-[13px] text-text-secondary">{t("list.load_failed", { error: errorMsg })}</p>
            {/* 重试入口：轮询是静默的，用户手里必须有一个能主动重发的按钮，否则只能刷新整页 */}
            <Button variant="outline" size="sm" className="mt-3" onClick={refresh}>
              <RefreshCw size={13} className="mr-1" /> {t("list.retry")}
            </Button>
          </div>
        )
      ) : workflowsSafe.length === 0 ? (
        <div className="text-center py-10">
          <Inbox size={32} className="text-text-muted mx-auto mb-2" />
          <p className="text-[13px] text-text-muted font-medium">{t("list.no_workflows")}</p>
          <p className="text-[11px] text-text-dim mt-1">{t("list.no_workflows_hint")}</p>
        </div>
      ) : (
        <AgentCardList
          items={workflowsSafe}
          cardKey={(wf) => wf.id}
          searchPlaceholder={t("list.search_placeholder")}
          searchFn={(wf, query) => wf.name.toLowerCase().includes(query)}
          emptyMessage={searchQuery ? t("list.no_match") : t("list.no_workflows")}
          renderCard={(wf) => (
            <div className="group rounded-lg border border-border-light bg-surface-1 px-4 py-3 transition-colors hover:border-border-active hover:shadow-sm">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-text-bright">{wf.name}</span>
                    <span
                      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        wf.latestVersion
                          ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
                          : "bg-surface-2 text-text-muted"
                      }`}
                    >
                      {wf.latestVersion ? `v${wf.latestVersion}` : t("list.not_published")}
                    </span>
                  </div>
                  {wf.description && <div className="text-xs text-text-muted mt-1 truncate">{wf.description}</div>}
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-text-dim">
                    <span>
                      {t("list.table_modified")}: {relativeTime(wf.updatedAt)}
                    </span>
                  </div>
                </div>
                <div className="flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                  <Button size="xs" variant="outline" onClick={() => onEditWorkflow(wf.id)}>
                    {t("list.edit")}
                  </Button>
                  <Button size="xs" variant="outline" onClick={() => onViewVersions(wf.id)}>
                    {t("list.version_history")}
                  </Button>
                  {/* 纯图标按钮：可访问名只能由 aria-label 提供，否则读屏只播报「按钮」 */}
                  <Button
                    size="xs"
                    variant="destructive"
                    aria-label={t("list.delete")}
                    onClick={() => setDeleteTarget(wf)}
                  >
                    <Trash2 size={12} />
                  </Button>
                </div>
              </div>
            </div>
          )}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        title={t("list.delete")}
        description={t("list.delete_confirm", { name: deleteTarget?.name ?? "" })}
        variant="destructive"
        onConfirm={() => deleteTarget && runDelete(deleteTarget.id)}
      />
    </div>
  );
}
