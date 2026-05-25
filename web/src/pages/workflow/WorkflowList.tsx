import { AlertTriangle, ChevronRight, Inbox, Loader, Plus, RefreshCw, RotateCcw, Search, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { type WorkflowDefItem, workflowDefApi } from "../../api/workflow-defs";

interface WorkflowListProps {
  onEditWorkflow: (workflowId: string) => void;
  onViewVersions: (workflowId: string) => void;
}

export function WorkflowList({ onEditWorkflow, onViewVersions }: WorkflowListProps) {
  const { t } = useTranslation("workflows");
  const [workflows, setWorkflows] = useState<WorkflowDefItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createDesc, setCreateDesc] = useState("");
  const [creating, setCreating] = useState(false);

  // 恢复相关
  const [recoverableIds, setRecoverableIds] = useState<string[]>([]);
  const [selectedRecoverIds, setSelectedRecoverIds] = useState<Set<string>>(new Set());
  const [showRecoverPanel, setShowRecoverPanel] = useState(false);
  const [recovering, setRecovering] = useState(false);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await workflowDefApi.list();
      setWorkflows(Array.isArray(data) ? data : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  const filtered = workflows.filter((w) => {
    if (searchQuery && !w.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
    return true;
  });

  const handleCreate = useCallback(async () => {
    if (!createName.trim()) return;
    setCreating(true);
    try {
      const wf = await workflowDefApi.create(createName.trim(), createDesc.trim() || undefined);
      setShowCreateDialog(false);
      setCreateName("");
      setCreateDesc("");
      onEditWorkflow(wf.id);
    } catch (err) {
      console.error(err);
      alert(`${t("list.create_error")}: ${(err as Error).message}`);
    } finally {
      setCreating(false);
    }
  }, [createName, createDesc, onEditWorkflow, t]);

  const handleDelete = useCallback(
    async (wf: WorkflowDefItem) => {
      if (!confirm(t("list.delete_confirm", { name: wf.name }))) return;
      try {
        await workflowDefApi.delete(wf.id);
        loadList();
      } catch (err) {
        console.error(err);
        alert(`${t("list.delete_failed")}: ${(err as Error).message}`);
      }
    },
    [loadList, t],
  );

  const handleScanRecover = useCallback(async () => {
    try {
      const ids = await workflowDefApi.recover();
      setRecoverableIds(ids);
      setSelectedRecoverIds(new Set());
      setShowRecoverPanel(true);
    } catch (err) {
      console.error(err);
      alert(`${t("list.scan_failed")}: ${(err as Error).message}`);
    }
  }, [t]);

  const handleRecoverApply = useCallback(async () => {
    if (selectedRecoverIds.size === 0) return;
    setRecovering(true);
    try {
      await workflowDefApi.recoverApply(Array.from(selectedRecoverIds));
      setShowRecoverPanel(false);
      loadList();
    } catch (err) {
      console.error(err);
      alert(`${t("list.recover_failed")}: ${(err as Error).message}`);
    } finally {
      setRecovering(false);
    }
  }, [selectedRecoverIds, loadList, t]);

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return t("list.relative_now");
    if (diff < 3600) return t("list.relative_minutes", { count: Math.floor(diff / 60) });
    if (diff < 86400) return t("list.relative_hours", { count: Math.floor(diff / 3600) });
    return new Date(iso).toLocaleDateString();
  }

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 标题栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>{t("list.title")}</h1>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={handleScanRecover}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 10px",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              background: "#fff",
              fontSize: 12,
              color: "#374151",
              cursor: "pointer",
            }}
          >
            <RotateCcw size={13} /> {t("list.scan_recover")}
          </button>
          <button
            type="button"
            onClick={loadList}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "5px 10px",
              border: "1px solid #e5e7eb",
              borderRadius: 6,
              background: "#fff",
              fontSize: 12,
              color: "#374151",
              cursor: "pointer",
            }}
          >
            <RefreshCw size={13} /> {t("list.refresh")}
          </button>
        </div>
      </div>

      {/* 搜索栏 */}
      <div style={{ display: "flex", gap: 10, marginBottom: 16, alignItems: "center" }}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            maxWidth: 260,
            border: "1px solid #e5e7eb",
            borderRadius: 6,
            padding: "5px 10px",
            background: "#fff",
          }}
        >
          <Search size={13} style={{ color: "#9ca3af", flexShrink: 0 }} />
          <input
            placeholder={t("list.search_placeholder")}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{ border: "none", outline: "none", fontSize: 12, width: "100%", background: "transparent" }}
          />
        </div>
        <button
          type="button"
          onClick={() => setShowCreateDialog(true)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            padding: "6px 12px",
            border: "none",
            borderRadius: 6,
            background: "#3b82f6",
            color: "#fff",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <Plus size={14} /> {t("list.create")}
        </button>
      </div>

      {/* 恢复面板 */}
      {showRecoverPanel && (
        <div
          style={{
            marginBottom: 16,
            padding: 12,
            border: "1px solid #f59e0b",
            borderRadius: 8,
            background: "#fffbeb",
            fontSize: 12,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 8, color: "#92400e" }}>
            {t("list.recoverable_title", { count: recoverableIds.length })}
          </div>
          {recoverableIds.length === 0 ? (
            <p style={{ color: "#9ca3af" }}>{t("list.no_recoverable")}</p>
          ) : (
            <>
              {recoverableIds.map((id) => (
                <label
                  key={id}
                  style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4, cursor: "pointer" }}
                >
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
                  <span style={{ fontFamily: "ui-monospace, monospace", fontSize: 11 }}>{id}</span>
                </label>
              ))}
              <button
                type="button"
                onClick={handleRecoverApply}
                disabled={recovering || selectedRecoverIds.size === 0}
                style={{
                  marginTop: 8,
                  padding: "4px 10px",
                  border: "none",
                  borderRadius: 4,
                  background: "#f59e0b",
                  color: "#fff",
                  fontSize: 11,
                  cursor: recovering ? "not-allowed" : "pointer",
                }}
              >
                {recovering ? t("list.recovering") : t("list.recover_selected", { count: selectedRecoverIds.size })}
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => setShowRecoverPanel(false)}
            style={{
              marginTop: 4,
              background: "none",
              border: "none",
              color: "#92400e",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {t("list.close")}
          </button>
        </div>
      )}

      {/* 新建对话框 */}
      {showCreateDialog && (
        <div
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            background: "rgba(0,0,0,0.3)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
          }}
        >
          <div
            style={{
              background: "#fff",
              borderRadius: 8,
              padding: 24,
              width: 380,
              boxShadow: "0 4px 16px rgba(0,0,0,0.15)",
            }}
          >
            <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>{t("list.create_title")}</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>
                {t("list.name_label")}
              </label>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-workflow"
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  fontSize: 13,
                  outline: "none",
                }}
              />
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>
                {t("list.desc_label")}
              </label>
              <textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder={t("list.desc_placeholder")}
                rows={2}
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  fontSize: 13,
                  outline: "none",
                  resize: "vertical",
                }}
              />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button
                type="button"
                onClick={() => {
                  setShowCreateDialog(false);
                  setCreateName("");
                  setCreateDesc("");
                }}
                style={{
                  padding: "6px 12px",
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  background: "#fff",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                {t("list.cancel")}
              </button>
              <button
                type="button"
                onClick={handleCreate}
                disabled={creating || !createName.trim()}
                style={{
                  padding: "6px 12px",
                  border: "none",
                  borderRadius: 6,
                  background: "#3b82f6",
                  color: "#fff",
                  fontSize: 12,
                  cursor: creating ? "not-allowed" : "pointer",
                }}
              >
                {creating ? t("list.creating") : t("list.create_and_edit")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 13 }}>
          <Loader size={20} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
          <p style={{ marginTop: 8 }}>{t("list.loading")}</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>{t("list.load_failed", { error })}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>
            {searchQuery ? t("list.no_match") : t("list.no_workflows")}
          </p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>{t("list.no_workflows_hint")}</p>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {/* 表头 */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "2fr 100px 120px 80px",
              gap: 8,
              padding: "8px 16px",
              background: "#f9fafb",
              borderBottom: "1px solid #e5e7eb",
              fontSize: 11,
              fontWeight: 600,
              color: "#6b7280",
              textTransform: "uppercase",
              letterSpacing: 0.5,
            }}
          >
            <span>{t("list.table_name")}</span>
            <span>{t("list.table_version")}</span>
            <span>{t("list.table_modified")}</span>
            <span></span>
          </div>

          {/* 数据行 */}
          {filtered.map((wf) => (
            <div
              key={wf.id}
              onClick={() => onEditWorkflow(wf.id)}
              style={{
                display: "grid",
                gridTemplateColumns: "2fr 100px 120px 80px",
                gap: 8,
                padding: "10px 16px",
                borderBottom: "1px solid #f3f4f6",
                cursor: "pointer",
                transition: "background 0.1s",
                fontSize: 12,
                alignItems: "center",
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "")}
            >
              <div>
                <div style={{ fontWeight: 500, color: "#111827" }}>{wf.name}</div>
                {wf.description && <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 1 }}>{wf.description}</div>}
              </div>
              <div style={{ color: wf.latestVersion ? "#22c55e" : "#9ca3af", fontFamily: "ui-monospace, monospace" }}>
                {wf.latestVersion ? `v${wf.latestVersion}` : t("list.not_published")}
              </div>
              <div style={{ color: "#6b7280" }}>{relativeTime(wf.updatedAt)}</div>
              <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  title={t("list.version_history")}
                  onClick={() => onViewVersions(wf.id)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    border: "none",
                    background: "none",
                    borderRadius: 4,
                    color: "#6b7280",
                    cursor: "pointer",
                  }}
                >
                  <ChevronRight size={13} />
                </button>
                <button
                  type="button"
                  title={t("list.delete")}
                  onClick={() => handleDelete(wf)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 26,
                    height: 26,
                    border: "none",
                    background: "none",
                    borderRadius: 4,
                    color: "#ef4444",
                    cursor: "pointer",
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {workflows.length > 0 && (
        <div style={{ marginTop: 12, fontSize: 11, color: "#9ca3af", textAlign: "center" }}>
          {t("list.total_workflows", { count: workflows.length })}
        </div>
      )}
    </div>
  );
}
