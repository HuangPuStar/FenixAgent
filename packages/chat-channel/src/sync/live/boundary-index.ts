// packages/chat-channel/src/sync/live/boundary-index.ts
// 实时工具边界的去重与序号分配：身份是 `(entryId, toolCallId)`，不同 entry 的同名工具各写一条；
// 同一身份的重放只认第一次。索引在写者生命周期内常驻，轮转后继续沿用；恢复时从当前内容块重建。

const DECODER = new TextDecoder();

export interface BoundaryRecordLike {
  readonly entryId: string;
  readonly kind: string;
  readonly payload: Uint8Array;
}

interface BoundaryPayload {
  readonly toolCallId: string | null;
  readonly ordinal: number | null;
}

/** 解析边界载荷：新格式 `{ toolCallId, ordinal }`；旧格式是 JSON 字符串工具 id。 */
export function readBoundaryPayload(payload: Uint8Array): BoundaryPayload {
  try {
    const value: unknown = JSON.parse(DECODER.decode(payload));
    if (typeof value === "string" && value.length > 0) return { toolCallId: value, ordinal: null };
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const toolCallId =
        typeof record.toolCallId === "string" && record.toolCallId.length > 0 ? record.toolCallId : null;
      const ordinal =
        typeof record.ordinal === "number" && Number.isInteger(record.ordinal) && record.ordinal >= 0
          ? record.ordinal
          : null;
      return { toolCallId, ordinal };
    }
  } catch {
    // 坏载荷仍视为边界，只是无法去重/编号。
  }
  return { toolCallId: null, ordinal: null };
}

/** 边界载荷统一格式。 */
export function boundaryPayload(toolCallId: string, ordinal: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ toolCallId, ordinal }));
}

function identityOf(entryId: string, toolCallId: string): string {
  return `${entryId}\u0000${toolCallId}`;
}

export class BoundaryIndex {
  private readonly identities = new Set<string>();
  private readonly nextOrdinals = new Map<string, number>();

  /** 从已提交内容块重建索引；同一 Doc 只调用一次。 */
  seed(records: readonly BoundaryRecordLike[]): void {
    for (const record of records) {
      if (record.kind !== "tool_boundary") continue;
      const { toolCallId, ordinal } = readBoundaryPayload(record.payload);
      if (toolCallId !== null) this.identities.add(identityOf(record.entryId, toolCallId));
      const next = ordinal === null ? (this.nextOrdinals.get(record.entryId) ?? 0) + 1 : ordinal + 1;
      this.nextOrdinals.set(record.entryId, Math.max(this.nextOrdinals.get(record.entryId) ?? 0, next));
    }
  }

  /** 新边界返回序号；`(entryId, toolCallId)` 已存在时返回 null（重放不重复写）。 */
  claim(entryId: string, toolCallId: string): number | null {
    const identity = identityOf(entryId, toolCallId);
    if (this.identities.has(identity)) return null;
    this.identities.add(identity);
    const ordinal = this.nextOrdinals.get(entryId) ?? 0;
    this.nextOrdinals.set(entryId, ordinal + 1);
    return ordinal;
  }

  reset(): void {
    this.identities.clear();
    this.nextOrdinals.clear();
  }
}
