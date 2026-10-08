/** 与本地服务交互的薄封装：失败一律抛出带状态的 Error，交给调用方统一提示。 */

import type { FileContent, FileSummary, Topology } from "./types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new Error(`请求 ${path} 失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // 非 JSON 响应（例如静态资源 404）保留状态文本即可
    }
    throw new Error(`${response.status} ${detail}`);
  }
  return (await response.json()) as T;
}

export function fetchTopology(): Promise<Topology> {
  return request<Topology>("/api/topology");
}

export async function fetchFiles(group?: string): Promise<FileSummary[]> {
  const query = group ? `?group=${encodeURIComponent(group)}` : "";
  const data = await request<{ files: FileSummary[] }>(`/api/files${query}`);
  return data.files;
}

export function fetchFile(id: string): Promise<FileContent> {
  return request<FileContent>(`/api/file?id=${encodeURIComponent(id)}`);
}

export async function refreshTopology(): Promise<void> {
  await request<{ ok: boolean }>("/api/refresh", { method: "POST" });
}
