// 工具 occurrence 的身份是 (entryId, toolCallId, ordinal)，ordinal 在 entry 内跨 run 递增。
import type * as Y from "yjs";
import { directoryRootDocId, readDirectoryPage, readDirectoryRoot } from "../protocol/directory";
import { SyncProtocolError } from "../protocol/errors";
import type { ProjectionStore } from "../store/types";
import { loadCommittedDoc } from "./committed-doc";
import { records } from "./writer-support";

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

/** 兼容旧字符串载荷；缺序号的旧数据只能提供工具重放判据。 */
export function readBoundaryPayload(payload: Uint8Array): BoundaryPayload {
  try {
    const value: unknown = JSON.parse(DECODER.decode(payload));
    if (typeof value === "string" && value.length > 0) return { toolCallId: value, ordinal: null };
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const record = value as Record<string, unknown>;
      const toolCallId =
        typeof record.toolCallId === "string" && record.toolCallId.length > 0 ? record.toolCallId : null;
      const ordinal =
        typeof record.ordinal === "number" && Number.isSafeInteger(record.ordinal) && record.ordinal >= 0
          ? record.ordinal
          : null;
      return { toolCallId, ordinal };
    }
  } catch {
    // 坏载荷仍保留边界，完整性由投影层显式降级。
  }
  return { toolCallId: null, ordinal: null };
}

/** 沿用既有载荷，不改变 wire frame 版本。 */
export function boundaryPayload(toolCallId: string, ordinal: number): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ toolCallId, ordinal }));
}

export class BoundaryIndex {
  private readonly identities = new Set<string>();
  private readonly latestByTool = new Map<string, number>();
  private readonly nextOrdinals = new Map<string, number>();

  /** 同代次所有块按目录顺序 seed，序号取最大值而非记录数。 */
  seed(values: readonly BoundaryRecordLike[]): void {
    for (const record of values) {
      if (record.kind !== "tool_boundary") continue;
      const { toolCallId, ordinal } = readBoundaryPayload(record.payload);
      const next = this.nextOrdinals.get(record.entryId) ?? 0;
      if (toolCallId !== null) this.remember(record.entryId, toolCallId, ordinal ?? next);
      this.nextOrdinals.set(record.entryId, Math.max(next, (ordinal ?? next) + 1));
    }
  }

  /** 显式 ordinal 区分同名 occurrence；无源序号时沿用首次出现语义，更新/重放不重复写。 */
  claim(entryId: string, toolCallId: string, occurrence?: unknown): number | null {
    if (
      occurrence !== undefined &&
      (typeof occurrence !== "number" || !Number.isSafeInteger(occurrence) || occurrence < 0)
    ) {
      throw new SyncProtocolError("MALFORMED_FRAME", { message: "invalid tool boundary ordinal" });
    }
    const key = `${entryId}\u0000${toolCallId}`;
    if (occurrence === undefined && this.latestByTool.has(key)) return null;
    const ordinal = typeof occurrence === "number" ? occurrence : (this.nextOrdinals.get(entryId) ?? 0);
    if (this.identities.has(`${key}\u0000${ordinal}`)) return null;
    this.remember(entryId, toolCallId, ordinal);
    this.nextOrdinals.set(entryId, Math.max(this.nextOrdinals.get(entryId) ?? 0, ordinal + 1));
    return ordinal;
  }

  private remember(entryId: string, toolCallId: string, ordinal: number): void {
    const key = `${entryId}\u0000${toolCallId}`;
    this.identities.add(`${key}\u0000${ordinal}`);
    this.latestByTool.set(key, ordinal);
  }

  reset(): void {
    this.identities.clear();
    this.latestByTool.clear();
    this.nextOrdinals.clear();
  }
}

/** seed 覆盖 generation 入口闭包、分页目录中的 sealed/live 块及 active 内存态。 */
export async function seedBoundaryIndexFromDocs(
  index: BoundaryIndex,
  store: ProjectionStore,
  generation: string,
  historyDocIds: readonly string[],
  active: { readonly docId: string; readonly doc: Y.Doc },
): Promise<void> {
  const docIds = new Set(historyDocIds);
  const root = await loadCommittedDoc(store, directoryRootDocId(generation));
  let pageId = root === null ? null : readDirectoryRoot(root.doc).latestPageId;
  root?.doc.destroy();
  const seenPages = new Set<string>();
  const pages: Array<readonly string[]> = [];
  while (pageId !== null) {
    if (seenPages.has(pageId)) throw new SyncProtocolError("MALFORMED_FRAME", { message: "cyclic content directory" });
    seenPages.add(pageId);
    const loaded = await loadCommittedDoc(store, pageId);
    if (loaded === null) throw new SyncProtocolError("DOC_NOT_FOUND", { message: "content directory page missing" });
    const page = readDirectoryPage(loaded.doc);
    loaded.doc.destroy();
    pages.push(page.contentDocIds);
    pageId = page.previousPageId;
  }
  for (const page of pages.reverse()) for (const docId of page) docIds.add(docId);
  for (const docId of docIds) {
    if (docId === active.docId) continue;
    const loaded = await loadCommittedDoc(store, docId);
    if (loaded === null)
      throw new SyncProtocolError("DOC_NOT_FOUND", { message: "content boundary seed block missing" });
    try {
      index.seed(records<BoundaryRecordLike>(loaded.doc)?.toArray() ?? []);
    } finally {
      loaded.doc.destroy();
    }
  }
  index.seed(records<BoundaryRecordLike>(active.doc)?.toArray() ?? []);
}
