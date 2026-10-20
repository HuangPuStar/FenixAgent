// packages/chat-channel/src/sync/live/runtime-doc.ts
// 运行态 Doc：工具、权限、错误与取消实体的存活状态（设计 §6.2 / §6.3 / §10.2「运行态」行）。
//
// 运行态只保留「未结束」与「交接未完成」的实体：实体完成时由调用方把 final record、固定大小
// 终态描述符与定位索引同事务持久化，之后才允许 `removeEntity`。大载荷（工具参数/结果）外置到
// 内容块，运行态体积因此只由未结束实体数 × 每实体元数据决定。
// 三重写入期上限（实体数 256、单实体元数据 1KiB、存活载荷 64KiB）越界立刻抛容量错误，而不是让
// active 状态随无限创建的工具增长（设计 §6.2「源无限创建未结束工具时触发容量错误」）。
// 软/硬字节是**编码状态**上限：本模块只报软水位，硬限与封口由写入路径负责——只有它知道未提交批次边界。
// 存态按 JSON 投影：上限以 JSON 字节计，直接存调用方对象引用会让之后的原地改写绕过上限，也会让
// `encodedBytes` 无声变化；非 JSON 值（BigInt、循环引用）在写入时暴露原始 TypeError，不静默降级。

import * as Y from "yjs";
import { SyncProtocolError } from "../protocol/errors";
import { MAX_DOC_SNAPSHOT_BYTES } from "../protocol/frames";
import { assertIdentifier, type DocKind } from "../protocol/identity";

/** 运行态实体类型：终态是实体状态而非类型，因此 `final` 不在取值内。 */
export type RuntimeEntityKind = "tool" | "permission" | "error" | "cancel";

const RUNTIME_ENTITY_KINDS: ReadonlySet<string> = new Set<RuntimeEntityKind>(["tool", "permission", "error", "cancel"]);

const UTF8_ENCODER = new TextEncoder();

export interface RuntimeEntityRecord {
  readonly entityId: string;
  readonly kind: RuntimeEntityKind;
  readonly toolCallId?: string;
  /** 元数据 ≤1KiB（设计 §6.3），超出部分必须外置为内容块。 */
  readonly metadata: Record<string, unknown>;
  readonly state: "open" | "final";
  readonly finalDescriptor?: FinalEntityDescriptor;
}

/** 固定大小终态描述符；大载荷经 `contentRef` 定位（设计 §6.2）。 */
export interface FinalEntityDescriptor {
  readonly entityId: string;
  readonly kind: RuntimeEntityKind;
  readonly contentRef: string;
  readonly digest: string;
  readonly byteLength: number;
  readonly completedAt: number;
}

export interface RuntimeDocLimits {
  readonly maxLivePayloadBytes: number; // 64KiB
  readonly maxEntities: number; // 256
  readonly maxEntityMetadataBytes: number; // 1KiB
  readonly softRotateBytes: number; // 128KiB
  readonly hardLimitBytes: number; // 由 MAX_DOC_SNAPSHOT_BYTES 派生
}

/**
 * 运行态 Doc 的初始验收预算（设计 §6.3 / §10.2「运行态」行）：数值逐字落地，调参需评审记录。
 *
 * 存活载荷与实体数是**写入期**上限（本模块直接拒绝）；软/硬字节是**编码状态**上限，
 * 本模块只报软水位，硬限由写入路径在发布前检查。
 */
export const RUNTIME_DOC_LIMITS: RuntimeDocLimits = Object.freeze({
  maxLivePayloadBytes: 65536,
  maxEntities: 256,
  maxEntityMetadataBytes: 1024,
  softRotateBytes: 131072,
  hardLimitBytes: MAX_DOC_SNAPSHOT_BYTES,
});

/**
 * 控制 Doc 的固定入口预算（设计 §10.2「控制 Doc」行）：入口载荷 ≤8KiB，软 32KiB / 硬 64KiB。
 *
 * 字段名与 `RuntimeDocLimits` 刻意不同：控制 Doc 的载荷单位是「一条入口一个载荷」，不是实体表，
 * 同名共用会让两个口径被同一段代码误用。
 */
export const CONTROL_DOC_LIMITS: { entryBytes: 8192; softBytes: 32768; hardBytes: 65536 } = {
  // 写成字面量而非 `8 * 1024`：算术表达式推断为 `number`，无法赋给这里的字面量类型。
  entryBytes: 8192,
  softBytes: 32768,
  hardBytes: 65536,
};

