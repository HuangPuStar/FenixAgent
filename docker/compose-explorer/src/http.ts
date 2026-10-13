/**
 * HTTP 层：静态资源 + 三个只读 API。这里是唯一的对外边界。
 *
 * 约定：
 *   - 只有 GET（外加 POST /api/refresh 重扫磁盘），不提供任何写文件能力；
 *   - 静态资源只从 public/ 目录取，越界即 404；
 *   - `/api/file` 只接受文件索引里的 id（未登记 = 404），因此不存在路径穿越读；
 *   - 所有 API 响应 no-store，避免浏览器把拓扑缓存成过期视图。
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ExplorerConfig } from "./config";
import { readIndexedFile } from "./files";
import type { FileIndex } from "./scan";

export type ExplorerState = {
  config: ExplorerConfig;
  fileIndex: FileIndex;
  /** 拓扑 JSON（惰性构建，refresh 时失效） */
  topologyJson: () => unknown;
  refresh: () => void;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ts": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

const transpiler = new Bun.Transpiler({ loader: "ts" });
const transpileCache = new Map<string, { mtimeMs: number; code: string }>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** 前端模块按请求即时转译（Bun.Transpiler），按文件 mtime 缓存；只服务 public/ 内的路径。 */
function serveModule(publicDir: string, urlPath: string): Response {
  const relative = urlPath.replace(/^\/assets\//, "");
  const absPath = path.resolve(publicDir, relative);
  if (!absPath.startsWith(publicDir + path.sep)) return new Response("Not found", { status: 404 });

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absPath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stats.isFile()) return new Response("Not found", { status: 404 });

  const extension = path.extname(absPath);
  const contentType = CONTENT_TYPES[extension];
  if (!contentType) return new Response("Unsupported type", { status: 415 });

  if (extension === ".ts") {
    const cached = transpileCache.get(absPath);
    const code =
      cached && cached.mtimeMs === stats.mtimeMs
        ? cached.code
        : transpiler.transformSync(readFileSync(absPath, "utf8"));
    transpileCache.set(absPath, { mtimeMs: stats.mtimeMs, code });
    return new Response(code, { headers: { "content-type": contentType, "cache-control": "no-cache" } });
  }

  return new Response(readFileSync(absPath), { headers: { "content-type": contentType, "cache-control": "no-cache" } });
}

function listFiles(state: ExplorerState, url: URL): unknown {
  const group = url.searchParams.get("group");
  const entries = group ? (state.fileIndex.byGroup.get(group) ?? []) : state.fileIndex.all;
  return {
    files: entries.map((entry) => ({
      id: entry.id,
      relPath: entry.relPath,
      label: path.basename(entry.relPath),
      kind: entry.kind,
      group: entry.group,
      size: entry.size,
    })),
  };
}

export function createFetchHandler(state: ExplorerState): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);

    if (url.pathname === "/api/topology") return json(state.topologyJson());
    if (url.pathname === "/api/files") return json(listFiles(state, url));

    if (url.pathname === "/api/file") {
      const id = url.searchParams.get("id") ?? "";
      const content = readIndexedFile(state.fileIndex, id);
      if (!content) return json({ error: "文件不在可读索引内" }, 404);
      return json(content);
    }

    if (url.pathname === "/api/refresh" && request.method === "POST") {
      state.refresh();
      return json({ ok: true, refreshedAt: new Date().toISOString() });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      return serveModule(state.config.publicDir, "/assets/index.html");
    }
    if (url.pathname.startsWith("/assets/")) {
      return serveModule(state.config.publicDir, url.pathname);
    }

    return json({ error: "Not found", path: url.pathname }, 404);
  };
}
