import type { Readable } from "node:stream";

/** 将文件流交给 HTTP 响应；每次拉取一个块，取消时先停止投影再销毁源流。 */
export function fileDownloadStream(stream: Readable): ReadableStream<Uint8Array> {
  const iterator: AsyncIterator<Uint8Array | string> = stream[Symbol.asyncIterator]();
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        const next = await iterator.next();
        if (cancelled) return;
        if (next.done) controller.close();
        else controller.enqueue(typeof next.value === "string" ? Buffer.from(next.value) : next.value);
      } catch (error) {
        stream.destroy();
        if (!cancelled) controller.error(error);
      }
    },
    async cancel() {
      cancelled = true;
      stream.destroy();
      await iterator.return?.();
    },
  });
}

/** 构造兼容旧客户端的 ASCII fallback 与 RFC 5987 UTF-8 下载文件名。 */
export function contentDispositionAttachment(fileName: string): string {
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;]/g, "_")
    .replace(/[\r\n]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback || "download.zip"}"; filename*=UTF-8''${encoded}`;
}
