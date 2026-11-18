import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import type { SpoolSegment } from "./spool";

const ENOENT = "ENOENT";
/** 创建不包含本地路径或内容的暂存错误。 */
export function spoolError(code: SyncErrorCode, message: string, cause?: unknown): SyncProtocolError {
  return new SyncProtocolError(code, cause === undefined ? { message } : { message, cause });
}

/** 最小范围收窄：Node 的 fs 异常不是导出类型，只取它可移植的 `code` 字段。 */
export function errnoOf(error: unknown): string | null {
  const { code } = error instanceof Error ? (error as { code?: unknown }) : { code: undefined };
  return typeof code === "string" ? code : null;
}

/** 收敛 I/O 异常：已分类的协议错误原样上抛（缺失段不能被降级成暂存失败），其余包成 STAGING_FAILED，message
 * 只带操作名与 errno——绝不回显路径。 */
export function ioFailure(operation: string, error: unknown): SyncProtocolError {
  if (error instanceof SyncProtocolError) {
    return error;
  }
  const errno = errnoOf(error);
  return spoolError("STAGING_FAILED", `spool ${operation} failed${errno === null ? "" : ` (${errno})`}`, error);
}

/** 打开段文件；缺失是「暂存字节不完整」而非暂存故障，故单独映射成 IMPORT_INCOMPLETE。 */
async function openSegmentFile(segment: SpoolSegment, flags: "a" | "r"): Promise<FileHandle> {
  try {
    return await open(segment.path, flags);
  } catch (error) {
    if (errnoOf(error) === ENOENT) {
      throw spoolError("IMPORT_INCOMPLETE", `spool segment ${segment.index} is missing`);
    }
    throw ioFailure("open", error);
  }
}

/** 读取段内切片：短读说明暂存字节不完整，一律 IMPORT_INCOMPLETE（调用方只应重试整批，不做局部修补）。 */
export async function readSegmentSlice(segment: SpoolSegment, offset: number, count: number): Promise<Uint8Array> {
  const handle = await openSegmentFile(segment, "r");
  const buffer = new Uint8Array(count);
  try {
    const { bytesRead } = await handle.read(buffer, 0, count, offset);
    if (bytesRead !== count) {
      throw spoolError("IMPORT_INCOMPLETE", `spool segment ${segment.index} returned ${bytesRead} of ${count} bytes`);
    }
  } finally {
    // 读取完成后关闭失败不改变结果，且不得顶替上面更精确的错误。
    await handle.close().catch(() => undefined);
  }
  return buffer;
}

/** 每个任务只持有当前段的一个写句柄；换段或终止时关闭，不缓存正文。 */
export class SpoolSegmentWriter {
  private current: { segment: SpoolSegment; handle: FileHandle } | null = null;

  /** 追加保真字节，短写必须补齐；发生错误后仍由任务清理关闭句柄。 */
  async append(segment: SpoolSegment, chunk: Uint8Array): Promise<void> {
    if (this.current?.segment !== segment) {
      await this.close();
      this.current = { segment, handle: await openSegmentFile(segment, "a") };
    }
    try {
      let written = 0;
      while (written < chunk.length) {
        const result = await this.current.handle.write(chunk.subarray(written));
        if (result.bytesWritten <= 0) throw spoolError("STAGING_FAILED", "spool segment write made no progress");
        written += result.bytesWritten;
      }
    } catch (error) {
      throw ioFailure("write", error);
    }
  }

  /** 幂等释放写句柄；主路径关闭失败仍是暂存故障。 */
  async close(): Promise<void> {
    const current = this.current;
    this.current = null;
    if (!current) return;
    try {
      await current.handle.close();
    } catch (error) {
      throw ioFailure("close", error);
    }
  }
}
