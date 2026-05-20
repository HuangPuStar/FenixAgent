import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Inbox, Loader, RefreshCw, RotateCcw, Star, Clock } from "lucide-react";
import { workflowDefApi, type WorkflowVersionItem, type WorkflowDefItem } from "../../api/workflow-defs";

interface WorkflowVersionsProps {
  workflowId: string;
  onEditWorkflow: (workflowId: string) => void;
}

export function WorkflowVersions({ workflowId }: WorkflowVersionsProps) {
  const [wf, setWf] = useState<WorkflowDefItem | null>(null);
  const [versions, setVersions] = useState<WorkflowVersionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewingVersion, setViewingVersion] = useState<number | null>(null);
  const [viewingYaml, setViewingYaml] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [wfData, versionList] = await Promise.all([
        workflowDefApi.get(workflowId),
        workflowDefApi.getVersions(workflowId),
      ]);
      setWf(wfData);
      setVersions(Array.isArray(versionList) ? versionList : []);
    } catch (err) {
      console.error(err);
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workflowId]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSetLatest = useCallback(
    async (version: number) => {
      if (!confirm(`确定将 latest 指向 v${version}？`)) return;
      try {
        await workflowDefApi.setLatest(workflowId, version);
        loadData();
      } catch (err) {
        console.error(err);
        alert("操作失败: " + (err as Error).message);
      }
    },
    [workflowId, loadData],
  );

  const handleRestoreToDraft = useCallback(
    async (version: number) => {
      if (!confirm(`将 v${version} 的内容恢复到草稿？当前草稿将被覆盖。`)) return;
      try {
        await workflowDefApi.restoreToDraft(workflowId, version);
        alert("已恢复到草稿");
      } catch (err) {
        console.error(err);
        alert("恢复失败: " + (err as Error).message);
      }
    },
    [workflowId],
  );

  const handleViewYaml = useCallback(
    async (version: number) => {
      if (viewingVersion === version) {
        setViewingVersion(null);
        setViewingYaml(null);
        return;
      }
      try {
        const result = await workflowDefApi.getVersion(workflowId, version);
        setViewingVersion(version);
        setViewingYaml(result.yaml);
      } catch (err) {
        console.error(err);
        alert("加载失败: " + (err as Error).message);
      }
    },
    [workflowId, viewingVersion],
  );

  function relativeTime(iso?: string | null): string {
    if (!iso) return "--";
    const diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "刚刚";
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(iso).toLocaleDateString("zh-CN");
  }

  return (
    <div style={{ padding: "24px 32px", height: "100%", overflowY: "auto" }}>
      {/* 标题 */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "#111827", margin: 0 }}>
          版本历史{wf ? ` — ${wf.name}` : ""}
        </h1>
        <button
          type="button"
          onClick={loadData}
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

      {/* 当前状态 */}
      {wf && (
        <div
          style={{
            padding: "10px 16px",
            background: "#f9fafb",
            borderRadius: 8,
            border: "1px solid #e5e7eb",
            marginBottom: 16,
            fontSize: 12,
            color: "#6b7280",
            display: "flex",
            gap: 16,
          }}
        >
          <span>
            latest:{" "}
            <strong style={{ color: wf.latestVersion ? "#22c55e" : "#9ca3af" }}>
              {wf.latestVersion ? `v${wf.latestVersion}` : "未设置"}
            </strong>
          </span>
          <span>
            发布版本数: <strong>{versions.length}</strong>
          </span>
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
      ) : versions.length === 0 ? (
        <div style={{ textAlign: "center", padding: 40 }}>
          <Inbox size={32} style={{ color: "#d1d5db", margin: "0 auto 8px" }} />
          <p style={{ fontSize: 13, color: "#9ca3af", fontWeight: 500 }}>暂无发布版本</p>
          <p style={{ fontSize: 11, color: "#d1d5db", marginTop: 4 }}>在编辑器中点击「发布」创建第一个版本</p>
        </div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, overflow: "hidden", background: "#fff" }}>
          {versions.map((v) => {
            const isLatest = wf?.latestVersion === v.version;
            const isViewing = viewingVersion === v.version;

            return (
              <div key={v.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "12px 16px",
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                  onClick={() => handleViewYaml(v.version)}
                >
                  {/* 版本号 */}
                  <div
                    style={{
                      fontFamily: "ui-monospace, monospace",
                      fontWeight: 600,
                      color: "#111827",
                      minWidth: 40,
                    }}
                  >
                    v{v.version}
                  </div>

                  {/* latest 标记 */}
                  {isLatest && (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 3,
                        fontSize: 10,
                        fontWeight: 500,
                        color: "#22c55e",
                        background: "#f0fdf4",
                        padding: "1px 6px",
                        borderRadius: 99,
                      }}
                    >
                      <Star size={10} /> latest
                    </span>
                  )}

                  {/* 时间 */}
                  <span style={{ color: "#9ca3af", fontSize: 11 }}>
                    <Clock size={10} style={{ marginRight: 3, verticalAlign: -1 }} />
                    {relativeTime(v.createdAt)}
                  </span>

                  {/* 操作 */}
                  <div style={{ marginLeft: "auto", display: "flex", gap: 4 }} onClick={(e) => e.stopPropagation()}>
                    {!isLatest && (
                      <button
                        type="button"
                        title="设为 latest"
                        onClick={() => handleSetLatest(v.version)}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: 3,
                          padding: "3px 8px",
                          border: "1px solid #e5e7eb",
                          borderRadius: 4,
                          background: "#fff",
                          fontSize: 10,
                          color: "#6b7280",
                          cursor: "pointer",
                        }}
                      >
                        <Star size={10} /> 设为 latest
                      </button>
                    )}
                    <button
                      type="button"
                      title="恢复到草稿"
                      onClick={() => handleRestoreToDraft(v.version)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 3,
                        padding: "3px 8px",
                        border: "1px solid #e5e7eb",
                        borderRadius: 4,
                        background: "#fff",
                        fontSize: 10,
                        color: "#6b7280",
                        cursor: "pointer",
                      }}
                    >
                      <RotateCcw size={10} /> 恢复到草稿
                    </button>
                  </div>
                </div>

                {/* YAML 展开区域 */}
                {isViewing && viewingYaml !== null && (
                  <div style={{ padding: "0 16px 12px" }}>
                    <pre
                      style={{
                        background: "#f9fafb",
                        border: "1px solid #e5e7eb",
                        borderRadius: 6,
                        padding: 10,
                        fontSize: 11,
                        fontFamily: "ui-monospace, monospace",
                        color: "#374151",
                        maxHeight: 300,
                        overflow: "auto",
                        margin: 0,
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {viewingYaml}
                    </pre>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
