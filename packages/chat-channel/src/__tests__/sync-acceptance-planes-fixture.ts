// 同步端到端行为验收。
import { expect } from "bun:test";

import { type SyncErrorCode, SyncProtocolError } from "../sync/protocol/errors";

import {
  createPlaneHarness,
  createPlaneStore,
  duplicateRecordIds,
  FaultyProjectionStore,
  type FaultyStoreMethod,
  PLANE_CAPACITY,
  PlaneClock,
  type PlaneConnection,
  type PlaneHarness,
  type PlaneHarnessOptions,
  TEXT_SLOT,
  textOfRecords,
} from "./sync-acceptance-planes-oracle";
/** 真实端到端夹具始终在用例退出时释放全部连接。 */
export async function withHarness(
  options: PlaneHarnessOptions,
  body: (harness: PlaneHarness) => Promise<void>,
): Promise<void> {
  const harness = await createPlaneHarness(options);
  try {
    await body(harness);
  } finally {
    await harness.disposeAll();
  }
}

/** T08 专用：以「故障注入 store」装配夹具；除被注入的那一次调用外，读写全部到达真实内存 store。 */
export async function withFaultyHarness(
  fault: { readonly method: FaultyStoreMethod; readonly afterCalls: number; readonly error: Error },
  body: (harness: PlaneHarness, faulty: FaultyProjectionStore) => Promise<void>,
): Promise<void> {
  const clock = new PlaneClock();
  const capacity = PLANE_CAPACITY;
  const faulty = new FaultyProjectionStore(createPlaneStore(capacity, clock), fault);
  const harness = await createPlaneHarness({ store: faulty, clock, capacity });
  try {
    await body(harness, faulty);
  } finally {
    await harness.disposeAll();
  }
}

/** 需要主连接的用例在缺失时立即失败，避免静默跳过客户端断言。 */
export function primaryOf(harness: PlaneHarness): PlaneConnection {
  const primary = harness.primary;
  if (primary === null) throw new Error("acceptance: harness has no primary connection");
  return primary;
}

/** 断言异步操作以指定协议码失败；返回错误对象以便继续检查 retryable 等字段。 */
export async function expectProtocolError(
  run: () => Promise<unknown>,
  code: SyncErrorCode,
): Promise<SyncProtocolError> {
  let caught: unknown = null;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SyncProtocolError);
  const error = caught as SyncProtocolError;
  expect(error.code).toBe(code);
  return error;
}

// ------------------------------------------------------------------ 冒烟（夹具自检）

export const TIGHT_WINDOW_BYTES = 32_768;

/** 慢端镜像里该 entry 的文本（与写入侧真值同口径：同一 entry/slot）。 */
export function mirrorText(connection: PlaneConnection, source: string | PlaneHarness): string {
  const ids = typeof source === "string" ? [source] : liveContentIds(source);
  return textOfRecords(
    ids.flatMap((id) => connection.mirror.records(id)),
    "turn-1:assistant",
    TEXT_SLOT,
  );
}

/** 逐块写入并返回写入侧真值：由本层按写入顺序拼接，不读被测的合并结果。 */
export async function writeChunks(
  harness: PlaneHarness,
  count: number,
  bodyBytes = 4096,
  connections: readonly PlaneConnection[] = [primaryOf(harness)],
): Promise<string> {
  const parts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const delta = `${index}:${"x".repeat(bodyBytes)}`;
    parts.push(delta);
    await harness.writeText(delta);
    await followLiveContent(harness, connections);
  }
  return parts.join("");
}

const SUBSCRIPTIONS = new WeakMap<PlaneConnection, Set<string>>();

/** 只观察本次实时链，避免其他代次或历史入口影响全文顺序。 */
export function liveContentIds(harness: PlaneHarness): string[] {
  return harness
    .docsOfKind("content")
    .filter((row) => parseDocId(row.docId).generation === harness.seedGeneration)
    .map((row) => row.docId);
}

/** 模拟客户端发现新块后显式订阅；已订阅块不重订，暂停连接仍受同一窗口约束。 */
export async function followLiveContent(harness: PlaneHarness, connections: readonly PlaneConnection[]): Promise<void> {
  for (const connection of connections) {
    let subscribed = SUBSCRIPTIONS.get(connection);
    if (!subscribed) {
      subscribed = new Set([harness.seedContentDocId]);
      SUBSCRIPTIONS.set(connection, subscribed);
    }
    const added = liveContentIds(harness).filter((id) => !subscribed.has(id));
    if (added.length === 0) continue;
    for (const id of added) subscribed.add(id);
    await connection.subscribe(added);
  }
}

/** 每个实际跨块投递都须连续且无重复，不能仅验证首块的前沿。 */
export function expectLiveCoverage(harness: PlaneHarness, connection: PlaneConnection): void {
  const ids = liveContentIds(harness);
  expect(ids.length).toBeGreaterThan(1);
  for (const id of ids) {
    expect(connection.applied.coverage(id).gaps).toEqual([]);
    expect(connection.applied.duplicateUpdateSeqs(id)).toEqual([]);
  }
  expect(duplicateRecordIds(ids.flatMap((id) => connection.mirror.records(id)))).toEqual([]);
}

/** 不同 Doc 可独立送达，暂停期间只要求每块为已提交前缀，不能假设整条链已连续。 */
export async function expectPartialLiveText(
  harness: PlaneHarness,
  connection: PlaneConnection,
  expected: string,
): Promise<void> {
  for (const id of liveContentIds(harness)) {
    const committed = textOfRecords(await harness.canonicalRecords(id), "turn-1:assistant", TEXT_SLOT);
    expect(committed.startsWith(mirrorText(connection, id))).toBe(true);
  }
  expect(mirrorText(connection, harness).length).toBeLessThan(expected.length);
}

import { parseDocId } from "../sync/protocol/identity";

/** 接收这批输入：同一 entry 的三个片段，`partIndex` 决定块内顺序。 */
export async function receiveHistory(harness: PlaneHarness, parts: readonly string[] = HISTORY_PARTS): Promise<void> {
  for (const [index, text] of parts.entries()) {
    await harness.acceptHistoryText(text, { entryId: "h1", partIndex: index });
  }
}

/**
 * 历史期望文本 = 输入对象的**规范化 JSON** 逐条首尾相接（设计 §15.1 的历史 oracle）。
 * 记录载荷保存的是保真 JSON 字节，因此字符串对象在载荷里带引号，这正是要断言的内容。
 */
export function historyJson(parts: readonly string[] = HISTORY_PARTS): string {
  return parts.map((part) => JSON.stringify(part)).join("");
}

// ------------------------------------------------------------------ T08 load 每个阶段失败后重试

/** T08 的历史输入：三条文本对象；期望文本由输入侧拼接给出（不调用被测的合并/投影实现）。 */
export const HISTORY_PARTS = ["alpha|", "beta|", "gamma|"] as const;

/** 存储里的写者归属：竞争判定的独立口径（不读被测运行时的内存状态）。 */
export async function writerOwner(harness: PlaneHarness): Promise<string | null> {
  const pointer = await harness.store.readScopePointer(harness.scopeKey);
  return pointer?.writerOwner ?? null;
}
