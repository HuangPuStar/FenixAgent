// T08–T12 的独立验收夹具入口；原有导出保持在此，观测、存储边界与调度按职责拆分。
// 期望只由输入构造；读取采用 Yjs 原语和已提交出口；在途字节独立按线上帧记账。
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { AdmissionController } from "../sync/capacity/admission";
import { DEFAULT_SYNC_CAPACITY, type SyncCapacityProfile } from "../sync/capacity/profile";
import type { DocHub } from "../sync/client/doc-hub";
import type { SyncClientTransport } from "../sync/client/transport";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import type { ImportStatus } from "../sync/history/import-service";
import type { HistoryRecordMeta, IngestedRecord } from "../sync/history/ingest";
import type { SubscribeFrame, SyncFrame } from "../sync/protocol/frames";
import { buildDocId, type DocKind, type SyncScope, scopeKey } from "../sync/protocol/identity";
import { resolveSyncRuntimeConfig, type SyncRuntimeConfig } from "../sync/runtime/config";
import type { SyncFrameGateway } from "../sync/runtime/egress";
import type { SyncIngressEvent } from "../sync/runtime/ingress";
import type { SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import { MemoryProjectionStore } from "../sync/store/memory-store";
import type {
  GenerationEntryRefs,
  ProjectionStore,
  SyncDocRecord,
  SyncGenerationRecord,
  WriterLease,
} from "../sync/store/types";
import { PlaneHarnessImpl } from "./sync-acceptance-planes-harness";
import type {
  DeliveryAudit,
  DeliveryTrace,
  FlatRecord,
  PlaneLink,
  PlaneMirror,
  RuntimeEntityView,
  TextLog,
} from "./sync-acceptance-planes-observation";
import {
  ACK_DEADLINE_MS,
  BOOTSTRAP_TTL_MS,
  type CommittedDocRow,
  PLANES_LIFECYCLE,
  PlaneClock,
  tightenWindow,
} from "./sync-acceptance-planes-store";

export * from "./sync-acceptance-planes-observation";
export * from "./sync-acceptance-planes-store";

// ------------------------------------------------------------------ 夹具

/** 单条连接（= 一个 scope 运行时 + 一条进程内传输 + 一个真实客户端传输）。 */
export interface PlaneConnection {
  readonly label: string;
  readonly runtime: SyncScopeRuntime;
  readonly gateway: SyncFrameGateway;
  readonly link: PlaneLink;
  readonly client: SyncClientTransport;
  readonly hub: DocHub;
  readonly mirror: PlaneMirror;
  readonly audit: DeliveryAudit;
  /** 真正应用到镜像的数据帧区间（应用序号连续性的独立口径）。 */
  readonly applied: DeliveryTrace;
  readonly fatal: { readonly code: string; readonly detail: string | undefined }[];
  /** 收到的控制帧（本层不解释，只记录）。 */
  readonly control: SyncFrame[];
  /** 完整握手（HELLO）→ 交付 MANIFEST 与 HELLO 回执。 */
  handshake(input?: { generation?: string; loadedDocs?: readonly string[] }): Promise<void>;
  subscribe(docIds?: readonly string[], priority?: SubscribeFrame["priority"]): Promise<void>;
  writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void>;
  writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void>;
  acceptIngress(event: SyncIngressEvent): Promise<void>;
  /** 直接入站一条帧（不经队列），用于断言同步拒绝（例如旧 pointerRevision）。 */
  sendFrameNow(frame: SyncFrame): Promise<void>;
  /**
   * 暂停 / 恢复客户端的 apply 调度（T09 的慢客户端与后台标签页）。
   *
   * 暂停后仍收字节、仍进 hub 队列，但不 `drain`：不 apply、不回执——这正是「标签页被节流」的线上表现，
   * 服务端因此拿不到回执，只能靠连接窗口自我约束。暂停是夹具开关，不是生产常量。
   */
  pause(): void;
  resume(): void;
  readonly paused: boolean;
  dispose(): Promise<void>;
}

/** 单 scope 的连接、导入及已提交状态观测端口。 */
export interface PlaneHarness {
  readonly scope: SyncScope;
  readonly scopeKey: string;
  readonly store: ProjectionStore;
  readonly admission: AdmissionController;
  readonly time: PlaneClock;
  readonly config: SyncRuntimeConfig;
  readonly seedGeneration: string;
  readonly seedContentDocId: string;
  readonly seedRuntimeDocId: string;
  readonly seedEntryRefs: GenerationEntryRefs;
  /** 构造期签发、返回前已过期的引导租约（T11 的旧 epoch 写入拒绝用它）。 */
  readonly bootstrapLease: WriterLease;
  readonly log: TextLog;
  readonly spoolRoot: string;
  /** 第一条连接（`connect: false` 时为 null）。 */
  readonly primary: PlaneConnection | null;
  readonly connections: readonly PlaneConnection[];
  /** 在同一存储上再开一条连接（独立运行时 / 会话 / 额度）。 */
  connect(label: string, options?: { readonly seed?: string }): Promise<PlaneConnection>;
  /** 推进一轮：每条连接各自「出站 → 客户端 drain → 入站 → tick」。 */
  round(): Promise<number>;
  /** 推进到静止（无帧流动）或达到轮数上限。 */
  pump(): Promise<void>;
  /** 静止并返回本轮推进的帧数。 */
  settle(): Promise<number>;
  writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void>;
  writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void>;
  canonicalBytes(docId: string): Promise<Uint8Array>;
  canonicalRecords(docId: string): Promise<FlatRecord[]>;
  runtimeEntities(docId?: string): Promise<RuntimeEntityView[]>;
  docsOfKind(kind: DocKind): CommittedDocRow[];
  allDocRows(): CommittedDocRow[];
  generationState(generation: string): Promise<string>;
  currentGeneration(): Promise<string>;
  currentEntryRefs(): Promise<GenerationEntryRefs>;
  currentPointerRevision(): Promise<number>;
  contentDocIds(): Promise<string[]>;
  /** 通过已提交目录读取内容块，按 ordinal 顺序返回。 */
  directoryBlocks(generation?: string): Promise<PlaneDirectoryBlock[]>;
  /** 目录覆盖：ordinal 1..max 是否被恰好覆盖一次（返回缺口与重复序号）。 */
  coverage(generation?: string): Promise<{ gaps: number[]; duplicates: number[]; maxOrdinal: number }>;
  /** 已提交代次的全部内容块记录（按目录 ordinal 展开；跨块顺序的唯一依据）。 */
  flatRecords(): Promise<FlatRecord[]>;
  /** 历史导入入口（所有连接共享同一实现实例，取第一条连接的服务）。 */
  history(): SyncScopeRuntime["history"];
  beginImport(input?: { readonly owner?: string; readonly leaseTtlMs?: number }): Promise<{
    loadId: string;
    generation: string;
  }>;
  acceptHistory(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord>;
  acceptHistoryText(
    text: string,
    key: { readonly entryId: string; readonly contentSlot?: number; readonly partIndex?: number },
  ): Promise<IngestedRecord>;
  importStatus(): ImportStatus | null;
  /** 完成接收、构建和换代，返回真实导入服务的最终回执。 */
  finishImport(): Promise<{ outcome: string; generation: string; pointerRevision: number }>;
  /** 把一条客户端帧排入入站队列（丢帧 / 重复 / 伪造注入都走这里）。 */
  queueClientFrame(connection: PlaneConnection, frame: SyncFrame): void;
  disposeAll(): Promise<void>;
}

/** 验收装配输入；注入边界与临时目录的所有权由调用方明确选择。 */
export interface PlaneHarnessOptions {
  readonly scope?: SyncScope;
  /** 随机源种子：影响代次 / 写者 owner / deliveryId；多连接场景必须彼此不同。 */
  readonly seed?: string;
  readonly generation?: string;
  readonly capacity?: SyncCapacityProfile;
  /** 收紧连接窗口（与 socket 水位同值）。 */
  readonly windowBytes?: number;
  readonly merge?: { readonly maxBytes?: number; readonly maxDelayMs?: number };
  readonly ackMs?: number;
  readonly store?: ProjectionStore;
  readonly admission?: AdmissionController;
  readonly clock?: PlaneClock;
  readonly spoolRoot?: string;
  /** 是否立刻建立第一条连接（只做历史导入的 scope 不需要）。 */
  readonly connect?: boolean;
}

/** 一条内容块的读取视图（ordinal 范围来自目录行，记录来自已提交字节）。 */
export interface PlaneDirectoryBlock {
  readonly docId: string;
  readonly ordinalStart: number;
  readonly ordinalEnd: number;
  readonly records: FlatRecord[];
}

/** 空 Y.Doc 的 canonical 字节（验收的初始基线：没有任何记录）。 */
function emptyDocBytes(): Uint8Array {
  return Y.encodeStateAsUpdate(new Y.Doc());
}

/** 登记初始 active 文档（`MemoryProjectionStore` 要求 active + baseSeq 0 + 摘要一致）。 */
function activeDocRecord(input: {
  scopeKey: string;
  generation: string;
  docId: string;
  kind: DocKind;
  snapshot: Uint8Array;
}): SyncDocRecord {
  return {
    scopeKey: input.scopeKey,
    generation: input.generation,
    docId: input.docId,
    kind: input.kind,
    state: "active",
    snapshot: input.snapshot,
    hash: sha256Digest(input.snapshot),
    baseSeq: 0,
    finalSeq: null,
    blockIndex: 0,
    ordinalStart: null,
    ordinalEnd: null,
    dependsOn: [],
  };
}

/** 代次入口闭包：与 `buildDocId` 的线格式一致（`sync/<kind>/<generation>/<index>/<nonce>`）。 */
function entryRefsFor(generation: string): GenerationEntryRefs {
  return {
    controlDocId: buildDocId({ kind: "control", generation, blockIndex: 0, nonce: "control" }),
    directoryDocId: buildDocId({ kind: "directory", generation, blockIndex: 0, nonce: "directory" }),
    runtimeDocId: buildDocId({ kind: "runtime", generation, blockIndex: 0, nonce: "runtime" }),
    contentDocIds: [buildDocId({ kind: "content", generation, blockIndex: 0, nonce: "content" })],
  };
}

/**
 * 组装一个 scope 夹具：登记并提交一个代次与入口 Doc，让引导租约过期，再按需建立第一条连接。
 *
 * 装配顺序即真实顺序：没有已提交代次时握手与写入都会被拒。除假时钟、传输端口与（T08 显式注入的）
 * 故障 store 外，全部是真实实现。
 */
export async function createPlaneHarness(options: PlaneHarnessOptions = {}): Promise<PlaneHarness> {
  const scope = options.scope ?? { organizationId: "org-planes", rcsSessionId: "session-planes" };
  const key = scopeKey(scope);
  const seed = options.seed ?? "planes-acceptance";
  const time = options.clock ?? new PlaneClock();
  const spoolRoot = options.spoolRoot ?? (await mkdtemp(join(tmpdir(), "sync-planes-")));
  const capacity =
    options.capacity ??
    (options.windowBytes === undefined ? DEFAULT_SYNC_CAPACITY : tightenWindow(options.windowBytes));
  const config = resolveSyncRuntimeConfig({
    clock: time,
    random: deterministicRandomSource(seed),
    lifecycle: PLANES_LIFECYCLE,
    capacity,
    merge: { maxBytes: options.merge?.maxBytes ?? 1, maxDelayMs: options.merge?.maxDelayMs ?? 30_000 },
    deadlines: { ackMs: options.ackMs ?? ACK_DEADLINE_MS },
    spoolRootDir: spoolRoot,
  });
  const store =
    options.store ??
    new MemoryProjectionStore({ clock: time, digest: sha256Digest, capacity, lifecycle: PLANES_LIFECYCLE });
  const admission = options.admission ?? new AdmissionController(capacity);
  const generation = options.generation ?? `gen-planes-${seed}`;
  const entryRefs = entryRefsFor(generation);
  const contentDocId = entryRefs.contentDocIds[0];
  const runtimeDocId = entryRefs.runtimeDocId;

  const lease = await store.acquireWriter(key, "planes-bootstrap", BOOTSTRAP_TTL_MS);
  const record: SyncGenerationRecord = {
    scopeKey: key,
    generation,
    acpSessionId: "acp-planes",
    loadId: "load-planes",
    state: "staging",
    importEndOrdinal: null,
    entryRefs,
    createdAt: time.now(),
  };
  await store.createGeneration({ scopeKey: key, epoch: lease.epoch, generation: record });
  await store.commitGeneration({
    scopeKey: key,
    epoch: lease.epoch,
    expectedCurrent: null,
    newGeneration: record,
    retired: [],
    entryClosure: entryRefs,
    expectedPointerRevision: 0,
  });
  await store.createDoc({
    scopeKey: key,
    epoch: lease.epoch,
    doc: activeDocRecord({
      scopeKey: key,
      generation,
      docId: contentDocId,
      kind: "content",
      snapshot: emptyDocBytes(),
    }),
  });
  await store.createDoc({
    scopeKey: key,
    epoch: lease.epoch,
    doc: activeDocRecord({
      scopeKey: key,
      generation,
      docId: runtimeDocId,
      kind: "runtime",
      snapshot: emptyDocBytes(),
    }),
  });
  // 引导租约在返回前已过期：用例可据此验证「旧 epoch 的写入被 fencing 拒绝」。
  time.advance(BOOTSTRAP_TTL_MS + 1);

  const harness = new PlaneHarnessImpl(
    scope,
    key,
    store,
    admission,
    time,
    config,
    generation,
    contentDocId,
    runtimeDocId,
    entryRefs,
    lease,
    spoolRoot,
    // 谁创建临时目录谁负责清理：注入自定义 store 不改变暂存目录的归属（否则 T08 的每次注入都会漏一个临时目录）。
    options.spoolRoot === undefined,
  );
  if (options.connect !== false) {
    await harness.connect("primary", { seed: `${seed}-primary` });
  }
  return harness;
}
