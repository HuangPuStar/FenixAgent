import { MasterKeyGate } from "@fenix/resource-sandbox/web";
import { Badge } from "@fenix/ui-components/ui/badge";
import { Button } from "@fenix/ui-components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@fenix/ui-components/ui/card";
import { Input } from "@fenix/ui-components/ui/input";
import { Skeleton } from "@fenix/ui-components/ui/skeleton";
import { ApiError } from "@fenix/web-runtime/api/request";
import { clearAdminKey, getAdminKey } from "@fenix/web-runtime/lib/admin-key";
import { useRequest } from "ahooks";
import { AlertCircle, Download, FileText, RefreshCw, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  downloadSystemLog,
  fetchSystemLogFiles,
  type SystemLogSearchResult,
  searchSystemLog,
} from "../../api/system-logs";

export function AdminLogsPage() {
  const { t } = useTranslation("observer");
  const [unlocked, setUnlocked] = useState(() => getAdminKey() !== null);
  const [gateError, setGateError] = useState<string | null>(null);

  if (!unlocked) {
    return (
      <MasterKeyGate
        error={gateError}
        onUnlock={() => {
          setGateError(null);
          setUnlocked(true);
        }}
      />
    );
  }

  return (
    <LogsDashboard
      onAuthFailure={() => {
        clearAdminKey();
        setGateError(t("login.error"));
        setUnlocked(false);
      }}
    />
  );
}

function LogsDashboard({ onAuthFailure }: { onAuthFailure: () => void }) {
  const { t } = useTranslation("observer");
  const [selectedFile, setSelectedFile] = useState<string>();
  const [query, setQuery] = useState("");
  const [errorOnly, setErrorOnly] = useState(false);
  const [result, setResult] = useState<SystemLogSearchResult>();
  const filesRequest = useRequest(fetchSystemLogFiles, {
    onSuccess: (data) => setSelectedFile((current) => current ?? data.files[0]?.name),
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
    },
  });
  const searchRequest = useRequest(searchSystemLog, {
    manual: true,
    onSuccess: setResult,
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
    },
  });
  // 下载是浏览器二进制读取（见 api/system-logs.ts 的说明），走 manual 请求只为拿到稳定的
  // loading 态与错误分类：`run()` 内部接住 rejection，不会像裸 promise 那样变成未处理的 rejection；
  // 401 与其它调用同样回门，其余失败给一次可见提示（否则点击后界面毫无反应）。
  const downloadRequest = useRequest(downloadSystemLog, {
    manual: true,
    onError: (error) => {
      if (error instanceof ApiError && error.code === "UNAUTHORIZED") onAuthFailure();
      else toast.error(t("logs.downloadError"));
    },
  });

  useEffect(() => {
    if (selectedFile) void searchRequest.runAsync({ file: selectedFile, q: "", errorOnly: false });
  }, [selectedFile, searchRequest.runAsync]);

  const runSearch = () => {
    if (selectedFile) void searchRequest.runAsync({ file: selectedFile, q: query, errorOnly });
  };
  const runDownload = () => {
    if (selectedFile) downloadRequest.run(selectedFile);
  };
  const files = filesRequest.data?.files ?? [];

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-text-primary">{t("logs.title")}</h1>
            <p className="text-xs text-text-muted">{t("logs.subtitle")}</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => filesRequest.refresh()} disabled={filesRequest.loading}>
            <RefreshCw className="size-3.5" />
            {t("states.refresh")}
          </Button>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t("logs.files")}</CardTitle>
          </CardHeader>
          <CardContent>
            {filesRequest.loading && !filesRequest.data ? (
              <div role="status" aria-busy="true">
                <Skeleton className="h-24 w-full" />
                <span className="sr-only">{t("states.loading")}</span>
              </div>
            ) : filesRequest.error && !filesRequest.data ? (
              // 持久错误分支：非 401 的失败（500 等）必须与「目录里没有可读日志」区分开，
              // 否则服务端故障会被渲染成 empty，用户以为日志就是空的。401 不经此处——它已在
              // onError 里清 key 回 MasterKeyGate，所以这里给重试而不给「无权限」占位。
              <div role="alert" className="flex flex-col items-center gap-3 py-6 text-center">
                <p className="text-sm text-destructive">{t("logs.filesError")}</p>
                <Button variant="outline" size="sm" onClick={() => filesRequest.refresh()}>
                  <RefreshCw className="size-3.5" />
                  {t("states.retry")}
                </Button>
              </div>
            ) : files.length === 0 ? (
              <p className="py-6 text-center text-sm text-text-muted">{t("logs.noFiles")}</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {files.map((file) => (
                  <Button
                    key={file.name}
                    variant={selectedFile === file.name ? "default" : "outline"}
                    size="sm"
                    onClick={() => setSelectedFile(file.name)}
                  >
                    <FileText className="size-3.5" />
                    {file.name}
                    {file.isErrorLog && <Badge variant="destructive">ERROR</Badge>}
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
              <Button onClick={runSearch} disabled={!selectedFile || searchRequest.loading}>
                <Search className="size-3.5" />
                {t("logs.searchButton")}
              </Button>
              {selectedFile && (
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
                {entry.timestamp && (
                  <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleString()}</time>
                )}
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
