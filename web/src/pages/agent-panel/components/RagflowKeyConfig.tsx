import { useRequest } from "ahooks";
import { Key, Save, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiResponse } from "@/src/api/request";
import { unwrap } from "@/src/api/request";

interface RagflowKeyConfigProps {
  title: string;
  description: string;
  fetchStatus: () => Promise<{ configured: boolean; prefix: string | null }>;
  saveKey: (key: string) => Promise<ApiResponse<{ ok: true }>>;
  deleteKey: () => Promise<ApiResponse<{ ok: true }>>;
}

export function RagflowKeyConfig({ title, description, fetchStatus, saveKey, deleteKey }: RagflowKeyConfigProps) {
  const { data: status, loading, refresh } = useRequest(fetchStatus);
  const [inputKey, setInputKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleSave = async () => {
    if (!inputKey.trim()) return;
    setSaving(true);
    try {
      await unwrap(saveKey(inputKey.trim()));
      toast.success("RAGFlow API Key 已保存");
      setInputKey("");
      refresh();
    } catch (err) {
      toast.error(`保存失败: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await unwrap(deleteKey());
      toast.success("RAGFlow API Key 已删除");
      refresh();
    } catch (err) {
      toast.error(`删除失败: ${(err as Error).message}`);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-6">
      <div className="flex items-center gap-2">
        <Key className="h-5 w-5 text-muted-foreground" />
        <h3 className="text-lg font-semibold">{title}</h3>
      </div>
      <p className="text-sm text-muted-foreground">{description}</p>

      {loading ? (
        <Skeleton className="h-10 w-full" />
      ) : status?.configured ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2">
            <code className="text-sm">{status.prefix}</code>
            <span className="text-xs text-muted-foreground">(已配置)</span>
          </div>
          <div className="flex gap-2">
            <Input
              placeholder="输入新的 API Key 以替换..."
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value)}
              type="password"
            />
            <Button onClick={handleSave} disabled={saving || !inputKey.trim()} size="sm">
              <Save className="mr-1 h-4 w-4" />
              更新
            </Button>
            <Button variant="destructive" onClick={handleDelete} disabled={deleting} size="sm">
              <Trash2 className="mr-1 h-4 w-4" />
              删除
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-2">
          <Input
            placeholder="粘贴 RAGFlow API Key..."
            value={inputKey}
            onChange={(e) => setInputKey(e.target.value)}
            type="password"
          />
          <Button onClick={handleSave} disabled={saving || !inputKey.trim()}>
            <Save className="mr-1 h-4 w-4" />
            保存
          </Button>
        </div>
      )}
    </div>
  );
}
