import { ConfirmDialog } from "@fenix/ui-components/config/ConfirmDialog";
import { EmptyState } from "@fenix/ui-components/config/EmptyState";
import { unwrap } from "@fenix/web-runtime/api/request";
import { useRequest } from "ahooks";
import { AlertTriangle, Copy, Globe, Inbox, Power, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type TriggerItem, workflowDefApi } from "../../../api/workflow-defs";
import { InlineLoader } from "./InlineLoader";
import { PanelHeader } from "./PanelHeader";

export function TriggerPanel({ workflowId, onClose }: { workflowId?: string; onClose: () => void }) {
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // 待确认的目标触发器 id：原生 confirm 的同步返回值无法保留，改成「先挂起目标、由 ConfirmDialog 回调再执行」。
  // 删除与重新生成是两个语义不同的动作，各自独立一份状态（不合并，否则关闭动画期间标题/描述会串成另一动作的文案）。
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null);
  const [regenerateTargetId, setRegenerateTargetId] = useState<string | null>(null);
  const { t } = useTranslation("workflows");

  // 在途请求的取消句柄（§3.4）：后发请求取消先发，卸载时释放连接。
  // 取消用 `signal` 而不是「请求序号令牌」——令牌只能丢弃结果，连接仍在服务端跑完。
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  /**
   * 触发器列表取数（§3.4）：三态由 `data` / `loading` / `error` 派生，不再手写
   * `useCallback` + `useEffect` + `setState`；重试与增删改后的重查统一走 `refresh`。
   *
   * `ready: !!workflowId` 表达条件请求；`refreshDeps: [workflowId]` 让换工作流时重查。
   * 语义差异已记账：旧实现在 `!workflowId` 时提前 return，`loading` 初始化成 `true` 后无人复位，
   * 面板会永久停在 spinner；新实现不发请求、落空态。
   */
  const {
    data: triggers = [],
    loading,
    error,
    refresh: reloadTriggers,
    mutate: mutateTriggers,
  } = useRequest(
    async () => {
      if (!workflowId) return [];
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const list = await unwrap(workflowDefApi.listTriggers(workflowId, { signal: controller.signal }));
      return Array.isArray(list) ? list : [];
    },
    {
      ready: !!workflowId,
      refreshDeps: [workflowId],
      onError: (err) => {
        console.error(err);
        // 失败同时给持久失败块（下方 `role="alert"`）与 toast：前者可重试，后者在面板滚出视口时仍可见
        toast.error(t("editor.trigger_load_failed"));
      },
    },
  );
  // 失败态独立成支：列表在失败时为 `[]`，不给分支就会渲染成「暂无 Webhook 触发器」——
  // 把取数失败伪装成空数据（§3.4 禁止）。
  const triggerError = error ? (error instanceof Error ? error.message : String(error)) : null;

  const handleCreate = useCallback(async () => {
    if (!workflowId) return;
    setCreating(true);
    try {
      await unwrap(workflowDefApi.createTrigger(workflowId));
      toast.success(t("editor.trigger_created"));
      reloadTriggers();
    } catch (err) {
      console.error(err);
      toast.error(`${t("editor.trigger_create_failed")}: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }, [workflowId, reloadTriggers, t]);

  const runDelete = useCallback(
    async (triggerId: string) => {
      if (!workflowId) return;
      try {
        await unwrap(workflowDefApi.deleteTrigger(workflowId, triggerId));
        toast.success(t("editor.trigger_deleted"));
        reloadTriggers();
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.trigger_delete_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, reloadTriggers, t],
  );

  const runRegenerate = useCallback(
    async (triggerId: string) => {
      if (!workflowId) return;
      try {
        const updated = await unwrap(workflowDefApi.regenerateTriggerHash(workflowId, triggerId));
        toast.success(t("editor.trigger_hash_regenerated"));
        // 就地替换该项（改造前是 `setTriggers(prev => prev.map(...))`）：只有一行的 URL 变了，
        // 没必要为它重取整张表；`mutate` 是 `useRequest` 提供的本地数据写入口。
        mutateTriggers((prev) => (prev ?? []).map((tr) => (tr.id === triggerId ? updated : tr)));
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.trigger_regenerate_failed")}: ${(err as Error).message}`);
      }
    },
    [workflowId, mutateTriggers, t],
  );

  // 点击只挂起目标，由 ConfirmDialog 确认后才调用上面的执行函数。
  // `!workflowId` 守卫从原先「缺 id 或用户未确认就直接返回」的写法平移到这里：缺 id 时不进入确认流程。
  const requestDelete = useCallback(
    (triggerId: string) => {
      if (!workflowId) return;
      setDeleteTargetId(triggerId);
    },
    [workflowId],
  );

  const requestRegenerate = useCallback(
    (triggerId: string) => {
      if (!workflowId) return;
      setRegenerateTargetId(triggerId);
    },
    [workflowId],
  );

  const handleToggle = useCallback(
    async (trigger: TriggerItem) => {
      if (!workflowId) return;
      try {
        if (trigger.enabled) {
          await unwrap(workflowDefApi.disableTrigger(workflowId, trigger.id));
          toast.success(t("editor.trigger_disabled_ok"));
        } else {
          await unwrap(workflowDefApi.enableTrigger(workflowId, trigger.id));
          toast.success(t("editor.trigger_enabled_ok"));
        }
        reloadTriggers();
      } catch (err) {
        console.error(err);
        toast.error(t("editor.trigger_toggle_failed"));
      }
    },
    [workflowId, reloadTriggers, t],
  );

  const handleCopy = useCallback(
    async (trigger: TriggerItem) => {
      const url = trigger.webhookUrl;
      if (!url) return;
      try {
        await navigator.clipboard.writeText(url);
        setCopiedId(trigger.id);
        toast.success(t("editor.trigger_copied"));
        setTimeout(() => setCopiedId(null), 2000);
      } catch (err) {
        // 剪贴板写入会被权限策略拒绝（非安全上下文 / 用户未授权），原实现是空 catch
        // 加一句"clipboard fallback"注释——既没有 fallback，也没有诊断与反馈，
        // 用户点「复制」后按钮毫无反应。这里补诊断与提示。
        console.error("[TriggerPanel] 复制 Webhook URL 失败", err);
        toast.error(t("editor.trigger_copy_failed"));
      }
    },
    [t],
  );

  // 面板头三处合一（见 ./PanelHeader）：本面板是唯一带标题图标（Globe）的消费方；
  // 原关闭按钮**没有任何可访问名**——读屏只会播报「按钮」，本批新增 `editor.trigger_panel_close` 补齐。
  return (
    <>
      {/* Panel header: the only consumer with a title icon, plus its own close accessible name. */}
      <PanelHeader
        title={t("editor.trigger_title")}
        icon={<Globe size={13} />}
        closeLabel={t("editor.trigger_panel_close")}
        onClose={onClose}
      />

      {/* Create button */}
      {workflowId && (
        <div style={{ padding: "8px 12px", borderBottom: "1px solid #f3f4f6" }}>
          <button
            type="button"
            onClick={handleCreate}
            disabled={creating}
            style={{
              width: "100%",
              padding: "7px 0",
              border: "none",
              borderRadius: 6,
              background: creating ? "#d1d5db" : "#3b82f6",
              color: "#fff",
              fontSize: 12,
              fontWeight: 600,
              cursor: creating ? "not-allowed" : "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 5,
            }}
          >
            <Globe size={13} />
            {creating ? t("editor.trigger_creating") : t("editor.trigger_create")}
          </button>
        </div>
      )}

      {/* Trigger list */}
      <div style={{ flex: 1, overflowY: "auto" }}>
        {loading ? (
          <div style={{ textAlign: "center", padding: 24, color: "#9ca3af", fontSize: 11 }}>
            <InlineLoader />
          </div>
        ) : triggerError ? (
          // 失败是持久分支（`role="alert"` + 重试）：只弹 toast 会落回下面的「暂无触发器」空态，
          // 用户看到的是「没有触发器」而不是「没取到触发器」。
          <EmptyState
            tone="danger"
            role="alert"
            className="px-3 py-6"
            icon={<AlertTriangle />}
            title={t("editor.trigger_load_failed")}
            description={triggerError}
            action={{ label: t("editor.trigger_retry"), onClick: reloadTriggers, icon: <RefreshCw /> }}
          />
        ) : triggers.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24, color: "#d1d5db", fontSize: 11 }}>
            <Inbox size={24} style={{ margin: "0 auto 4px" }} />
            <p>{t("editor.trigger_empty")}</p>
            <p style={{ fontSize: 9, marginTop: 2 }}>{t("editor.trigger_empty_hint")}</p>
          </div>
        ) : (
          triggers.map((trigger) => (
            <div key={trigger.id} style={{ borderBottom: "1px solid #f3f4f6", padding: "8px 12px" }}>
              {/* Type + Status */}
              <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span
                  style={{
                    fontSize: 9,
                    fontWeight: 500,
                    padding: "1px 5px",
                    borderRadius: 99,
                    background: trigger.enabled ? "#f0fdf4" : "#fef2f2",
                    color: trigger.enabled ? "#166534" : "#991b1b",
                  }}
                >
                  {trigger.enabled ? t("editor.trigger_enabled") : t("editor.trigger_disabled")}
                </span>
                <span style={{ fontSize: 9, color: "#9ca3af" }}>{t("editor.trigger_type_webhook")}</span>
              </div>

              {/* Webhook URL */}
              {trigger.webhookUrl && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>{t("editor.trigger_url_label")}</div>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      background: "#f9fafb",
                      border: "1px solid #e5e7eb",
                      borderRadius: 4,
                      padding: "4px 8px",
                      fontSize: 9,
                      fontFamily: "ui-monospace, monospace",
                      color: "#374151",
                      wordBreak: "break-all",
                    }}
                  >
                    <span style={{ flex: 1 }}>{trigger.webhookUrl}</span>
                    <button
                      type="button"
                      onClick={() => handleCopy(trigger)}
                      // 纯图标按钮：可访问名只能由 aria-label 提供（Webhook URL 已由上一行标签承载）
                      aria-label={t("editor.trigger_copy")}
                      style={{
                        border: "none",
                        background: "none",
                        cursor: "pointer",
                        color: copiedId === trigger.id ? "#22c55e" : "#6b7280",
                        padding: 2,
                        display: "flex",
                        flexShrink: 0,
                      }}
                    >
                      <Copy size={11} />
                    </button>
                  </div>
                </div>
              )}

              {/* Masked hash (for listed triggers without full URL) */}
              {!trigger.webhookUrl && (
                <div style={{ marginBottom: 6 }}>
                  <div style={{ fontSize: 9, color: "#6b7280", marginBottom: 2 }}>{t("editor.trigger_url_label")}</div>
                  <div
                    style={{
                      background: "#f9fafb",
                      border: "1px solid #e5e7eb",
                      borderRadius: 4,
                      padding: "4px 8px",
                      fontSize: 9,
                      fontFamily: "ui-monospace, monospace",
                      color: "#9ca3af",
                    }}
                  >
                    {trigger.maskedHash || trigger.publicHash}
                  </div>
                </div>
              )}

              {/* Actions */}
              <div style={{ display: "flex", gap: 3 }}>
                <button
                  type="button"
                  onClick={() => handleToggle(trigger)}
                  style={{
                    padding: "2px 6px",
                    border: "1px solid #e5e7eb",
                    borderRadius: 3,
                    background: "#fff",
                    color: "#6b7280",
                    fontSize: 9,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <Power size={9} />
                  {trigger.enabled ? t("editor.trigger_disabled") : t("editor.trigger_enabled")}
                </button>
                <button
                  type="button"
                  onClick={() => requestRegenerate(trigger.id)}
                  style={{
                    padding: "2px 6px",
                    border: "1px solid #e5e7eb",
                    borderRadius: 3,
                    background: "#fff",
                    color: "#6b7280",
                    fontSize: 9,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <RefreshCw size={9} />
                  {t("editor.trigger_regenerate")}
                </button>
                <button
                  type="button"
                  onClick={() => requestDelete(trigger.id)}
                  style={{
                    padding: "2px 6px",
                    border: "1px solid #fecaca",
                    borderRadius: 3,
                    background: "#fff",
                    color: "#dc2626",
                    fontSize: 9,
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                  }}
                >
                  <Trash2 size={9} />
                  {t("editor.trigger_delete")}
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Delete trigger confirmation */}
      <ConfirmDialog
        open={deleteTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTargetId(null);
        }}
        title={t("editor.trigger_delete_title")}
        description={t("editor.trigger_delete_confirm")}
        variant="destructive"
        onConfirm={() => {
          const triggerId = deleteTargetId;
          setDeleteTargetId(null);
          if (triggerId) runDelete(triggerId);
        }}
      />

      {/* Regenerate trigger hash confirmation */}
      <ConfirmDialog
        open={regenerateTargetId !== null}
        onOpenChange={(open) => {
          if (!open) setRegenerateTargetId(null);
        }}
        title={t("editor.trigger_regenerate_title")}
        description={t("editor.trigger_regenerate_confirm")}
        onConfirm={() => {
          const triggerId = regenerateTargetId;
          setRegenerateTargetId(null);
          if (triggerId) runRegenerate(triggerId);
        }}
      />
    </>
  );
}
