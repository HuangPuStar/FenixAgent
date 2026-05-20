import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Inbox, Loader, Plus, RefreshCw, Search, Trash2, RotateCcw, ChevronRight } from "lucide-react";
import { workflowDefApi, type WorkflowDefItem } from "../../api/workflow-defs";

interface WorkflowListProps {
  onEditWorkflow: (workflowId: string) => void;
  onViewVersions: (workflowId: string) => void;
}

export function WorkflowList({ onEditWorkflow, onViewVersions }: WorkflowListProps) {
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
      alert("创建失败: " + (err as Error).message);
    } finally {
      setCreating(false);
    }
  }, [createName, createDesc, onEditWorkflow]);

  const handleDelete = useCallback(
    async (wf: WorkflowDefItem) => {
      if (!confirm(`确定要删除「${wf.name}」吗？数据库记录将被删除，但文件系统保留。`)) return;
      try {
        await workflowDefApi.delete(wf.id);
        loadList();
      } catch (err) {
        console.error(err);
        alert("删除失败: " + (err as Error).message);
      }
    },
    [loadList],
  );

  const handleScanRecover = useCallback(async () => {
    try {
      const ids = await workflowDefApi.recover();
      setRecoverableIds(ids);
      setSelectedRecoverIds(new Set());
      setShowRecoverPanel(true);
    } catch (err) {
      console.error(err);
      alert("扫描失败: " + (err as Error).message);
    }
  }, []);

  const handleRecoverApply = useCallback(async () => {
    if (selectedRecoverIds.size === 0) return;
    setRecovering(true);
    try {
      await workflowDefApi.recoverApply(Array.from(selectedRecoverIds));
      setShowRecoverPanel(false);
      loadList();
    } catch (err) {
      console.error(err);
      alert("恢复失败: " + (err as Error).message);
    } finally {
      setRecovering(false);
    }
  }, [selectedRecoverIds, loadList]);

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    return new Date(iso).toLocaleDateString("zh-CN");
  }

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 标题栏 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>工作流</h1>
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
            <RotateCcw size={13} /> 扫描恢复
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
            <RefreshCw size={13} /> 刷新
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
            placeholder="搜索工作流名称..."
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
          <Plus size={14} /> 新建工作流
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
            可恢复的工作流（{recoverableIds.length} 个）
          </div>
          {recoverableIds.length === 0 ? (
            <p style={{ color: "#9ca3af" }}>没有找到可恢复的工作流。</p>
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
                {recovering ? "恢复中..." : `恢复选中 (${selectedRecoverIds.size})`}
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
            关闭
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
            <h3 style={{ margin: "0 0 16px", fontSize: 15, fontWeight: 600 }}>新建工作流</h3>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>名称 *</label>
              <input
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
                placeholder="my-workflow"
                autoFocus
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
              <label style={{ display: "block", fontSize: 12, color: "#374151", marginBottom: 4 }}>描述</label>
              <textarea
                value={createDesc}
                onChange={(e) => setCreateDesc(e.target.value)}
                placeholder="工作流描述（可选）"
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
                取消
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
                {creating ? "创建中..." : "创建并编辑"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 内容 */}
      {loading ? (
        <div style={{ textAlign: "center", padding: 40, color: "#9ca3af", fontSize: 13 }}>
          <Loader size={20} style={{ animation: "spin 1s linear infinite", display: "inline-block" }} />
          <p style={{ marginTop: 8 }}>加载中...</p>
        </div>
      ) : error ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <AlertTriangle size={32} style={{ color: "#ef4444", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#6b7280" }}>加载失败: {error}</p>
        </div>
      ) : filtered.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>
            {searchQuery ? "没有匹配的工作流" : "暂无工作流"}
          </p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>点击「新建工作流」创建你的第一个工作流</p>
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
            <span>名称</span>
            <span>最新版本</span>
            <span>最后修改</span>
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
                {wf.latestVersion ? `v${wf.latestVersion}` : "未发布"}
              </div>
              <div style={{ color: "#6b7280" }}>{relativeTime(wf.updatedAt)}</div>
              <div style={{ display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                <button
                  type="button"
                  title="版本历史"
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
                  title="删除"
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
          共 {workflows.length} 个工作流
        </div>
      )}
    </div>
  );
}
