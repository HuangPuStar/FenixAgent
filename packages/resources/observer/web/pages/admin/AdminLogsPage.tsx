import { AdminKeyGate } from "@fenix/ui-components/config/AdminKeyGate";
import { formatDateTime } from "@fenix/ui-components/lib/format";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { Input } from "@fenix/ui-components/ui/input";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { ApiError } from "@fenix/web-runtime/api/request";
import { useAdminKeyGate } from "@fenix/web-runtime/hooks/use-admin-key-gate";
import { useRequest } from "ahooks";
import { AlertCircle, Download, FileText, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { type SystemLogSearchInput, type SystemLogSearchResult, systemLogsApi } from "../../api/system-logs";

export function AdminLogsPage() {
  const { t } = useTranslation("observer");
  const gate = useAdminKeyGate(t("login.error"));

  return (
    <AdminKeyGate
      unlocked={gate.unlocked}
      error={gate.error}
      onUnlock={gate.unlock}
      title={t("login.title")}
      description={t("login.description")}
      inputPlaceholder={t("login.inputPlaceholder")}
      submitLabel={t("login.submit")}
    >
      <LogsDashboard onAuthFailure={gate.fail} />
    </AdminKeyGate>
  );
}

function LogsDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation("observer");
  const [selectedSourceId, setSelectedSourceId] = useState<string>();
  const [query, setQuery] = useState("");
  const [errorOnly, setErrorOnly] = useState(false);
  const [result, setResult] = useState<SystemLogSearchResult>();
  const sourcesRequest = useRequest(() => systemLogsApi.fetchSources(), {
    onSuccess: (data) => setSelectedSourceId((current) => current ?? data.sources[0]?.id),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
    },
  });
  const searchRequest = useRequest((input: SystemLogSearchInput) => systemLogsApi.search(input), {
    manual: true,
    onSuccess: setResult,
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
    },
  });
  // 导出是浏览器流读取（见 api/system-logs.ts 的说明），走 manual 请求只为拿到稳定的
  // loading 态与错误分类：`run()` 内部接住 rejection，不会像裸 promise 那样变成未处理的 rejection；
  // 401 与其它调用同样回门，其余失败给一次可见提示（否则点击后界面毫无反应）。
  // 落盘归本层（§5.1：域模块只回 Blob）；`params[0]` 是本次 `run()` 传入的日志源 ID，与请求参数同源，
  // 不读 `selectedSourceId` state，避免请求进行中用户切换日志源时导出出名字与内容不符。
  // 文件名带 `.projected` 后缀：它是投影结果（脱敏 + 裁剪 + JSON Lines），不是底层日志文件，
  // 名字上不能让人误以为是原始日志；后缀与服务端 `Content-Disposition` 同形。
  const downloadRequest = useRequest((sourceId: string) => systemLogsApi.download(sourceId), {
    manual: true,
    onSuccess: (blob, params) => saveBlobAsFile(blob, `${params[0]}.projected.jsonl`),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
      else toast.error(t("logs.downloadError"));
    },
  });

  useEffect(() => {
    if (selectedSourceId) void searchRequest.runAsync({ sourceId: selectedSourceId, q: "", errorOnly: false });
  }, [selectedSourceId, searchRequest.runAsync]);

  const runSearch = () => {
    if (selectedSourceId) void searchRequest.runAsync({ sourceId: selectedSourceId, q: query, errorOnly });
  };
  const runDownload = () => {
    if (selectedSourceId) downloadRequest.run(selectedSourceId);
  };
  const sources = sourcesRequest.data?.sources ?? [];

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("logs.title")}</h1>
            <p className="text-xs text-text-muted">{t("logs.subtitle")}</p>
          </div>
          <Button variant="outline" onClick={() => sourcesRequest.refresh()} disabled={sourcesRequest.loading}>
            <RefreshCw />
            {t("states.refresh")}
          </Button>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("logs.files")}</CardTitle>
          </CardHeader>
          <CardContent>
            {sourcesRequest.loading && !sourcesRequest.data ? (
              <div role="status" aria-busy="true">
                <Skeleton className="h-24 w-full" />
                <span className="sr-only">{t("states.loading")}</span>
              </div>
            ) : sourcesRequest.error && !sourcesRequest.data ? (
              // 持久错误分支：非 401 的失败（500 等）必须与「当前没有可检索的日志源」区分开，
              // 否则服务端故障会被渲染成 empty，用户以为日志就是空的。401 不经此处——它已在
              // onError 里清 key 回 AdminKeyGate，所以这里给重试而不给「无权限」占位。
              <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="text-sm text-destructive">{t("logs.filesError")}</p>
                <Button variant="outline" size="sm" onClick={() => sourcesRequest.refresh()}>
                  <RefreshCw className="size-3.5" />
                  {t("states.retry")}
                </Button>
              </div>
            ) : sources.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">{t("logs.noFiles")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {sources.map((source) => (
                  <Button
                    key={source.id}
                    variant={selectedSourceId === source.id ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedSourceId(source.id)}
                  >
                    <FileText className="size-3.5" />
                    {source.date}
                    {source.kind === "error" ? (
                      <Badge variant="destructive">{t("logs.kindError")}</Badge>
                    ) : (
                      <Badge variant="secondary">{t("logs.kindApp")}</Badge>
                    )}
                  </Button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("logs.search")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="max-w-md"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") runSearch();
                }}
                placeholder={t("logs.searchPlaceholder")}
              />
              <label className="flex items-center gap-2 text-sm text-text-secondary">
                <input type="checkbox" checked={errorOnly} onChange={(event) => setErrorOnly(event.target.checked)} />
                {t("logs.errorOnly")}
              </label>
              <Button onClick={runSearch} disabled={!selectedSourceId || searchRequest.loading}>
                <Search className="size-3.5" />
                {t("logs.searchButton")}
              </Button>
              {selectedSourceId && (
                <Button variant="outline" onClick={runDownload} disabled={downloadRequest.loading}>
                  <Download className="size-3.5" />
                  {t("logs.download")}
                </Button>
              )}
            </div>
            {searchRequest.error ? (
              <div role="alert" className="flex items-center gap-2 text-sm text-destructive">
                <AlertCircle className="size-4" />
                {t("logs.searchError")}
              </div>
            ) : result ? (
              <LogResults result={result} />
            ) : (
              <p className="py-8 text-center text-sm text-text-muted">{t("logs.selectFile")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function LogResults({ result }: { result: SystemLogSearchResult }) {
  const { t } = useTranslation("observer");
  return (
    <div className="space-y-3">
      <p className="text-xs text-text-muted">
        {t("logs.matches", { count: result.totalMatches })}
        {result.truncated ? ` · ${t("logs.truncated")}` : ""}
      </p>
      <div className="max-h-[60vh] space-y-3 overflow-auto rounded-md border border-border p-3">
        {result.entries.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">{t("logs.noMatches")}</p>
        ) : (
          result.entries.map((entry, index) => (
            <article
              key={`${entry.timestamp ?? index}-${entry.message}`}
              className="space-y-2 rounded-md border border-border bg-card p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-xs text-text-muted">
                {entry.timestamp && <time dateTime={entry.timestamp}>{formatDateTime(entry.timestamp)}</time>}
                {entry.level && (
                  <Badge variant={entry.level.toLowerCase() === "error" ? "destructive" : "secondary"}>
                    {entry.level}
                  </Badge>
                )}
                {entry.module && <Badge variant="outline">{entry.module}</Badge>}
                {entry.requestId && (
                  <span>
                    {t("logs.requestId")}: {entry.requestId}
                  </span>
                )}
              </div>
              <p className="whitespace-pre-wrap break-all font-mono text-xs text-text-primary">{entry.message}</p>
              {entry.error && (
                <details className="rounded bg-muted/50 p-2 text-xs">
                  <summary className="cursor-pointer text-destructive">
                    {entry.error.type ?? t("logs.errorDetail")}
                    {entry.error.message ? `: ${entry.error.message}` : ""}
                  </summary>
                  {entry.error.stack && (
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all font-mono text-xs">
                      {entry.error.stack}
                    </pre>
                  )}
                </details>
              )}
            </article>
          ))
        )}
      </div>
    </div>
  );
}

/**
 * 触发浏览器落盘（本文件唯一的 DOM 操作）。
 *
 * 归口在页面而不是域模块：按前端规范 5.1「组件负责：调用域模块 → 处理结果 → 更新 UI」，
 * 锚点与 object URL 的生命周期是 UI 细节，域模块的 `systemLogsApi.download` 只回 `Blob`（见其注释）。
 * 文件名同样归本层：域模块回的是内容，名字是展示决定（服务端 `Content-Disposition` 用同一形状）。
 *
 * `click()` 与 `revokeObjectURL` 同步完成：锚点不插入文档，浏览器在 `click()` 时同步取走 URL 对应的
 * blob，随即释放即可，无需等待下载完成（与 sandbox 的 `ClusterPanel.downloadTunnelConfig` 同形）。
 * 这里不做失败分支——该动作不会 reject，取数失败已由 `useRequest` 的 `onError` 处理。
 */
function saveBlobAsFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}
