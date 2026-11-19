import * as Y from "yjs";
import { contentStatsOverflow } from "../capacity/content-doc-limits";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { boundaryPayload } from "./boundary-index";
import { captureSlice } from "./change-capture";
import { type Cursor, type Identity, RUNTIME_KIND, type Slice } from "./live-writer-internal";
import {
  buildLiveRecord,
  buildNextLiveRecord,
  buildTerminalRecords,
  descriptorOf,
  entityOf,
} from "./live-writer-records";
import type { LiveInput, LiveRecordValue, LiveWriterOptions } from "./live-writer-types";
import { createRuntimeDoc, type RuntimeEntityRecord } from "./runtime-doc";
import { bytes, records, requireObject, requireString } from "./writer-support";

type Semantic = NonNullable<LiveInput["semantic"]>;

/** 容量预演产出的记录与实体动作；实际写入只消费这份计划，不能重新生成描述符。 */
export interface SemanticWritePlan {
  readonly contentRecords: readonly LiveRecordValue[];
  readonly entity: RuntimeEntityRecord | string;
  readonly rotateContent: boolean;
  readonly overflow: string | null;
  readonly runtimeInitialState?: Uint8Array;
}

/** 用指标上界与紧凑实体预演，临近硬限才复制历史；拒绝前不得改变真实游标或封口。 */
export function planSemanticWrite(input: {
  readonly semantic: Semantic;
  readonly entryId: string;
  readonly boundaryOrdinal: number | null;
  readonly content: Cursor;
  readonly runtime: Cursor;
  readonly rotateRuntime: boolean;
  readonly options: LiveWriterOptions;
}): SemanticWritePlan {
  const current = input.content;
  const terminal =
    input.semantic.kind === "final" ||
    input.semantic.payload.finalDescriptor !== undefined ||
    input.semantic.payload.terminal === true;
  const softRotation =
    terminal &&
    encodedUpperBound(current.doc) >= input.options.limits.softRotateBytes &&
    exactSize(current.doc) >= input.options.limits.softRotateBytes;
  const runtime = new Y.Doc();
  const target = createRuntimeDoc(RUNTIME_KIND, input.options.limits, runtime);
  try {
    for (const entity of createRuntimeDoc(RUNTIME_KIND, input.options.limits, input.runtime.doc).exportForRotation())
      target.upsertEntity(entity);
    const runtimeInitialState = input.rotateRuntime ? Y.encodeStateAsUpdate(runtime) : undefined;
    const attempt = (rotateContent: boolean): SemanticWritePlan => {
      const fresh = rotateContent ? new Y.Doc() : null;
      try {
        const plan = buildSemanticRecords(
          input.semantic,
          input.entryId,
          input.boundaryOrdinal,
          fresh ?? current.doc,
          input.options,
        );
        const overflow = semanticContentOverflow(plan.contentRecords, current, rotateContent, input.options);
        return { ...plan, rotateContent, overflow, runtimeInitialState };
      } finally {
        fresh?.destroy();
      }
    };
    let plan = attempt(softRotation);
    if (plan.overflow !== null && !softRotation && plan.contentRecords.length > 0) plan = attempt(true);
    if (plan.overflow !== null) return plan;
    if (typeof plan.entity === "string") target.removeEntity(plan.entity);
    else {
      target.upsertEntity(plan.entity);
      const entity = runtime.getMap<RuntimeEntityRecord>(RUNTIME_KIND).get(plan.entity.entityId);
      if (entity) plan = { ...plan, entity };
    }
    const candidateBytes = Y.encodeStateAsUpdate(runtime).byteLength;
    const upper = input.rotateRuntime
      ? candidateBytes + 32
      : encodedUpperBound(input.runtime.doc) + candidateBytes + 32;
    let runtimeBytes = upper;
    if (upper > input.options.limits.hardLimitBytes && !input.rotateRuntime) {
      runtimeBytes = exactCandidateSize(input.runtime.doc, (doc) => {
        const candidate = createRuntimeDoc(RUNTIME_KIND, input.options.limits, doc);
        if (typeof plan.entity === "string") candidate.removeEntity(plan.entity);
        else candidate.upsertEntity(plan.entity);
      });
    }
    return {
      ...plan,
      overflow: runtimeBytes > input.options.limits.hardLimitBytes ? "runtime snapshot exceeds hard limit" : null,
    };
  } finally {
    runtime.destroy();
  }
}

/** WeakMap 只持有固定大小计数；增量相加是整篇编码的保守上界，不保存快照或正文。 */
const ENCODED_BOUNDS = new WeakMap<Y.Doc, { bytes: number }>();
function encodedUpperBound(doc: Y.Doc): number {
  let bound = ENCODED_BOUNDS.get(doc);
  if (!bound) {
    bound = { bytes: Y.encodeStateAsUpdate(doc).byteLength };
    ENCODED_BOUNDS.set(doc, bound);
    const observed = bound;
    doc.on("update", (update: Uint8Array) => {
      observed.bytes += update.byteLength;
    });
  }
  return bound.bytes;
}

/** 临近硬限才精确编码，并校准累计上界，避免旧 delete set 被反复累计。 */
function exactSize(doc: Y.Doc): number {
  encodedUpperBound(doc);
  const size = Y.encodeStateAsUpdate(doc).byteLength;
  const bound = ENCODED_BOUNDS.get(doc);
  if (bound) bound.bytes = size;
  return size;
}

