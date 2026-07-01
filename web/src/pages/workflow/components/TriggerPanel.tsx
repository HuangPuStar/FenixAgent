import { Copy, Globe, Inbox, Loader, Power, RefreshCw, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { unwrap } from "@/src/api/request";
import { type TriggerItem, workflowDefApi } from "../../../api/workflow-defs";

export function TriggerPanel({ workflowId, onClose }: { workflowId?: string; onClose: () => void }) {
  const [triggers, setTriggers] = useState<TriggerItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { t } = useTranslation("workflows");

  const loadData = useCallback(async () => {
    if (!workflowId) return;
    setLoading(true);
    try {
      const list = await unwrap(workflowDefApi.listTriggers(workflowId));
      setTriggers(Array.isArray(list) ? list : []);
    } catch (err) {
      console.error(err);
      toast.error(t("editor.trigger_load_failed"));
    } finally {
      setLoading(false);
    }
  }, [workflowId, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleCreate = useCallback(async () => {
    if (!workflowId) return;
    setCreating(true);
    try {
      await workflowDefApi.createTrigger(workflowId);
      toast.success(t("editor.trigger_created"));
      loadData();
    } catch (err) {
      console.error(err);
      toast.error(`${t("editor.trigger_create_failed")}: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }, [workflowId, loadData, t]);

  const handleDelete = useCallback(
    async (triggerId: string) => {
      if (!confirm(t("editor.trigger_delete_confirm"))) return;
      try {
        await workflowDefApi.deleteTrigger(triggerId);
        toast.success(t("editor.trigger_deleted"));
        loadData();
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.trigger_delete_failed")}: ${(err as Error).message}`);
      }
    },
    [loadData, t],
  );

  const handleRegenerate = useCallback(
    async (triggerId: string) => {
      if (!confirm(t("editor.trigger_regenerate_confirm"))) return;
      try {
        const updated = await unwrap(workflowDefApi.regenerateTriggerHash(triggerId));
        toast.success(t("editor.trigger_hash_regenerated"));
        setTriggers((prev) => prev.map((tr) => (tr.id === triggerId ? updated : tr)));
      } catch (err) {
        console.error(err);
        toast.error(`${t("editor.trigger_regenerate_failed")}: ${(err as Error).message}`);
      }
    },
    [t],
  );

  const handleToggle = useCallback(
    async (trigger: TriggerItem) => {
      try {
        if (trigger.enabled) {
          await workflowDefApi.disableTrigger(trigger.id);
          toast.success(t("editor.trigger_disabled_ok"));
        } else {
          await workflowDefApi.enableTrigger(trigger.id);
          toast.success(t("editor.trigger_enabled_ok"));
        }
        loadData();
      } catch (err) {
        console.error(err);
      }
    },
    [loadData, t],
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
      } catch {
        // clipboard fallback
      }
    },
    [t],
  );

  return (
    <>
      {/* Header */}
      <div
        className="wf-prop-header"
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}
      >
        <span className="wf-prop-title">
          <Globe size={13} style={{ marginRight: 4, verticalAlign: -1 }} />
          {t("editor.trigger_title")}
        </span>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 24,
            height: 24,
            border: "none",
            background: "#f3f4f6",
            borderRadius: 4,
            color: "#6b7280",
            cursor: "pointer",
          }}
        >
          <X size={11} />
        </button>
      </div>

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
            <Loader size={16} style={{ animation: "wf-spin 1s linear infinite", display: "inline-block" }} />
          </div>
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
                  onClick={() => handleRegenerate(trigger.id)}
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
                  onClick={() => handleDelete(trigger.id)}
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
    </>
  );
}
