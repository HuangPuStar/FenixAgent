// packages/chat-channel/src/protocol/update-frame.ts
// generation-aware Yjs 二进制 WS 帧编解码。

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export const YJS_UPDATE_FRAME_TYPE = 0x01;
export const YJS_STATE_VECTOR_FRAME_TYPE = 0x02;
export const YJS_REPLACE_FRAME_TYPE = 0x03;
export const YJS_FRAGMENT_FRAME_TYPE = 0x04;
export const YJS_V2_MAGIC = 0xa7;
export const YJS_V2_MAGIC_SECOND = 0x59;
export const YJS_FRAME_VERSION = 0x02;
export const MAX_YJS_SYNC_PAYLOAD_BYTES = 8 * 1024 * 1024;
/** 大更新的分片载荷预算（含分片头），独立于普通帧上限。 */
export const MAX_YJS_FRAGMENT_PAYLOAD_BYTES = 2 * 1024 * 1024;
export const MAX_YJS_FRAME_BYTES = 9 * 1024 * 1024;
export const MAX_YJS_IDENTIFIER_BYTES = 1024;
/** 单连接累计在途载荷预算，与单帧限制分开，避免长历史被单帧限制拒绝。 */
export const MAX_YJS_TRANSFER_BYTES = 64 * 1024 * 1024;
/** 分片头：原帧类型、36 字节 UUID、偏移和总长度。 */
const FRAGMENT_HEADER_BYTES = 45;
export const YJS_FRAGMENT_DATA_BYTES = MAX_YJS_FRAGMENT_PAYLOAD_BYTES - FRAGMENT_HEADER_BYTES;

export interface LegacyYjsUpdateFrame {
  type: "legacy-update";
  docName: string;
  generation: null;
  update: Uint8Array;
}
export interface YjsUpdateFrame {
  type: "update";
  docName: string;
  generation: string;
  update: Uint8Array;
}
export interface YjsStateVectorFrame {
  type: "state-vector";
  docName: string;
  generation: string;
  stateVector: Uint8Array;
}
export interface YjsReplaceFrame {
  type: "replace";
  docName: string;
  generation: string;
  update: Uint8Array;
}
/** 同一传输的普通字节片段；只有完整重组后才可交给 Yjs。 */
export interface YjsFragmentFrame {
  type: "fragment";
  docName: string;
  generation: string;
  kind: "update" | "replace";
  transferId: string;
  offset: number;
  totalBytes: number;
  chunk: Uint8Array;
}
export type YjsSyncFrame =
  | LegacyYjsUpdateFrame
  | YjsUpdateFrame
  | YjsStateVectorFrame
  | YjsReplaceFrame
  | YjsFragmentFrame;

function encodePart(value: string, label: string): Uint8Array {
  const bytes = TEXT_ENCODER.encode(value);
  if (bytes.length === 0 || bytes.length > MAX_YJS_IDENTIFIER_BYTES)
    throw new Error(`${label} length is invalid: ${bytes.length} bytes`);
  return bytes;
}

function encodeGenerationFrame(type: number, docName: string, generation: string, payload: Uint8Array): Uint8Array {
  if (payload.length > MAX_YJS_SYNC_PAYLOAD_BYTES) throw new Error(`Yjs payload too large: ${payload.length} bytes`);
  const doc = encodePart(docName, "docName");
  const gen = encodePart(generation, "generation");
  const frame = new Uint8Array(8 + doc.length + gen.length + payload.length);
  frame[0] = type;
  frame[1] = YJS_V2_MAGIC;
  frame[2] = YJS_V2_MAGIC_SECOND;
  frame[3] = YJS_FRAME_VERSION;
  frame[4] = doc.length >> 8;
  frame[5] = doc.length & 0xff;
  frame.set(doc, 6);
  const offset = 6 + doc.length;
  frame[offset] = gen.length >> 8;
  frame[offset + 1] = gen.length & 0xff;
  frame.set(gen, offset + 2);
  frame.set(payload, offset + 2 + gen.length);
  if (frame.length > MAX_YJS_FRAME_BYTES) throw new Error(`Yjs frame too large: ${frame.length} bytes`);
  return frame;
}

export function encodeYjsUpdateFrame(docName: string, update: Uint8Array): Uint8Array;
export function encodeYjsUpdateFrame(docName: string, generation: string, update: Uint8Array): Uint8Array;
export function encodeYjsUpdateFrame(
  docName: string,
  generationOrUpdate: string | Uint8Array,
  maybeUpdate?: Uint8Array,
): Uint8Array {
  if (typeof generationOrUpdate === "string")
    return encodeGenerationFrame(YJS_UPDATE_FRAME_TYPE, docName, generationOrUpdate, maybeUpdate ?? new Uint8Array());
  const doc = encodePart(docName, "docName");
  const frame = new Uint8Array(3 + doc.length + generationOrUpdate.length);
  frame[0] = YJS_UPDATE_FRAME_TYPE;
  frame[1] = doc.length >> 8;
  frame[2] = doc.length & 0xff;
  frame.set(doc, 3);
  frame.set(generationOrUpdate, 3 + doc.length);
  if (frame.length > MAX_YJS_FRAME_BYTES) throw new Error(`Yjs frame too large: ${frame.length} bytes`);
  return frame;
}

export function encodeYjsStateVectorFrame(docName: string, generation: string, stateVector: Uint8Array): Uint8Array {
  return encodeGenerationFrame(YJS_STATE_VECTOR_FRAME_TYPE, docName, generation, stateVector);
}
export function encodeYjsReplaceFrame(docName: string, generation: string, update: Uint8Array): Uint8Array {
  return encodeGenerationFrame(YJS_REPLACE_FRAME_TYPE, docName, generation, update);
}

