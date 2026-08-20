import { getAdminKey } from "../lib/admin-key";
import { request, unwrap } from "./request";

export interface SystemLogFile {
  name: string;
  size: number;
  modifiedAt: string;
  isErrorLog: boolean;
}

export interface SystemLogEntry {
  timestamp: string | null;
  level: string | null;
  module: string | null;
  requestId: string | null;
  message: string;
  error: { type: string | null; message: string | null; stack: string | null } | null;
}

export interface SystemLogSearchResult {
  file: SystemLogFile;
  entries: SystemLogEntry[];
  totalMatches: number;
  truncated: boolean;
}

export function fetchSystemLogFiles(): Promise<{ files: SystemLogFile[] }> {
  return unwrap(request<{ files: SystemLogFile[] }>("/api/system/logs/", { bearerToken: getAdminKey() ?? undefined }));
}

export function searchSystemLog(input: {
  file: string;
  q: string;
  errorOnly: boolean;
  limit?: number;
}): Promise<SystemLogSearchResult> {
  return unwrap(
    request<SystemLogSearchResult>("/api/system/logs/search", {
      query: { ...input, limit: input.limit ?? 500 },
      bearerToken: getAdminKey() ?? undefined,
      timeout: 60_000,
    }),
  );
}

export async function downloadSystemLog(file: string): Promise<void> {
  const response = await fetch(`/api/system/logs/download?file=${encodeURIComponent(file)}`, {
    credentials: "include",
    headers: { Authorization: `Bearer ${getAdminKey() ?? ""}` },
  });
  if (!response.ok) throw new Error("日志下载失败");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file;
  anchor.click();
  URL.revokeObjectURL(url);
}
