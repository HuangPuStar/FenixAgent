// packages/chat-channel/src/sync/live/writer-support.ts
// live-writer 的纯函数部分：载荷校验、记录数组、UTF-8 切片与前沿推进。抽出的原因是写入编排文件
// 已接近 500 行上限；这里不持有状态，也不读时钟/存储，行为与原实现逐条一致。

import * as Y from "yjs";

import type { RandomSource } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import type { DocFrontier } from "../store/types";

const UTF8 = new TextEncoder();

/** 协议错误的统一出口：稳定码 + 机器可读说明（不携带正文或凭据）。 */
function malformed(message: string): never {
  throw new SyncProtocolError("MALFORMED_FRAME", { message });
}

export const bytes = (text: string): Uint8Array => UTF8.encode(text);

export function hex(rand: RandomSource, byteLength: number): string {
  const value = rand.bytes(byteLength);
  if (value.length !== byteLength) malformed(`random source returned ${value.length} bytes`);
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function requireString(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) malformed(`field ${key} must be a string`);
  return value;
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) malformed(`bad ${field}`);
  return value as Record<string, unknown>;
}

/** 记录数组：读路径不得创建它（创建 struct 若逃出提交事务，重放者永远看不到这个数组），给了 `append` 才建数组并在同一事务里追加。 */
export function records<T>(doc: Y.Doc, append?: readonly T[]): Y.Array<T> | undefined {
  const root = doc.getMap<unknown>("root");
  const current = root.get("records");
  const target = current instanceof Y.Array ? (current as Y.Array<T>) : undefined;
  if (append === undefined) return target;
  const array = target ?? new Y.Array<T>();
  if (target === undefined) root.set("records", array);
  array.push([...append]);
  return array;
}

/** 按码点线性扫描 UTF-8 长度，只在片段边界切字符串，不重复编码累积前缀。 */
export function splitUtf8(text: string, maxBytes: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  let offset = 0;
  let size = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (width > maxBytes)
      throw new SyncProtocolError("CAPACITY_EXCEEDED", { message: "chunk cannot fit one code point" });
    if (size + width > maxBytes) {
      chunks.push(text.slice(start, offset));
      start = offset;
      size = 0;
    }
    offset += char.length;
    size += width;
  }
  if (offset > start) chunks.push(text.slice(start));
  return chunks;
}

export function concatParts(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function expectedFrontiers(
  slices: readonly { readonly docId: string; readonly fromSeq: number }[],
): DocFrontier[] {
  const minima = new Map<string, number>();
  for (const { docId, fromSeq } of slices) minima.set(docId, Math.min(minima.get(docId) ?? fromSeq, fromSeq - 1));
  return [...minima].map(([docId, lastSeq]) => ({ docId, lastSeq }));
}

export function applyFrontiers(
  cursors: ReadonlyMap<string, { lastSeq: number }>,
  frontiers: readonly DocFrontier[],
): void {
  for (const { docId, lastSeq } of frontiers) {
    const cursor = cursors.get(docId);
    if (cursor !== undefined) cursor.lastSeq = lastSeq;
  }
}