/** 编码一个有界分片，元数据同时用于接收端的预算与连续性校验。 */
export function encodeYjsFragmentFrame(frame: Omit<YjsFragmentFrame, "type">): Uint8Array {
  if (!validFragment(frame)) throw new Error("Invalid Yjs fragment");
  const payload = new Uint8Array(FRAGMENT_HEADER_BYTES + frame.chunk.length);
  payload[0] = frame.kind === "replace" ? YJS_REPLACE_FRAME_TYPE : YJS_UPDATE_FRAME_TYPE;
  payload.set(TEXT_ENCODER.encode(frame.transferId), 1);
  const view = new DataView(payload.buffer);
  view.setUint32(37, frame.offset);
  view.setUint32(41, frame.totalBytes);
  payload.set(frame.chunk, FRAGMENT_HEADER_BYTES);
  return encodeGenerationFrame(YJS_FRAGMENT_FRAME_TYPE, frame.docName, frame.generation, payload);
}

function validFragment(frame: Omit<YjsFragmentFrame, "type">): boolean {
  return (
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(frame.transferId) &&
    Number.isInteger(frame.totalBytes) &&
    frame.totalBytes > MAX_YJS_SYNC_PAYLOAD_BYTES &&
    frame.totalBytes <= MAX_YJS_TRANSFER_BYTES &&
    Number.isInteger(frame.offset) &&
    frame.offset >= 0 &&
    frame.offset % YJS_FRAGMENT_DATA_BYTES === 0 &&
    frame.chunk.length === Math.min(YJS_FRAGMENT_DATA_BYTES, frame.totalBytes - frame.offset) &&
    frame.chunk.length > 0
  );
}

function decodeText(bytes: Uint8Array): string | null {
  try {
    return TEXT_DECODER.decode(bytes);
  } catch {
    return null;
  }
}

export function decodeYjsSyncFrame(data: Uint8Array): YjsSyncFrame | null {
  if (data.length > MAX_YJS_FRAME_BYTES || data.length < 3) return null;
  const type: number = Number(data[0]);
  if (
    type !== YJS_UPDATE_FRAME_TYPE &&
    type !== YJS_STATE_VECTOR_FRAME_TYPE &&
    type !== YJS_REPLACE_FRAME_TYPE &&
    type !== YJS_FRAGMENT_FRAME_TYPE
  )
    return null;
  const hasV2Header =
    data.length >= 8 && data[1] === YJS_V2_MAGIC && data[2] === YJS_V2_MAGIC_SECOND && data[3] === YJS_FRAME_VERSION;
  if (!hasV2Header) {
    // magic 前缀出现但 magic/version 不完整时必须拒绝，不能降级为 legacy。
    if (data[1] === YJS_V2_MAGIC) return null;
    if (type !== YJS_UPDATE_FRAME_TYPE) return null;
    const docLength = (data[1] << 8) | data[2];
    if (docLength === 0 || 3 + docLength > data.length) return null;
    const docName = decodeText(data.subarray(3, 3 + docLength));
    return docName ? { type: "legacy-update", docName, generation: null, update: data.subarray(3 + docLength) } : null;
  }
  if (data.length < 8) return null;
  const docLength = (data[4] << 8) | data[5];
  if (docLength === 0 || 6 + docLength + 2 > data.length) return null;
  const docName = decodeText(data.subarray(6, 6 + docLength));
  if (!docName) return null;
  const generationOffset = 6 + docLength;
  const generationLength = (data[generationOffset] << 8) | data[generationOffset + 1];
  const payloadOffset = generationOffset + 2 + generationLength;
  if (generationLength === 0 || generationLength > MAX_YJS_IDENTIFIER_BYTES || payloadOffset > data.length) return null;
  const generation = decodeText(data.subarray(generationOffset + 2, payloadOffset));
  if (!generation || data.length - payloadOffset > MAX_YJS_SYNC_PAYLOAD_BYTES) return null;
  const payload = data.subarray(payloadOffset);
  if (type === YJS_FRAGMENT_FRAME_TYPE) {
    if (payload.length < FRAGMENT_HEADER_BYTES) return null;
    const originalType = payload[0];
    if (originalType !== YJS_UPDATE_FRAME_TYPE && originalType !== YJS_REPLACE_FRAME_TYPE) return null;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    const fragment: YjsFragmentFrame = {
      type: "fragment",
      docName,
      generation,
      kind: originalType === YJS_REPLACE_FRAME_TYPE ? "replace" : "update",
      transferId: decodeText(payload.subarray(1, 37)) ?? "",
      offset: view.getUint32(37),
      totalBytes: view.getUint32(41),
      chunk: payload.subarray(FRAGMENT_HEADER_BYTES),
    };
    return validFragment(fragment) ? fragment : null;
  }
  if (data[0] === YJS_STATE_VECTOR_FRAME_TYPE)
    return { type: "state-vector", docName, generation, stateVector: payload };
  if (data[0] === YJS_REPLACE_FRAME_TYPE) return { type: "replace", docName, generation, update: payload };
  return { type: "update", docName, generation, update: payload };
}

export function decodeYjsUpdateFrame(data: Uint8Array): { docName: string; update: Uint8Array } | null {
  const frame = decodeYjsSyncFrame(data);
  return frame && (frame.type === "legacy-update" || frame.type === "update")
    ? { docName: frame.docName, update: frame.update }
    : null;
}