/** 当前 clientID 必须沿用，才能精确包含实际 append 的 varint 与 struct 开销。 */
function exactCandidateSize(source: Y.Doc, mutate: (doc: Y.Doc) => void): number {
  const snapshot = Y.encodeStateAsUpdate(source);
  encodedUpperBound(source);
  const bound = ENCODED_BOUNDS.get(source);
  if (bound) bound.bytes = snapshot.byteLength;
  const candidate = new Y.Doc();
  try {
    Y.applyUpdate(candidate, snapshot);
    candidate.clientID = source.clientID;
    mutate(candidate);
    return Y.encodeStateAsUpdate(candidate).byteLength;
  } finally {
    candidate.destroy();
  }
}

/** 记录与 payload 每次重扫，公开 commit 的任意合法 Yjs 更新也不能绕过旧记录校验。 */
function semanticContentOverflow(
  values: readonly LiveRecordValue[],
  current: Cursor,
  rotate: boolean,
  options: LiveWriterOptions,
): string | null {
  if (values.length === 0) return null;
  const candidate = new Y.Doc();
  try {
    // 新块的实际随机 clientID 至多 32 位；最大 varint 避免 fresh 预演低估编码长度。
    candidate.clientID = 0xffffffff;
    records(candidate, values);
    const standaloneBytes = Y.encodeStateAsUpdate(candidate).byteLength;
    let encodedBytes = rotate ? standaloneBytes : encodedUpperBound(current.doc) + standaloneBytes + 32;
    const hard = Math.min(MAX_DOC_SNAPSHOT_BYTES, options.capacity.inputs.activeHardEncodedBytes);
    if (!rotate && encodedBytes > hard) encodedBytes = exactCandidateSize(current.doc, (doc) => records(doc, values));
    const existing = rotate ? [] : (records<unknown>(current.doc)?.toArray() ?? []);
    return contentStatsOverflow(
      {
        encodedBytes,
        recordCount: existing.length + values.length,
        maxPayloadBytes: Math.max(maxPayloadBytes(existing), maxPayloadBytes(values)),
        lastSeq: (rotate ? 0 : current.lastSeq) + 1,
      },
      options.capacity,
    );
  } finally {
    candidate.destroy();
  }
}

/** 对公开 commit 带来的任意 canonical 值沿用 Store 的 payload 识别边界。 */
function maxPayloadBytes(values: readonly unknown[]): number {
  let maximum = 0;
  for (const value of values) {
    if (typeof value !== "object" || value === null) continue;
    const payload = (value as { readonly payload?: unknown }).payload;
    if (payload instanceof Uint8Array) maximum = Math.max(maximum, payload.byteLength);
  }
  return maximum;
}

/** 描述符与实体删除共享同一 slices 集合，由调用方一次 append。 */
export function applySemanticWrite(
  plan: Pick<SemanticWritePlan, "contentRecords" | "entity">,
  content: Cursor,
  runtime: Cursor,
  options: Pick<LiveWriterOptions, "limits">,
): Slice[] {
  const slices: Slice[] = [];
  if (plan.contentRecords.length > 0) captureSlice(slices, content, () => records(content.doc, plan.contentRecords));
  const target = createRuntimeDoc(RUNTIME_KIND, options.limits, runtime.doc);
  captureSlice(slices, runtime, () => {
    if (typeof plan.entity === "string") target.removeEntity(plan.entity);
    else target.upsertEntity(plan.entity);
  });
  return slices;
}

/** 语义内容身份只依赖所选块的已提交前沿，预演失败时不留下 live struct。 */
function buildSemanticRecords(
  semantic: Semantic,
  entryId: string,
  boundaryOrdinal: number | null,
  doc: Y.Doc,
  options: LiveWriterOptions,
): Pick<SemanticWritePlan, "contentRecords" | "entity"> {
  const entityId = requireString(semantic.payload, "entityId");
  const contentRecords: LiveRecordValue[] = [];
  if (boundaryOrdinal !== null) {
    const identity: Identity = { entryId, contentSlot: "boundary", contentType: "tool-boundary" };
    contentRecords.push(
      buildLiveRecord(
        options.random,
        identity,
        "tool_boundary",
        boundaryPayload(entityId, boundaryOrdinal),
        boundaryOrdinal,
      ),
    );
  }
  if (semantic.kind === "final" || semantic.payload.finalDescriptor !== undefined) {
    const identity: Identity = { entryId: entityId, contentSlot: "final", contentType: "final-descriptor" };
    contentRecords.push(
      buildNextLiveRecord(
        options.random,
        doc,
        identity,
        "final",
        bytes(JSON.stringify(descriptorOf(semantic.payload, entityId))),
      ),
    );
    return { contentRecords, entity: entityId };
  }
  if (semantic.payload.terminal === true) {
    const metadata =
      semantic.payload.metadata === undefined ? {} : requireObject(semantic.payload.metadata, "metadata");
    contentRecords.push(
      ...buildTerminalRecords({
        random: options.random,
        digest: options.digest,
        doc,
        entityId,
        kind: semantic.kind,
        metadata,
        completedAt: options.clock.now(),
      }),
    );
    return { contentRecords, entity: entityId };
  }
  return { contentRecords, entity: entityOf(semantic.kind, semantic.payload) };
}
