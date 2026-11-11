import {
  MAX_YJS_TRANSFER_BYTES,
  type YjsFragmentFrame,
  type YjsReplaceFrame,
  type YjsUpdateFrame,
} from "../protocol/update-frame";

/** 接收与发送共用总时限；持续零星到片不能无限延长内存占用。 */
export const YJS_TRANSFER_TIMEOUT_MS = 30_000;

interface Assembly {
  frame: YjsFragmentFrame;
  data: Uint8Array;
  received: number;
  timer: ReturnType<typeof setTimeout>;
}

/** 当前 socket 内的有界重组；断线与换代时必须释放未完成的传输。 */
export class YjsFragmentReceiver {
  private readonly assemblies = new Map<string, Assembly>();
  private heldBytes = 0;

  constructor(private readonly onTimeout: () => void) {}

  /** 完成证明不能越过尚未收齐的同代文档。 */
  hasPending(docName: string, generation?: string): boolean {
    const assembly = this.assemblies.get(docName);
    return assembly !== undefined && (generation === undefined || assembly.frame.generation === generation);
  }

  /** 严格验证同一传输的连续偏移与代次，完整前不返回可应用更新。 */
  accept(frame: YjsFragmentFrame): YjsUpdateFrame | YjsReplaceFrame | null {
    if (frame.kind === "replace" && frame.offset === 0) this.cancel(frame.docName);
    let assembly = this.assemblies.get(frame.docName);
    if (!assembly) {
      if (frame.offset !== 0 || this.heldBytes + frame.totalBytes > MAX_YJS_TRANSFER_BYTES)
        throw new Error("Yjs fragment budget or offset invalid");
      assembly = {
        frame,
        data: new Uint8Array(frame.totalBytes),
        received: 0,
        timer: setTimeout(() => {
          this.reset();
          this.onTimeout();
        }, YJS_TRANSFER_TIMEOUT_MS),
      };
      this.heldBytes += frame.totalBytes;
      this.assemblies.set(frame.docName, assembly);
    }
    if (
      assembly.frame.transferId !== frame.transferId ||
      assembly.frame.generation !== frame.generation ||
      assembly.frame.kind !== frame.kind ||
      assembly.data.length !== frame.totalBytes ||
      assembly.received !== frame.offset
    )
      throw new Error("Yjs fragment sequence invalid");
    assembly.data.set(frame.chunk, frame.offset);
    assembly.received += frame.chunk.length;
    if (assembly.received !== assembly.data.length) return null;
    this.cancel(frame.docName);
    return { type: frame.kind, docName: frame.docName, generation: frame.generation, update: assembly.data };
  }

  /** 权威 replace 与连接关闭会使旧传输失效，不能拼接两代内容。 */
  cancel(docName: string): void {
    const assembly = this.assemblies.get(docName);
    if (!assembly) return;
    clearTimeout(assembly.timer);
    this.heldBytes -= assembly.data.length;
    this.assemblies.delete(docName);
  }

  /** 释放当前连接的全部分片与定时器。 */
  reset(): void {
    for (const name of this.assemblies.keys()) this.cancel(name);
  }
}
