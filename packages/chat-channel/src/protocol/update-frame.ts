// packages/chat-channel/src/protocol/update-frame.ts
// generation-aware Yjs 二进制 WS 帧编解码。

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });

export const YJS_UPDATE_FRAME_TYPE = 0x01;
export const YJS_STATE_VECTOR_FRAME_TYPE = 0x02;
export const YJS_REPLACE_FRAME_TYPE = 0x03;
export const YJS_V2_MAGIC = 0xa7;
export const YJS_V2_MAGIC_SECOND = 0x59;
export const YJS_FRAME_VERSION = 0x02;
export const MAX_YJS_SYNC_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_YJS_FRAME_BYTES = 9 * 1024 * 1024;
export const MAX_YJS_IDENTIFIER_BYTES = 1024;

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
export type YjsSyncFrame = LegacyYjsUpdateFrame | YjsUpdateFrame | YjsStateVectorFrame | YjsReplaceFrame;

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
  if (type !== YJS_UPDATE_FRAME_TYPE && type !== YJS_STATE_VECTOR_FRAME_TYPE && type !== YJS_REPLACE_FRAME_TYPE)
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
