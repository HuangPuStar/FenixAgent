/**
 * 文件读取：只接受索引里的 id，返回内容与元信息。
 *
 * 索引即白名单（见 scan.ts），所以这里不需要再做路径规范化；`id` 不在索引里一律失败，
 * 调用方拿到 `null` 就回 404。超长文件截断而不是拒绝，保证 UI 始终有内容可显示。
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { FileIndex } from "./scan";

/** 单次响应的内容上限；超过即截断，避免把整块日志/数据塞进响应。 */
const MAX_CONTENT_BYTES = 400 * 1024;

export type FileContent = {
  id: string;
  label: string;
  language: string;
  content: string;
  truncated: boolean;
  lineCount: number;
  size: number;
};

function languageOf(relPath: string): string {
  const base = path.basename(relPath);
  if (/^(docker-compose|compose)\.ya?ml$/.test(base) || /\.ya?ml$/.test(base)) return "yaml";
  if (base.endsWith(".md")) return "markdown";
  if (base.endsWith(".sh")) return "shell";
  if (base.startsWith("Dockerfile")) return "dockerfile";
  if (base.endsWith(".json")) return "json";
  if (base.endsWith(".toml") || base.endsWith(".conf")) return "toml";
  if (base.endsWith(".py")) return "python";
  if (base.endsWith(".sql")) return "sql";
  return "text";
}

/** 读取索引内文件；id 未登记、文件被删除或读取失败时返回 null。 */
export function readIndexedFile(index: FileIndex, id: string): FileContent | null {
  const entry = index.byId.get(id);
  if (!entry) return null;

  let buffer: Buffer;
  try {
    buffer = readFileSync(entry.absPath);
  } catch {
    return null;
  }

  const truncated = buffer.byteLength > MAX_CONTENT_BYTES;
  const sliced = truncated ? buffer.subarray(0, MAX_CONTENT_BYTES) : buffer;
  const content = sliced.toString("utf8");

  return {
    id: entry.id,
    label: entry.label,
    language: languageOf(entry.relPath),
    content,
    truncated,
    lineCount: content.split("\n").length,
    size: buffer.byteLength,
  };
}