export interface RuntimeDoc {
  upsertEntity(record: RuntimeEntityRecord): void;
  /**
   * 移除实体并返回其终态描述符（没有则 `null`）。
   *
   * 幂等：未登记的实体与没有描述符的实体都返回 `null`，调用方不得用 `null` 区分这两者——
   * 两者都意味着「没有可交接的定位信息」。移除时机由调用方保证（描述符与索引已持久化）。
   */
  removeEntity(entityId: string): FinalEntityDescriptor | null;
  /** 轮换时复制未结束与交接未完成的实体（设计 §6.3）。返回副本，改写不影响本文档。 */
  exportForRotation(): RuntimeEntityRecord[];
  /** 整篇编码字节数；按事务调用而非按增量调用，编码成本随文档线性增长。 */
  encodedBytes(): number;
  entityCount(): number;
  /** 达到软水位（编码状态）：轮换决策据此给出 `size-soft`。 */
  shouldRotate(): boolean;
}

function isRuntimeEntityKind(value: unknown): value is RuntimeEntityKind {
  return typeof value === "string" && RUNTIME_ENTITY_KINDS.has(value);
}

/** 实体类型只接受四种取值：恢复出的 JSON 与跨包入参都可能在类型之外，必须拦在写入前。 */
function assertRuntimeEntityKind(value: unknown): RuntimeEntityKind {
  if (!isRuntimeEntityKind(value)) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      message: "runtime entity kind must be one of tool, permission, error, cancel",
    });
  }
  return value;
}

/** 容量参数非法按容量配置的统一口径拒绝（ADMISSION_REJECTED），不引入第二种失败类型。 */
function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `runtime doc ${field} must be a positive integer, received ${String(value)}`,
    });
  }
}

function malformedRuntimeEntity(message: string): never {
  throw new SyncProtocolError("MALFORMED_FRAME", { message: `runtime entity ${message}` });
}

/** JSON 往返拷贝：存态与返回值都不与调用方共享引用（Yjs 感知不到原地改写）。 */
function cloneJsonRecord<T>(value: T): T {
  const copy: T = JSON.parse(JSON.stringify(value));
  return copy;
}

function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

/** 元数据按 JSON 投影存储，上限按投影字节计；大参数/结果必须外置为内容块。 */
function projectMetadata(metadata: unknown, limits: RuntimeDocLimits): Record<string, unknown> {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    malformedRuntimeEntity("metadata must be a JSON object");
  }
  const projected: Record<string, unknown> = JSON.parse(JSON.stringify(metadata));
  const bytes = utf8ByteLength(JSON.stringify(projected));
  if (bytes > limits.maxEntityMetadataBytes) {
    throw new SyncProtocolError("CAPACITY_EXCEEDED", {
      message:
        `runtime entity metadata is ${bytes} bytes, limit is ${limits.maxEntityMetadataBytes};` +
        " move the large payload into a content block",
    });
  }
  return projected;
}

/** 终态描述符必须属于同一实体同一种类型，否则客户端会把定位指向另一个实体的内容。 */
function projectDescriptor(descriptor: FinalEntityDescriptor, record: RuntimeEntityRecord): FinalEntityDescriptor {
  if (descriptor.entityId !== record.entityId) {
    malformedRuntimeEntity("final descriptor must belong to the same entity");
  }
  const kind = assertRuntimeEntityKind(descriptor.kind);
  if (kind !== record.kind) {
    malformedRuntimeEntity("final descriptor kind must match the entity kind");
  }
  assertIdentifier(descriptor.contentRef, "finalDescriptor.contentRef");
  assertIdentifier(descriptor.digest, "finalDescriptor.digest");
  if (!Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
    malformedRuntimeEntity("final descriptor byteLength must be a non-negative safe integer");
  }
  if (!Number.isFinite(descriptor.completedAt)) {
    malformedRuntimeEntity("final descriptor completedAt must be a finite timestamp");
  }
  return {
    entityId: descriptor.entityId,
    kind,
    contentRef: descriptor.contentRef,
    digest: descriptor.digest,
    byteLength: descriptor.byteLength,
    completedAt: descriptor.completedAt,
  };
}

/** 写入前的规范化：校验 + 投影 + 可选字段缺省不落库（缺省字段不占字节，也不出现在存态里）。 */
function projectEntity(record: RuntimeEntityRecord, limits: RuntimeDocLimits): RuntimeEntityRecord {
  const kind = assertRuntimeEntityKind(record.kind);
  assertIdentifier(record.entityId, "runtimeEntity.entityId");
  const toolCallId = record.toolCallId;
  if (toolCallId !== undefined) {
    assertIdentifier(toolCallId, "runtimeEntity.toolCallId");
  }
  if (record.state !== "open" && record.state !== "final") {
    malformedRuntimeEntity("state must be open or final");
  }
  const metadata = projectMetadata(record.metadata, limits);
  const finalDescriptor = record.finalDescriptor;
  // final 与描述符必须成对：设计 §6.2 要求 final record 与描述符同事务持久化，缺描述符的 final
  // 实体在客户端只会表现为「实体消失」；反过来 open 实体带描述符说明调用方把状态机搞错了。
  if (record.state === "final" && finalDescriptor === undefined) {
    malformedRuntimeEntity("final state requires a terminal descriptor");
  }
  if (record.state === "open" && finalDescriptor !== undefined) {
    malformedRuntimeEntity("open state must not carry a terminal descriptor");
  }
  return {
    entityId: record.entityId,
    kind,
    metadata,
    state: record.state,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(finalDescriptor === undefined ? {} : { finalDescriptor: projectDescriptor(finalDescriptor, record) }),
  };
}

