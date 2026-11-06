const MAX_BYTES = 8192;
const READ_TIMEOUT_MS = 75;

/** Bounded JSON diagnostics; omitted bodies are never partially printed. */
export interface BodyPreview {
  data?: unknown;
  omitted?: string;
  bytes?: number;
}
interface BodySource {
  headers: Pick<Headers, "get">;
  body: unknown;
  clone(): { body: { getReader(): PreviewReader } | null };
}
interface PreviewReader {
  read(): Promise<{ done: true; value?: Uint8Array } | { done: false; value: Uint8Array }>;
  cancel(): Promise<unknown>;
}

/** Clone only small JSON bodies and stop reading on size or time limits without consuming the original. */
export async function previewBody(source: BodySource): Promise<BodyPreview> {
  if (!source.body) return { omitted: "empty" };
  if (source.headers.get("content-disposition")?.includes("attachment")) return { omitted: "file" };
  const mime = source.headers.get("content-type") ?? "";
  if (source.headers.get("transfer-encoding")?.toLowerCase().includes("chunked")) return { omitted: "stream" };
  if (!/^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:;|$)/i.test(mime)) return { omitted: "non_json_or_stream" };
  const length = Number(source.headers.get("content-length"));
  if (length > MAX_BYTES) return { omitted: "too_large", bytes: length };
  let reader: PreviewReader | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = Symbol("expired");
  const deadline = new Promise<typeof expired>((resolve) => {
    timer = setTimeout(() => resolve(expired), READ_TIMEOUT_MS);
  });
  try {
    reader = source.clone().body?.getReader();
    if (!reader) return { omitted: "empty" };
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk === expired) return { omitted: "read_timeout" };
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) return { omitted: "too_large", bytes };
      chunks.push(chunk.value);
    }
    if (!bytes) return { omitted: "empty" };
    const buffer = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { data: JSON.parse(new TextDecoder().decode(buffer)), bytes };
  } catch (error) {
    return { omitted: error instanceof SyntaxError ? "invalid_json" : "unreadable" };
  } finally {
    clearTimeout(timer);
    // A tee branch's cancel promise may wait for the live HTTP consumer; never await it here.
    void reader?.cancel().catch(() => {});
  }
}

/** Ordinary Elysia DTOs are already in memory; files and generators stay opaque. */
export function previewValue(value: unknown): BodyPreview {
  if (value === undefined || value === null) return { omitted: "empty" };
  if (typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype))
    return { omitted: "non_json_or_stream" };
  try {
    const text = JSON.stringify(value);
    const bytes = new TextEncoder().encode(text).byteLength;
    return bytes > MAX_BYTES ? { omitted: "too_large", bytes } : { data: value, bytes };
  } catch {
    return { omitted: "unreadable" };
  }
}
