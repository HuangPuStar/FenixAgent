import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { apiListChannelProviders, apiListChannels } from "../api/client";
import type { ChannelInfo, ChannelProviderInfo } from "../types";
import { DataTable, type Column } from "@/components/config/DataTable";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

export function ChannelsPage() {
  const [providers, setProviders] = useState<ChannelProviderInfo[]>([]);
  const [channels, setChannels] = useState<ChannelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [providerList, channelList] = await Promise.all([
        apiListChannelProviders(),
        apiListChannels(),
      ]);
      setProviders(providerList);
      setChannels(channelList);
    } catch (error) {
      toast.error(
        "加载通道信息失败: " +
          (error instanceof Error ? error.message : "未知错误"),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const columns: Column<ChannelInfo>[] = [
    { key: "label", header: "名称", sortable: true, filterable: true },
    { key: "type", header: "平台", sortable: true, filterable: true },
    { key: "status", header: "状态", sortable: true, filterable: true },
  ];

  if (loading) {
    return (
      <div className="space-y-4 p-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-7 w-28" />
          <Skeleton className="h-9 w-24" />
        </div>
        <div className="rounded-md border">
          <Skeleton className="h-10 w-full rounded-t-md" />
          <Skeleton className="h-12 w-full rounded-none border-t" />
          <Skeleton className="h-12 w-full rounded-none border-t" />
          <Skeleton className="h-12 w-full rounded-none border-t" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">消息渠道</h2>
        <Button onClick={() => setDialogOpen(true)}>新建消息渠道</Button>
      </div>

      <section>
        <DataTable<ChannelInfo>
          columns={columns}
          data={channels}
          searchable
          searchPlaceholder="搜索消息渠道..."
          emptyMessage="暂无数据"
          actions={() => (
            <div className="flex gap-2">
              <Button size="sm" variant="outline" disabled>
                编辑
              </Button>
              <Button size="sm" variant="destructive" disabled>
                删除
              </Button>
            </div>
          )}
        />
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建消息渠道</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3">
            {providers.map((provider) => (
              <div
                key={provider.type}
                className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
              >
                {provider.label}（暂不支持）
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setDialogOpen(false)}>
              关闭
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
