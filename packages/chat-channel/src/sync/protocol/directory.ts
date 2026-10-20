// packages/chat-channel/src/sync/protocol/directory.ts
// 目录分页（设计 §4.2 / 实施记录 §3.4）：根目录只持最新页 ID，每页固定条数并链接上一页。
//
// 为什么分页：全量 `contentDocIds` 放在一个 Y.Array 时，目录 base 会随历史线性增长，
// 数千块后单帧超过 `MAX_DATA_FRAME_BYTES`。分页后根目录恒为 O(1)，每页上限固定，
// 客户端按 `previousPageId` 逐页向前发现历史，页 Doc 复用既有 DOC_BASE/SUBSCRIBE 协议。
//
// 本模块只描述目录 Doc 的字节布局与纯函数（浏览器安全）：不读写 store、不生成帧。
// 页号从 1 递增，页 Doc 的 blockIndex 等于页号；根目录固定 blockIndex=0。

import * as Y from "yjs";

import { buildDocId } from "./identity";

/** 单页内容块上限；固定值保证页 Doc 的 base 尺寸有界。 */
export const DIRECTORY_PAGE_SIZE = 64;

const ROOT_MAP_KEY = "root";
const LATEST_PAGE_KEY = "latestPageId";
const CONTENT_DOC_IDS_KEY = "contentDocIds";
const PREVIOUS_PAGE_KEY = "previousPageId";
const ROOT_NONCE = "directory";
const PAGE_NONCE = "page";

export interface DirectoryRootState {
  /** 最新（最接近 live）的页 Doc ID；空代次为 null。 */
  readonly latestPageId: string | null;
}

export interface DirectoryPageState {
  /** 本页内容块 Doc ID，按目录顺序（旧 → 新）。 */
  readonly contentDocIds: readonly string[];
  /** 上一页（更旧）的页 Doc ID；最早一页为 null。 */
  readonly previousPageId: string | null;
}

export interface DirectoryPagePlan {
  readonly pageDocId: string;
  readonly contentDocIds: readonly string[];
  readonly previousPageId: string | null;
  /** 页号从 1 开始，与 docId 的 blockIndex 一致。 */
  readonly pageNumber: number;
}

export interface DirectoryPlan {
  readonly rootDocId: string;
  readonly latestPageId: string | null;
  readonly pages: readonly DirectoryPagePlan[];
}

/** 根目录 Doc ID：固定非随机，便于导入重试与恢复时复用同一标识。 */
export function directoryRootDocId(generation: string): string {
  return buildDocId({ kind: "directory", generation, blockIndex: 0, nonce: ROOT_NONCE });
}

/** 页 Doc ID：页号即 blockIndex，固定非随机，导入重试不会产生第二套页。 */
export function directoryPageDocId(generation: string, pageNumber: number): string {
  if (!Number.isSafeInteger(pageNumber) || pageNumber < 1) {
    throw new RangeError(`directory page number must be a positive safe integer, received ${String(pageNumber)}`);
  }
  return buildDocId({ kind: "directory", generation, blockIndex: pageNumber, nonce: PAGE_NONCE });
}

/** 读取根目录状态；缺字段或类型不符按空目录处理，不猜测。 */
export function readDirectoryRoot(doc: Y.Doc): DirectoryRootState {
  const value = doc.getMap<unknown>(ROOT_MAP_KEY).get(LATEST_PAGE_KEY);
  return { latestPageId: typeof value === "string" && value.length > 0 ? value : null };
}

/** 读取一页的块列表与上一页链接；非字符串条目跳过。 */
export function readDirectoryPage(doc: Y.Doc): DirectoryPageState {
  const root = doc.getMap<unknown>(ROOT_MAP_KEY);
  const value = root.get(CONTENT_DOC_IDS_KEY);
  const contentDocIds =
    value instanceof Y.Array ? value.toArray().filter((docId): docId is string => typeof docId === "string") : [];
  const previous = root.get(PREVIOUS_PAGE_KEY);
  return {
    contentDocIds,
    previousPageId: typeof previous === "string" && previous.length > 0 ? previous : null,
  };
}

function encodeSnapshot(build: (doc: Y.Doc) => void): Uint8Array {
  const doc = new Y.Doc();
  try {
    build(doc);
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

/** 根目录基线快照；空代次的 `latestPageId` 为 null。 */
export function buildDirectoryRootSnapshot(latestPageId: string | null): Uint8Array {
  return encodeSnapshot((doc) => {
    doc.getMap<unknown>(ROOT_MAP_KEY).set(LATEST_PAGE_KEY, latestPageId);
  });
}

/** 页基线快照：固定内容块列表 + 上一页链接。 */
export function buildDirectoryPageSnapshot(
  contentDocIds: readonly string[],
  previousPageId: string | null,
): Uint8Array {
  return encodeSnapshot((doc) => {
    const root = doc.getMap<unknown>(ROOT_MAP_KEY);
    const ids = new Y.Array<string>();
    root.set(CONTENT_DOC_IDS_KEY, ids);
    root.set(PREVIOUS_PAGE_KEY, previousPageId);
    ids.push([...contentDocIds]);
  });
}

/** 在已加载的页 Doc 上追加内容块 ID；返回是否产生了变更。 */
export function appendDirectoryPageContent(doc: Y.Doc, docId: string): boolean {
  const root = doc.getMap<unknown>(ROOT_MAP_KEY);
  let ids = root.get(CONTENT_DOC_IDS_KEY);
  let created = false;
  if (!(ids instanceof Y.Array)) {
    ids = new Y.Array<string>();
    root.set(CONTENT_DOC_IDS_KEY, ids);
    created = true;
  }
  const target = ids as Y.Array<string>;
  const exists = target.toArray().includes(docId);
  if (!exists) target.push([docId]);
  return created || !exists;
}

/** 更新根目录指向的最新页；返回是否产生了变更。 */
export function setDirectoryLatestPageId(doc: Y.Doc, pageId: string | null): boolean {
  const root = doc.getMap<unknown>(ROOT_MAP_KEY);
  if (root.get(LATEST_PAGE_KEY) === pageId) return false;
  root.set(LATEST_PAGE_KEY, pageId);
  return true;
}

/**
 * 把一个代次的全部内容块按目录顺序切页。
 *
 * 先到的是更旧的块，页号随历史前进递增；最新页始终是页号最大的那一页。
 * 空列表返回空目录（`latestPageId = null`），由首次 live 写入再建页。
 */
export function planDirectoryPages(generation: string, contentDocIds: readonly string[]): DirectoryPlan {
  const ids = [...new Set(contentDocIds)];
  const pages: DirectoryPagePlan[] = [];
  for (let offset = 0; offset < ids.length; offset += DIRECTORY_PAGE_SIZE) {
    const pageNumber = pages.length + 1;
    pages.push({
      pageNumber,
      pageDocId: directoryPageDocId(generation, pageNumber),
      contentDocIds: ids.slice(offset, offset + DIRECTORY_PAGE_SIZE),
      previousPageId: pageNumber === 1 ? null : directoryPageDocId(generation, pageNumber - 1),
    });
  }
  return {
    rootDocId: directoryRootDocId(generation),
    latestPageId: pages.at(-1)?.pageDocId ?? null,
    pages,
  };
}