/** 实体在文档里占的字节：按存态 JSON 计，元数据与固定大小描述符都属于存活载荷。 */
function entityBytes(record: RuntimeEntityRecord): number {
  return utf8ByteLength(JSON.stringify(record));
}

/**
 * 计入替换后的存活载荷。
 *
 * 每次全量重算而不是维护增量计数：实体数上限 256 使代价有界，且注入既有 Doc（崩溃恢复）时
 * 无需与旧计数对齐——增量计数在这里是纯风险。
 */
function livePayloadBytes(
  entities: Y.Map<RuntimeEntityRecord>,
  override: { entityId: string; bytes: number } | null,
): number {
  let total = 0;
  let replaced = false;
  entities.forEach((value, key) => {
    if (override !== null && key === override.entityId) {
      total += override.bytes;
      replaced = true;
      return;
    }
    total += entityBytes(value);
  });
  if (override !== null && !replaced) {
    total += override.bytes;
  }
  return total;
}

export function createRuntimeDoc(kind: DocKind, limits: RuntimeDocLimits, doc?: Y.Doc): RuntimeDoc {
  // 五处上限都靠数值比较执行：NaN 会让「超过上限」恒为 false 从而静默关闭全部保护，非正数上限也没有意义。
  // 与 merge-buffer / rotation 同口径，在构造期按容量配置拒绝，而不是留到第一次写入时才发现。
  assertPositiveInteger(limits.maxLivePayloadBytes, "maxLivePayloadBytes");
  assertPositiveInteger(limits.maxEntities, "maxEntities");
  assertPositiveInteger(limits.maxEntityMetadataBytes, "maxEntityMetadataBytes");
  assertPositiveInteger(limits.softRotateBytes, "softRotateBytes");
  assertPositiveInteger(limits.hardLimitBytes, "hardLimitBytes");
  const target = doc ?? new Y.Doc();
  // 根键取自 kind：同一个 Y.Doc 承载多种实体表时不会互相覆盖，注入既有 Doc 也不会撞键。
  const entities = target.getMap<RuntimeEntityRecord>(kind);

  return {
    upsertEntity(record) {
      const projected = projectEntity(record, limits);
      const existing = entities.get(projected.entityId);
      // final 是终态：乱序或重放的 provisional（open）更新不得把它降级。留在文档里的终态描述符是「交接未完成」
      // 的唯一证据（设计 §6.2/§6.3），被覆盖即永久丢失轮换要复制的交接位置，故整条忽略而不是部分合并。
      if (existing?.state === "final" && projected.state === "open") {
        return;
      }
      if (existing === undefined && entities.size >= limits.maxEntities) {
        throw new SyncProtocolError("CAPACITY_EXCEEDED", {
          message: `runtime doc ${kind} entity table is full (limit ${limits.maxEntities})`,
        });
      }
      const required = livePayloadBytes(entities, {
        entityId: projected.entityId,
        bytes: entityBytes(projected),
      });
      if (required > limits.maxLivePayloadBytes) {
        throw new SyncProtocolError("CAPACITY_EXCEEDED", {
          message:
            `runtime doc ${kind} live payload would reach ${required} bytes,` +
            ` limit is ${limits.maxLivePayloadBytes}`,
        });
      }
      entities.set(projected.entityId, projected);
    },
    removeEntity(entityId) {
      const stored = entities.get(entityId);
      if (stored === undefined) {
        return null;
      }
      entities.delete(entityId);
      return stored.finalDescriptor === undefined ? null : cloneJsonRecord(stored.finalDescriptor);
    },
    exportForRotation() {
      const exported: RuntimeEntityRecord[] = [];
      entities.forEach((stored) => {
        // 复制条件（设计 §6.3）：未结束，或终态描述符尚未交接完成。「交接完成」的唯一信号是
        // `removeEntity`——索引提交后调用方才会移除，因此留在文档里的实体都是必须带过去的。
        if (stored.state === "open" || stored.finalDescriptor !== undefined) {
          exported.push(cloneJsonRecord(stored));
        }
      });
      return exported;
    },
    encodedBytes() {
      return Y.encodeStateAsUpdate(target).byteLength;
    },
    entityCount() {
      return entities.size;
    },
    shouldRotate() {
      // 只用编码状态判软水位：设计 §6.3 明确「不能认为当前键少就永久复用一个 Doc」，
      // 反复设置/删除少量键同样积累 CRDT 成本，键数量因此不作依据。
      return Y.encodeStateAsUpdate(target).byteLength >= limits.softRotateBytes;
    },
  };
}
