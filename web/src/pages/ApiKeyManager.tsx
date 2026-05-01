import { useState, useEffect, useCallback } from "react";
import { apiFetchApiKeys, apiCreateApiKey, apiDeleteApiKey, apiUpdateApiKeyLabel } from "../api/client";
import { ConfirmDialog } from "@/components/config/ConfirmDialog";

interface ApiKeyInfo {
  id: string;
  label: string;
  keyPrefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}

interface ApiKeyManagerProps {
  onBack: () => void;
}

export function ApiKeyManager({ onBack }: ApiKeyManagerProps) {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState("");
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [error, setError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const loadKeys = useCallback(async () => {
    try {
      const data = await apiFetchApiKeys();
      setKeys(data);
    } catch (err) {
      setError("加载 API Key 失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  const handleCreate = async () => {
    setError("");
    try {
      const result = await apiCreateApiKey(newLabel);
      setCreatedKey(result.full_key);
      setNewLabel("");
      await loadKeys();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建 Key 失败");
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiDeleteApiKey(id);
      await loadKeys();
    } catch {
      setError("删除 Key 失败");
    }
  };

  const handleUpdateLabel = async (id: string) => {
    try {
      await apiUpdateApiKeyLabel(id, editLabel);
      setEditingId(null);
      await loadKeys();
    } catch {
      setError("更新标签失败");
    }
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-text-muted">
        加载中...
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 py-6">
        <div className="mb-6 flex items-center gap-3">
          <button onClick={onBack} className="text-text-muted hover:text-text-primary text-sm">
            &larr; 返回
          </button>
          <h1 className="text-lg font-semibold text-text-primary">API Key</h1>
        </div>

        {error && (
          <div className="mb-4 rounded-md bg-destructive/10 px-4 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {createdKey && (
          <div className="mb-4 rounded-md border border-status-active/30 bg-status-active/5 px-4 py-3">
            <p className="text-sm font-medium text-status-active">API Key 已创建</p>
            <p className="mt-1 text-xs text-text-muted">
              请立即复制此 Key，之后将无法再查看。
            </p>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded bg-surface-0 px-3 py-2 text-xs font-mono break-all">
                {createdKey}
              </code>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(createdKey);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                }}
                className={copied
                  ? "shrink-0 rounded-md bg-status-active/15 px-3 py-2 text-xs font-medium text-status-active"
                  : "shrink-0 rounded-md bg-surface-2 px-3 py-2 text-xs font-medium text-text-secondary hover:bg-surface-3"
                }
              >
                {copied ? "已复制!" : "复制"}
              </button>
            </div>
            <button
              onClick={() => { setCreatedKey(null); setCopied(false); }}
              className="mt-2 text-xs text-text-muted hover:text-text-primary"
            >
              关闭
            </button>
          </div>
        )}

        {/* Create new key */}
        <div className="mb-6 rounded-lg border border-border bg-surface-1 p-4">
          <h2 className="mb-3 text-sm font-medium text-text-primary">创建新 Key</h2>
          <div className="flex gap-2">
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="标签（可选）"
              className="flex-1 rounded-md border border-border bg-surface-0 px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:border-brand focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <button
              onClick={handleCreate}
              className="rounded-md bg-brand px-4 py-2 text-sm font-medium text-white hover:bg-brand/90"
            >
              创建
            </button>
          </div>
        </div>

        {/* Key list */}
        <div className="space-y-2">
          {keys.length === 0 && (
            <p className="text-center text-sm text-text-muted py-8">
              暂无 API Key。请在上方创建一个以连接你的 Agent。
            </p>
          )}
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface-1 px-4 py-3"
            >
              <div className="flex-1 min-w-0">
                {editingId === key.id ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="flex-1 rounded border border-border bg-surface-0 px-2 py-1 text-sm text-text-primary"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleUpdateLabel(key.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      autoFocus
                    />
                    <button
                      onClick={() => handleUpdateLabel(key.id)}
                      className="text-xs text-brand hover:underline"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      className="text-xs text-text-muted hover:underline"
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-sm font-medium text-text-primary truncate">
                      {key.label || "未命名"}
                    </p>
                    <p className="text-xs text-text-muted font-mono">{key.keyPrefix}</p>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {editingId !== key.id && (
                  <>
                    <button
                      onClick={() => { setEditingId(key.id); setEditLabel(key.label); }}
                      className="text-xs text-text-muted hover:text-text-primary"
                    >
                      编辑
                    </button>
                    <button
                      onClick={() => setDeleteTarget(key.id)}
                      className="text-xs text-status-error hover:underline"
                    >
                      删除
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="确认删除"
        description="确定要删除此 API Key 吗？使用该 Key 的 Agent 将无法继续连接。此操作不可撤销。"
        variant="destructive"
        onConfirm={() => { if (deleteTarget) handleDelete(deleteTarget); }}
      />
    </div>
  );
}
