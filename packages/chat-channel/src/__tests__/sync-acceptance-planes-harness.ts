// T08–T12 验收连接与调度实现；类型及引导入口由 oracle 文件统一导出。
import { rm } from "node:fs/promises";
import * as Y from "yjs";
import type { AdmissionController } from "../sync/capacity/admission";
import type { DocHub } from "../sync/client/doc-hub";
import { createSyncClientTransport, type SyncClientTransport } from "../sync/client/transport";
import { deterministicRandomSource, sha256Digest } from "../sync/clock";
import type { ImportStatus } from "../sync/history/import-service";
import type { HistoryRecordMeta, IngestedRecord } from "../sync/history/ingest";
import {
  decodeSyncFrame,
  encodeSyncFrame,
  type HelloFrame,
  type SubscribeFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../sync/protocol/frames";
import type { DocKind, SyncScope } from "../sync/protocol/identity";
import type { SyncRuntimeConfig } from "../sync/runtime/config";
import type { SyncFrameGateway } from "../sync/runtime/egress";
import type { SyncIngressEvent } from "../sync/runtime/ingress";
import { createSyncScopeRuntime, type SyncScopeRuntime } from "../sync/runtime/scope-runtime";
import type { GenerationEntryRefs, ProjectionStore, WriterLease } from "../sync/store/types";
import {
  DeliveryAudit,
  DeliveryTrace,
  type FlatRecord,
  PlaneLink,
  PlaneMirror,
  type RuntimeEntityView,
  readRecords,
  readRuntimeEntities,
  TextLog,
  type WireRecord,
} from "./sync-acceptance-planes-observation";
import type { PlaneConnection, PlaneDirectoryBlock, PlaneHarness } from "./sync-acceptance-planes-oracle";
import { type CommittedDocRow, committedStateOf, type PlaneClock, TEXT_SLOT } from "./sync-acceptance-planes-store";

/** 每轮的 pump 上限：静止判定靠「本轮没有帧流动」，这个数字只防止实现缺陷造成死循环。 */
const MAX_PUMP_ROUNDS = 32;
/** 单 Doc 增量读取上限：验收数据集远小于它，取大值以避免把「截断」误判成「内容缺失」。 */
const UPDATE_READ_LIMIT = 100_000;

class PlaneConnectionImpl implements PlaneConnection {
  readonly link: PlaneLink;
  readonly mirror = new PlaneMirror();
  readonly audit = new DeliveryAudit();
  readonly applied = new DeliveryTrace();
  readonly fatal: { code: string; detail: string | undefined }[] = [];
  readonly control: SyncFrame[] = [];
  readonly hub: DocHub;
  private boundGateway: SyncFrameGateway | null = null;

  constructor(
    readonly label: string,
    readonly runtime: SyncScopeRuntime,
    link: PlaneLink,
    private readonly harness: PlaneHarnessImpl,
  ) {
    this.link = link;
    this.hub = this.client.hub;
  }

  /** 运行时只允许绑定一次端口，故网关在构造之后注入。 */
  attachGateway(gateway: SyncFrameGateway): void {
    this.boundGateway = gateway;
  }
  /** 见 {@link PlaneConnection.gateway}。 */
  get gateway(): SyncFrameGateway {
    if (this.boundGateway === null) throw new Error(`连接 ${this.label} 未绑定网关`);
    return this.boundGateway;
  }

  readonly client: SyncClientTransport = createSyncClientTransport({
    // 假时钟 + 立即兑现的让出点：验收不等待墙钟，但保留「分片之间让出执行权」的调用点。
    send: (bytes) => this.link.sendFromClient(bytes),
    now: () => this.harness.time.now(),
    yieldToHost: () => Promise.resolve(),
    onControl: (frame) => this.control.push(frame),
    onFatal: (code, detail) => this.fatal.push({ code, detail }),
  });
  /** 见 {@link PlaneConnection.handshake}。 */
  async handshake(input?: { generation?: string; loadedDocs?: readonly string[] }): Promise<void> {
    const generation = input?.generation ?? (await this.harness.currentGeneration());
    const frame: HelloFrame = {
      type: "HELLO",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      scope: this.harness.scope,
      generation,
      loadedDocs: (input?.loadedDocs ?? []).map((docId) => ({ docId })),
      stateful: false,
    };
    await this.sendFrameNow(frame);
    await this.harness.pump();
  }
  /** 见 {@link PlaneConnection.subscribe}。 */
  async subscribe(docIds?: readonly string[], priority: SubscribeFrame["priority"] = "live"): Promise<void> {
    const target = docIds ?? (await this.harness.contentDocIds());
    for (const docId of target) this.hub.retain(docId);
    const frame: SubscribeFrame = {
      type: "SUBSCRIBE",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docIds: [...target],
      priority,
    };
    await this.sendFrameNow(frame);
    await this.harness.pump();
  }
  /** 见 {@link PlaneConnection.acceptIngress}。 */
  async acceptIngress(event: SyncIngressEvent): Promise<void> {
    await this.runtime.acceptIngress(event);
  }
  /** 见 {@link PlaneConnection.writeText}。 */
  async writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void> {
    const turnId = key?.turnId ?? "turn-1";
    const event: SyncIngressEvent = {
      kind: "text-delta",
      turnId,
      entryId: key?.entryId ?? `${turnId}:assistant`,
      contentSlot: key?.contentSlot ?? TEXT_SLOT,
      contentType: "text/plain",
      delta,
    };
    this.harness.log.push(event);
    await this.acceptIngress(event);
    await this.harness.pump();
  }
  /** 见 {@link PlaneConnection.writeSemantic}。 */
  async writeSemantic(kind: string, payload: Record<string, unknown>, turnId = "turn-1"): Promise<void> {
    const event: SyncIngressEvent = {
      kind: "semantic",
      turnId,
      entryId: `${turnId}:assistant`,
      contentSlot: TEXT_SLOT,
      contentType: "text/plain",
      semantic: { kind: kind as "tool", payload },
    };
    await this.acceptIngress(event);
    await this.harness.pump();
  }
  /** 见 {@link PlaneConnection.sendFrameNow}。 */
  async sendFrameNow(frame: SyncFrame): Promise<void> {
    await this.runtime.onInboundBytes(encodeSyncFrame(frame));
  }

  paused = false;
  /** 见 {@link PlaneConnection.pause}。 */
  pause(): void {
    this.paused = true;
  }
  /** 见 {@link PlaneConnection.resume}。 */
  resume(): void {
    this.paused = false;
  }
  /** 见 {@link PlaneConnection.dispose}。 */
  async dispose(): Promise<void> {
    this.client.dispose();
    await this.runtime.dispose();
  }
}

/** 调度真实连接、存储读取与历史导入的单 scope 验收夹具。 */
export class PlaneHarnessImpl implements PlaneHarness {
  readonly log = new TextLog();
  private readonly attached: PlaneConnectionImpl[] = [];

  constructor(
    readonly scope: SyncScope,
    readonly scopeKey: string,
    readonly store: ProjectionStore,
    readonly admission: AdmissionController,
    readonly time: PlaneClock,
    readonly config: SyncRuntimeConfig,
    readonly seedGeneration: string,
    readonly seedContentDocId: string,
    readonly seedRuntimeDocId: string,
    readonly seedEntryRefs: GenerationEntryRefs,
    readonly bootstrapLease: WriterLease,
    readonly spoolRoot: string,
    private readonly ownedSpoolRoot: boolean,
  ) {}
  /** 见 {@link PlaneHarness.connections}。 */
  get connections(): readonly PlaneConnection[] {
    return this.attached;
  }
  /** 见 {@link PlaneHarness.primary}。 */
  get primary(): PlaneConnection | null {
    return this.attached[0] ?? null;
  }
  /** 见 {@link PlaneHarness.connect}。 */
  async connect(label: string, options?: { readonly seed?: string }): Promise<PlaneConnection> {
    const runtime = await createSyncScopeRuntime({
      scope: this.scope,
      config: this.config,
      clock: this.time,
      digest: sha256Digest,
      random: deterministicRandomSource(options?.seed ?? `${label}-runtime`),
      store: this.store,
      admission: this.admission,
    });
    // `attachTransport` 每个 scope 只允许绑定一次，因此必须先建 link 与连接对象，再完成绑定。
    const link = new PlaneLink();
    const connection = new PlaneConnectionImpl(label, runtime, link, this);
    const gateway = runtime.attachTransport(link);
    connection.attachGateway(gateway);
    this.attached.push(connection);
    return connection;
  }
  /** 见 {@link PlaneHarness.round}。 */
  async round(): Promise<number> {
    let moved = 0;
    for (const connection of this.attached) {
      moved += await this.roundOf(connection);
    }
    return moved;
  }

  private async roundOf(connection: PlaneConnectionImpl): Promise<number> {
    let moved = 0;
    while (connection.link.outbound.length > 0) {
      const bytes = connection.link.outbound.shift();
      if (bytes === undefined) break;
      moved += 1;
      const record: WireRecord = { direction: "server-to-client", frame: decodeSyncFrame(bytes), bytes };
      connection.audit.recordOutbound(record);
      if (connection.link.dropOutbound?.(record.frame) === true) continue;
      const frame = record.frame;
      if (frame.type === "DOC_BASE" || frame.type === "DOC_UPDATE") {
        connection.audit.noteEpoch(frame.transportEpoch);
        connection.mirror.applyFrame(frame);
        if (frame.type === "DOC_BASE") connection.applied.noteBase(frame.docId, frame.deliveryId, frame.baseSeq);
        else connection.applied.noteUpdate(frame.docId, frame.deliveryId, frame.fromSeq, frame.toSeq);
      }
      connection.client.onFrame(bytes);
    }
    if (!connection.paused) await connection.client.drain();
    while (connection.link.inbound.length > 0) {
      const bytes = connection.link.inbound.shift();
      if (bytes === undefined) break;
      moved += 1;
      const record: WireRecord = { direction: "client-to-server", frame: decodeSyncFrame(bytes), bytes };
      const duplicate = connection.link.duplicateInbound?.(record.frame) === true;
      // 链路丢帧：这一帧从未到达服务端，因此既不算「实际派发过的入站帧」，也不得进回执账目——
      // 否则「丢了 ACK」在观测里会表现成「已结清」，T10 的账目断言就变成了恒真。
      if (connection.link.dropInbound?.(record.frame) === true) continue;
      connection.audit.recordInbound(record);
      connection.link.observedInbound.push(record.frame);
      await connection.runtime.onInboundBytes(bytes);
      if (duplicate) {
        // 重复注入走同一条派发路径：线上真值就是「服务端看到同一帧两次」。
        connection.link.observedInbound.push(record.frame);
        await connection.runtime.onInboundBytes(bytes);
      }
    }
    await connection.runtime.tick();
    return moved;
  }
  /** 见 {@link PlaneHarness.pump}。 */
  async pump(): Promise<void> {
    for (let index = 0; index < MAX_PUMP_ROUNDS; index += 1) {
      const moved = await this.round();
      if (moved === 0 && this.isQuiet()) return;
    }
    throw new Error(`planes acceptance pump did not settle within ${MAX_PUMP_ROUNDS} rounds`);
  }

  /**
   * 静止判定必须同时看两个方向：`tick` 在轮次末尾产出的帧落在 `outbound` 里、要到下一轮才交付，
   * 只看「本轮搬运数 0」会在一帧刚产出时就宣告静止，把服务端还没来得及发出的字节留在队列里。
   */
  private isQuiet(): boolean {
    return this.attached.every(
      (connection) => connection.link.outbound.length === 0 && connection.link.inbound.length === 0,
    );
  }
  /** 见 {@link PlaneHarness.settle}。 */
  async settle(): Promise<number> {
    let moved = 0;
    for (let index = 0; index < MAX_PUMP_ROUNDS; index += 1) {
      const round = await this.round();
      moved += round;
      if (round === 0) return moved;
    }
    throw new Error(`planes acceptance settle did not converge within ${MAX_PUMP_ROUNDS} rounds`);
  }
  /** 见 {@link PlaneHarness.writeText}。 */
  async writeText(delta: string, key?: { turnId?: string; entryId?: string; contentSlot?: string }): Promise<void> {
    await this.requirePrimary().writeText(delta, key);
  }
  /** 见 {@link PlaneHarness.writeSemantic}。 */
  async writeSemantic(kind: string, payload: Record<string, unknown>, turnId?: string): Promise<void> {
    await this.requirePrimary().writeSemantic(kind, payload, turnId);
  }

  private requirePrimary(): PlaneConnection {
    const primary = this.primary;
    if (primary === null) throw new Error("oracle: harness has no connection");
    return primary;
  }
  /** 见 {@link PlaneHarness.canonicalBytes}。 */
  async canonicalBytes(docId: string): Promise<Uint8Array> {
    const base = await this.store.readDocStateAt(docId, 0);
    if (base === null) throw new Error(`oracle: doc ${docId} has no committed baseline at seq 0`);
    const doc = new Y.Doc();
    Y.applyUpdate(doc, base.snapshot);
    const updates = await this.store.readUpdatesAfter(docId, 0, UPDATE_READ_LIMIT);
    for (const update of updates) Y.applyUpdate(doc, update.bytes);
    return Y.encodeStateAsUpdate(doc);
  }
  /** 见 {@link PlaneHarness.canonicalRecords}。 */
  async canonicalRecords(docId: string): Promise<FlatRecord[]> {
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.canonicalBytes(docId));
    return readRecords(doc);
  }
  /** 见 {@link PlaneHarness.runtimeEntities}。 */
  async runtimeEntities(docId?: string): Promise<RuntimeEntityView[]> {
    const target = docId ?? this.seedRuntimeDocId;
    const doc = new Y.Doc();
    Y.applyUpdate(doc, await this.canonicalBytes(target));
    return readRuntimeEntities(doc);
  }
  /** 见 {@link PlaneHarness.docsOfKind}。 */
  docsOfKind(kind: DocKind): CommittedDocRow[] {
    return this.allDocRows()
      .filter((row) => row.kind === kind)
      .sort((left, right) => (left.blockIndex ?? 0) - (right.blockIndex ?? 0));
  }
  /** 见 {@link PlaneHarness.allDocRows}。 */
  allDocRows(): CommittedDocRow[] {
    return committedStateOf(this.store).docs.map((row) => ({
      docId: row.docId,
      kind: row.kind,
      state: row.state,
      hash: row.hash,
      blockIndex: row.blockIndex,
      ordinalStart: row.ordinalStart,
      ordinalEnd: row.ordinalEnd,
      finalSeq: row.finalSeq,
    }));
  }
  /** 见 {@link PlaneHarness.generationState}。 */
  async generationState(generation: string): Promise<string> {
    const record = await this.store.readGeneration(this.scopeKey, generation);
    return record?.state ?? "unknown";
  }
  /** 见 {@link PlaneHarness.currentGeneration}。 */
  async currentGeneration(): Promise<string> {
    const pointer = await this.store.readScopePointer(this.scopeKey);
    return pointer?.currentGeneration ?? this.seedGeneration;
  }
  /** 见 {@link PlaneHarness.currentEntryRefs}。 */
  async currentEntryRefs(): Promise<GenerationEntryRefs> {
    const record = await this.store.readGeneration(this.scopeKey, await this.currentGeneration());
    if (record === null) throw new Error("oracle: current generation record is missing");
    return record.entryRefs;
  }
  /** 见 {@link PlaneHarness.currentPointerRevision}。 */
  async currentPointerRevision(): Promise<number> {
    const pointer = await this.store.readScopePointer(this.scopeKey);
    return pointer?.pointerRevision ?? 0;
  }
  /** 见 {@link PlaneHarness.contentDocIds}。 */
  async contentDocIds(): Promise<string[]> {
    const record = await this.store.readGeneration(this.scopeKey, await this.currentGeneration());
    return record === null ? [] : [...record.entryRefs.contentDocIds];
  }
  /** 见 {@link PlaneHarness.directoryBlocks}。 */
  async directoryBlocks(generation?: string): Promise<PlaneDirectoryBlock[]> {
    const target = generation ?? (await this.currentGeneration());
    const page = await this.store.readDirectory({ generation: target, limit: 2048 });
    const blocks: PlaneDirectoryBlock[] = [];
    for (const entry of [...page.entries].sort((left, right) => left.ordinalStart - right.ordinalStart)) {
      const doc = new Y.Doc();
      const base = await this.store.readDocStateAt(entry.docId, 0);
      if (base === null) throw new Error(`oracle: sealed block ${entry.docId} has no committed baseline`);
      Y.applyUpdate(doc, base.snapshot);
      blocks.push({
        docId: entry.docId,
        ordinalStart: entry.ordinalStart,
        ordinalEnd: entry.ordinalEnd,
        records: readRecords(doc),
      });
    }
    return blocks;
  }
  /** 见 {@link PlaneHarness.coverage}。 */
  async coverage(generation?: string): Promise<{ gaps: number[]; duplicates: number[]; maxOrdinal: number }> {
    const blocks = await this.directoryBlocks(generation);
    const seen = new Map<number, number>();
    let maxOrdinal = 0;
    for (const block of blocks) {
      for (let ordinal = block.ordinalStart; ordinal <= block.ordinalEnd; ordinal += 1) {
        seen.set(ordinal, (seen.get(ordinal) ?? 0) + 1);
        maxOrdinal = Math.max(maxOrdinal, ordinal);
      }
    }
    const gaps: number[] = [];
    const duplicates: number[] = [];
    for (let ordinal = 1; ordinal <= maxOrdinal; ordinal += 1) {
      const count = seen.get(ordinal) ?? 0;
      if (count === 0) gaps.push(ordinal);
      if (count > 1) duplicates.push(ordinal);
    }
    return { gaps, duplicates, maxOrdinal };
  }
  /** 见 {@link PlaneHarness.flatRecords}。 */
  async flatRecords(): Promise<FlatRecord[]> {
    const blocks = await this.directoryBlocks();
    return blocks.flatMap((block) => block.records);
  }
  /** 见 {@link PlaneHarness.history}。 */
  history(): SyncScopeRuntime["history"] {
    return this.requirePrimary().runtime.history;
  }
  /** 见 {@link PlaneHarness.beginImport}。 */
  async beginImport(input?: { readonly owner?: string; readonly leaseTtlMs?: number }): Promise<{
    loadId: string;
    generation: string;
  }> {
    return await this.history().begin({
      scope: this.scope,
      acpSessionId: "acp-planes",
      owner: input?.owner ?? "planes-importer",
      leaseTtlMs: input?.leaseTtlMs ?? 120_000,
    });
  }
  /** 见 {@link PlaneHarness.acceptHistory}。 */
  async acceptHistory(value: unknown, meta: HistoryRecordMeta): Promise<IngestedRecord> {
    return await this.history().accept(value, meta);
  }
  /** 见 {@link PlaneHarness.acceptHistoryText}。 */
  async acceptHistoryText(
    text: string,
    key: { readonly entryId: string; readonly contentSlot?: number; readonly partIndex?: number },
  ): Promise<IngestedRecord> {
    return await this.acceptHistory(text, {
      kind: "text_part",
      entryId: key.entryId,
      contentSlot: key.contentSlot ?? 0,
      partIndex: key.partIndex ?? 0,
    });
  }
  /** 见 {@link PlaneHarness.importStatus}。 */
  importStatus(): ImportStatus | null {
    return this.attached.length > 0 ? this.history().status() : null;
  }
  /** 见 {@link PlaneHarness.queueClientFrame}。 */
  queueClientFrame(connection: PlaneConnection, frame: SyncFrame): void {
    connection.link.inbound.push(encodeSyncFrame(frame));
  }
  /** 见 {@link PlaneHarness.finishImport}。 */
  async finishImport(): Promise<{ outcome: string; generation: string; pointerRevision: number }> {
    const service = this.history();
    await service.receivingComplete();
    await service.buildAndCommit();
    return await service.finalize();
  }
  /** 见 {@link PlaneHarness.disposeAll}。 */
  async disposeAll(): Promise<void> {
    for (const connection of [...this.attached]) {
      await connection.dispose();
    }
    this.attached.length = 0;
    if (this.ownedSpoolRoot) {
      await rm(this.spoolRoot, { recursive: true, force: true });
    }
  }
}
