// packages/chat-channel/src/sync/runtime/ingress.ts
// G1 实时入口适配器（接线规格 §2.3 / §3）：ACP 入站事件 → 中立入口事件 → 已编号记录 → LiveWriter。
//
// 编号语义（设计 §15.1 的实时 oracle 单位）：ingressSeq 从 1 起、严格递增、无洞，只在 `writer.accept`
// 成功后推进——写者抛错时既不推进序号也不留记录，否则 oracle 与写者实际输入会永久错位。编号在分派异步
// 写入**之前**分配（设计 §6.2「接收边界必须在分派异步任务之前编号」），并发 accept 经内部顺序队列串行化，
// 保证「编号顺序 = 写者接收顺序」。有界：`maxRecords` / `maxBytes` 是在飞与排队事件的 pending 预算，
// 额度在入队前的同步段预留，超限立刻抛 CAPACITY_EXCEEDED；成功接收的历史不再累计，`records()` 只是
// 最近 `diagnosticLimit` 条的有界诊断窗口（生产没有消费者，不得把它当作全量已接收历史）。
//
// 身份绑定（设计 §5「entryId / toolCallId 由已核实的源标识或 Fenix 边界映射生成」）：
// - turnId 只取自输入对象自身的 `turnId` 字段（relay 规范化事件的同名可选项，须由接线层补齐）；ACP 载荷
//   自身不带轮次标识，缺失时**不产事件**——凭空归属会把不同 prompt 的文本并进同一记录（合并键含 turnId）。
// - entryId 用 `${turnId}:assistant`，与 state/turn-machine.ts 的 turnAssistantEntryId 同一规则（sync 不得
//   import ../state，故此处复刻派生规则）；语义实体身份用源标识：工具 = toolCallId，权限 = permissionId /
//   requestId，轮次级屏障 = `${turnId}:${kind}`（同轮的 error 与 cancel 不互相覆盖）。
//
// 已知缺口（影响 + 移除条件）：
// ① 轮次正常结束（stopReason 非 cancelled）没有对应 BarrierKind：`final` 需要存储侧描述符（contentRef /
//    digest / byteLength / completedAt，live-writer 的 descriptorOf 强制校验），入口无法产出；移除条件＝
//    接线层把已提交内容的定位信息交给入口。错误与取消不受影响（映射为 error / cancel）。
// ② 非文本内容块（图片 / 资源链接 / 内嵌上下文）没有 LiveInput 表示：只在 `content.text`（或顶层 `text`）
//    是字符串时映射，其余返回空数组；移除条件＝内容块外置路径落地。
// ③ 工具参数/结果（rawInput / rawOutput）不进入运行态元数据（实体元数据上限 1KiB，设计要求大载荷外置为
//    内容块）：入口只承载身份与终态；移除条件＝内容块外置路径落地。
// ④ 权限选项列表不进入元数据：wire 形态是 `{ optionId, name, kind }`，三态映射归 state/permission.ts。
// ⑤ 用户消息回显（`user_message_chunk`）不映射：用户消息只由后端写入，同一 entry 再写一次会把正文写重。
// ⑥ 私有帧（acp-link 的 `{ type: "permission_request", payload }` 等）不属于本模块输入契约，需接线层先经
//    protocol/acp-channel.ts 的 `extractAcpEvent` 提取；本模块只吃 session/update 载荷及其 JSON-RPC 信封。

import type { BarrierKind, LiveWriter } from "../live/live-writer";
import { SyncProtocolError } from "../protocol/errors";
import { assertIdentifier } from "../protocol/identity";

/** 中立入口事件：不依赖 `../state` 的 `NormalizedEvent`，由接线层映射；与 `LiveInput` 结构同构，可直接交给 `LiveWriter.accept`。 */
export interface SyncIngressEvent {
  readonly kind: "text-delta" | "semantic";
  readonly turnId: string;
  readonly entryId: string;
  readonly contentSlot: string;
  readonly contentType: string;
  readonly delta?: string;
  /** 同 entryId + 槽位只允许提交一次（用户消息重试/多入口去重）。 */
  readonly idempotent?: boolean;
  readonly semantic?: { readonly kind: BarrierKind; readonly payload: Record<string, unknown> };
}

/** 已编号的入口记录（设计 §15.1 的实时 oracle 单位）；记录、事件与语义载荷都是冻结的。 */
export interface NumberedIngressRecord {
  /** 从 1 开始、严格递增、无洞。 */
  readonly ingressSeq: number;
  readonly event: SyncIngressEvent;
}

export interface LiveIngress {
  /** 接收一条事件：同步段完成快照与 pending 额度预留，再排队等待写者；额度不足时立即以 CAPACITY_EXCEEDED 拒绝。 */
  accept(event: SyncIngressEvent): Promise<NumberedIngressRecord>;
  /**
   * 最近 `diagnosticLimit` 条已成功记录的只读快照（测试/诊断窗口）。
   *
   * 它不是「全量已接收历史」：更早的记录会被淘汰，`lastIngressSeq()` 才是累计接收进度。
   * 每次返回新的冻结数组，外部改不动内部状态。
   */
  records(): readonly NumberedIngressRecord[];
  /** 已成功接收的最后一个序号；未接收任何事件时为 0。 */
  lastIngressSeq(): number;
  /** 清空诊断窗口并把编号重置为 0；与 accept 共用同一条顺序队列，在途接收先落定后才生效。 */
  reset(): void;
}

/** `BarrierKind` 的运行期词表：漏写一种屏障会在编译期暴露，避免入口放行写者不认识的语义种类。 */
const BARRIER_KIND_TABLE: Record<BarrierKind, true> = {
  tool: true,
  permission: true,
  error: true,
  cancel: true,
  final: true,
};
const BARRIER_KINDS: ReadonlySet<string> = new Set(Object.keys(BARRIER_KIND_TABLE));

/** 文本槽位与内容类型：与 live 层既有夹具同口径——合并键含槽位与内容类型，改变取值即换一条记录。 */
const TEXT_SLOT = "text";
const REASONING_SLOT = "reasoning";
const TEXT_CONTENT_TYPE = "text/plain";
/** 语义事件不进入合并缓冲（合并只处理文本增量），槽位与内容类型仅用于记录自描述与排障。 */
const SEMANTIC_SLOT = "semantic";
const SEMANTIC_CONTENT_TYPE = "application/json";

const EMPTY_EVENTS: readonly SyncIngressEvent[] = Object.freeze([]);
const NOOP = (): void => {};

function malformed(message: string): never {
  throw new SyncProtocolError("MALFORMED_FRAME", { message });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isBarrierKind(value: unknown): value is BarrierKind {
  return typeof value === "string" && BARRIER_KINDS.has(value);
}

/** 标识字段：类型与内容都要过（`assertIdentifier` 的错误信息只带字段名，不回显原值）。 */
function identityField(value: unknown, field: string): string {
  if (typeof value !== "string") malformed(`identifier "${field}" must be a string`);
  assertIdentifier(value, field);
  return value;
}

/**
 * 只展开普通对象与数组并冻结副本：非普通值（Date / Map / 类实例 / 函数）按引用保留——同步载荷是 JSON 面。
 *
 * `copies` 是「源对象 → 已产出副本」的记忆表，而不是单纯的环检测集合：同一对象第二次出现（别名）必须拿到
 * 同一份冻结副本，否则第二次出现会留下原引用，调用方事后改写就改到了已记录的快照；真环也只有靠记忆表才能
 * 在副本内闭合（回到自己时复用未冻结的副本骨架，填完再冻结）。
 */
function copyValue(value: unknown, copies: WeakMap<object, unknown>): unknown {
  if (typeof value !== "object" || value === null) return value;
  const copied = copies.get(value);
  if (copied !== undefined) return copied;
  if (Array.isArray(value)) {
    const list: unknown[] = [];
    copies.set(value, list);
    for (const item of value) list.push(copyValue(item, copies));
    return Object.freeze(list);
  }
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    // 非普通值按引用保留（既有行为）：记成自身，重复引用拿到的是同一个不被复制的原引用。
    copies.set(value, value);
    return value;
  }
  const copy: Record<string, unknown> = {};
  copies.set(value, copy);
  for (const [key, item] of Object.entries(value)) copy[key] = copyValue(item, copies);
  return Object.freeze(copy);
}

/** 语义载荷副本：调用方事后改写自己传入的嵌套对象（含别名与自引用）不会改变已保存的记录（oracle 必须稳定）。 */
function freezePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const copies = new WeakMap<object, unknown>();
  const copy: Record<string, unknown> = {};
  // 顶层先入表：`payload.self === payload` 这类自引用指向冻结副本本身，而不是又展开一份。
  copies.set(payload, copy);
  for (const [key, item] of Object.entries(payload)) copy[key] = copyValue(item, copies);
  return Object.freeze(copy);
}

/** 入口快照：结构校验 + 身份校验（运行时输入不可信），返回冻结副本供记录与写者共用同一个对象。 */
function snapshotIngressEvent(raw: SyncIngressEvent): SyncIngressEvent {
  const record = asRecord(raw);
  if (record === null) malformed("ingress event must be an object");
  const kind = record.kind;
  if (kind !== "text-delta" && kind !== "semantic") {
    malformed('ingress event kind must be "text-delta" or "semantic"');
  }
  const turnId = identityField(record.turnId, "turnId");
  const entryId = identityField(record.entryId, "entryId");
  const contentSlot = identityField(record.contentSlot, "contentSlot");
  const contentType = identityField(record.contentType, "contentType");
  if (kind === "text-delta") {
    const delta = record.delta;
    if (typeof delta !== "string") malformed("text-delta ingress event requires a string delta");
    return Object.freeze({
      kind,
      turnId,
      entryId,
      contentSlot,
      contentType,
      delta,
      ...(record.idempotent === true ? { idempotent: true } : {}),
    });
  }
  const semantic = asRecord(record.semantic);
  if (semantic === null) malformed("semantic ingress event requires a semantic payload");
  const barrier = semantic.kind;
  if (!isBarrierKind(barrier)) malformed(`semantic kind must be one of ${[...BARRIER_KINDS].join(", ")}`);
  const payload = asRecord(semantic.payload);
  if (payload === null) malformed("semantic payload must be an object");
  return Object.freeze({
    kind,
    turnId,
    entryId,
    contentSlot,
    contentType,
    semantic: Object.freeze({ kind: barrier, payload: freezePayload(payload) }),
  });
}

/**
 * 生产诊断窗口长度：只保留最近成功记录用于定位，不承担历史。
 *
 * 与 pending 预算解耦，避免把「已接收历史」以另一份全量数组重新引入内存；64 条足以覆盖一次失败前后的上下文。
 */
export const LIVE_INGRESS_DIAGNOSTIC_LIMIT = 64;

/** 快照不可被 JSON 编码时（例如自定义 toJSON 抛错）的保守计费：宁可少放行，也不让恶意载荷绕过字节预算。 */
const UNMEASURABLE_EVENT_BYTES = 64 * 1024;
const UTF8_ENCODER = new TextEncoder();

/**
 * 事件载荷的字节估算：以 JSON 编码后的 UTF-8 长度近似排队缓冲的内存占用。
 *
 * 用 replacer 处理循环引用与 BigInt（JSON.stringify 对二者会抛错）；估算只服务于 pending 预算记账，
 * 不要求与 wire 字节逐字相等。快照已由 `snapshotIngressEvent` 校验过，估算失败不能反过来否决合法事件。
 */
function estimateIngressBytes(event: SyncIngressEvent): number {
  const seen = new WeakSet<object>();
  try {
    const encoded = JSON.stringify(event, (_key: string, value: unknown) => {
      if (typeof value === "bigint") return `${value.toString()}n`;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[circular]";
        seen.add(value);
      }
      return value;
    });
    return UTF8_ENCODER.encode(encoded ?? "").byteLength;
  } catch {
    return UNMEASURABLE_EVENT_BYTES;
  }
}

class LiveIngressImpl implements LiveIngress {
  /** 诊断窗口：只保留最近 `diagnosticLimit` 条成功记录，不承担全量接收历史。 */
  private diagnostics: NumberedIngressRecord[] = [];
  private seq = 0;
  /** pending 账目：在飞 + 排队的事件数与估算字节，在入队前的同步段预留、任务结束时释放。 */
  private pendingRecords = 0;
  private pendingBytes = 0;
  /** 顺序队列：编号与写者调用都在队列内完成，并发 accept 不得交错；容量检查已移到入队前。 */
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly writer: LiveWriter,
    private readonly maxRecords: number,
    private readonly maxBytes: number,
    private readonly diagnosticLimit: number,
  ) {}

  async accept(event: SyncIngressEvent): Promise<NumberedIngressRecord> {
    // 容量在入队前检查并预留：拒绝不得先挂到 tail 上，否则慢写者会让调用方无界排队。
    if (this.pendingRecords >= this.maxRecords) {
      throw new SyncProtocolError("CAPACITY_EXCEEDED", {
        message: `live ingress pending events are full: ${this.pendingRecords} of ${this.maxRecords} in flight`,
      });
    }
    // 快照在调用时刻完成：入队后调用方再改对象不影响已排队事件；校验失败也不占用额度。
    const snapshot = snapshotIngressEvent(event);
    const bytes = estimateIngressBytes(snapshot);
    if (this.pendingBytes + bytes > this.maxBytes) {
      throw new SyncProtocolError("CAPACITY_EXCEEDED", {
        message:
          `live ingress pending bytes are full: ${this.pendingBytes + bytes} of ${this.maxBytes} bytes` +
          ` (event ${bytes} bytes)`,
      });
    }
    this.pendingRecords += 1;
    this.pendingBytes += bytes;
    // 队列链上挂一个永不 reject 的续段：一次失败不得毒化后续接收（写者自身的停写策略由写者决定）。
    const task = this.tail.then(() => this.dispatch(snapshot, bytes));
    this.tail = task.then(NOOP, NOOP);
    return await task;
  }

  records(): readonly NumberedIngressRecord[] {
    return Object.freeze([...this.diagnostics]);
  }

  lastIngressSeq(): number {
    return this.seq;
  }

  reset(): void {
    // 只清诊断与编号；pending 属于仍在飞/排队的任务，必须由各任务的 finally 释放，提前归零会让计数变负。
    this.tail = this.tail.then(() => {
      this.diagnostics = [];
      this.seq = 0;
    });
  }

  private async dispatch(snapshot: SyncIngressEvent, bytes: number): Promise<NumberedIngressRecord> {
    try {
      const record: NumberedIngressRecord = Object.freeze({ ingressSeq: this.seq + 1, event: snapshot });
      // 抛错即返回：序号不推进、记录不落盘，调用方拿到的错误就是写者的原始错误。
      await this.writer.accept(snapshot);
      this.seq = record.ingressSeq;
      this.diagnostics.push(record);
      if (this.diagnostics.length > this.diagnosticLimit) this.diagnostics.shift();
      return record;
    } finally {
      this.pendingRecords -= 1;
      this.pendingBytes -= bytes;
    }
  }
}

export function createLiveIngress(input: {
  readonly writer: LiveWriter;
  /** pending 条数预算（保留参数名以兼容既有调用方）：在飞 + 排队，不是累计已接收历史的上限。 */
  readonly maxRecords: number;
  /** pending 估算字节预算；缺省不设字节上限（生产装配必须显式给出）。 */
  readonly maxBytes?: number;
  /** 诊断窗口长度；缺省等于 `maxRecords`，只影响 `records()` 的可观测范围。 */
  readonly diagnosticLimit?: number;
}): LiveIngress {
  const { writer, maxRecords } = input;
  if (!Number.isInteger(maxRecords) || maxRecords <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `live ingress maxRecords must be a positive integer, received ${String(maxRecords)}`,
    });
  }
  const maxBytes = input.maxBytes ?? Number.POSITIVE_INFINITY;
  if (maxBytes !== Number.POSITIVE_INFINITY && (!Number.isSafeInteger(maxBytes) || maxBytes <= 0)) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `live ingress maxBytes must be a positive integer, received ${String(input.maxBytes)}`,
    });
  }
  const diagnosticLimit = input.diagnosticLimit ?? maxRecords;
  if (!Number.isInteger(diagnosticLimit) || diagnosticLimit <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `live ingress diagnosticLimit must be a positive integer, received ${String(diagnosticLimit)}`,
    });
  }
  return new LiveIngressImpl(writer, maxRecords, maxBytes, diagnosticLimit);
}

/**
 * 原始 ACP `session/update` 载荷 → 中立事件。纯函数，吃 `unknown`（不 import `../state`，不改写输入）。
 *
 * 接受的形态（`turnId` 逐层向外找：外层对象 → JSON-RPC 记录 → 内层 update）：
 * - 内层 update 对象：`{ sessionUpdate, ... , turnId? }`；
 * - JSON-RPC 通知 / 请求 / 响应：`{ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } }`、
 *   `method: "requestPermission"`（params 即权限请求载荷）、prompt 结果（`result.stopReason` / `result.cancelled`）
 *   与错误响应（`error`）；并兼容 `{ type, payload: { jsonrpc: "2.0", ... } }` 包裹。
 *
 * 无法识别、或已知类型但载荷缺身份/缺文本（见文件头缺口 ②④⑤）时返回空数组——不抛错，也不猜字段。
 */
export function normalizeAcpSessionUpdate(update: unknown): readonly SyncIngressEvent[] {
  const envelope = asRecord(update);
  if (envelope === null) return EMPTY_EVENTS;
  const rpc = asJsonRpc(envelope);
  if (rpc !== null) {
    const params = asRecord(rpc.params);
    const inner = params === null ? null : asRecord(params.update);
    return fromJsonRpc(rpc, inner, turnIdOf(envelope, rpc, inner));
  }
  const sessionUpdate = optionalString(envelope.sessionUpdate);
  if (sessionUpdate === null) return EMPTY_EVENTS;
  return fromSessionUpdate(sessionUpdate, envelope, turnIdOf(envelope));
}

/** JSON-RPC 提取：与 protocol/acp-channel.ts 的 `extractJsonRpc` 同口径（sync 层不 import 宿主 relay 规范化模块）。 */
function asJsonRpc(value: Record<string, unknown>): Record<string, unknown> | null {
  if (value.jsonrpc === "2.0") return value;
  const payload = asRecord(value.payload);
  return payload !== null && payload.jsonrpc === "2.0" ? payload : null;
}

/** 轮次身份：ACP 载荷自身不带 turnId，只有接线层补齐的 `turnId` 字段可用；逐层向外找，都缺即无轮次归属。 */
function turnIdOf(...records: readonly (Record<string, unknown> | null)[]): string | null {
  for (const record of records) {
    if (record === null) continue;
    const value = optionalString(record.turnId);
    if (value !== null) return value;
  }
  return null;
}

function fromJsonRpc(
  rpc: Record<string, unknown>,
  inner: Record<string, unknown> | null,
  turnId: string | null,
): readonly SyncIngressEvent[] {
  const method = optionalString(rpc.method);
  if (method === "session/update") {
    if (inner === null) return EMPTY_EVENTS;
    const sessionUpdate = optionalString(inner.sessionUpdate);
    return sessionUpdate === null ? EMPTY_EVENTS : fromSessionUpdate(sessionUpdate, inner, turnId);
  }
  if (method === "requestPermission") {
    const params = asRecord(rpc.params);
    return params === null ? EMPTY_EVENTS : permissionEvents(params, turnId, "pending");
  }
  if ("result" in rpc) return fromPromptResult(asRecord(rpc.result), turnId);
  if ("error" in rpc) return turnBarrierEvents(turnId, "error", errorMetadata(asRecord(rpc.error)));
  return EMPTY_EVENTS;
}

/** 错误元数据只带状态与协议错误码：原始 message 属公开错误注册表的职责，不写进运行态元数据。 */
function errorMetadata(error: Record<string, unknown> | null): Record<string, unknown> {
  const code = error === null ? undefined : error.code;
  if (typeof code === "string" || (typeof code === "number" && Number.isFinite(code))) {
    return { status: "failed", code };
  }
  return { status: "failed" };
}

function fromPromptResult(result: Record<string, unknown> | null, turnId: string | null): readonly SyncIngressEvent[] {
  if (result === null) return EMPTY_EVENTS;
  if (result.stopReason === "cancelled") {
    return turnBarrierEvents(turnId, "cancel", { status: "cancelled", stopReason: "cancelled" });
  }
  if (result.cancelled === true) return turnBarrierEvents(turnId, "cancel", { status: "cancelled", cancelled: true });
  // 正常结束（end_turn / max_tokens / refusal）：见文件头缺口 ①，final 需要存储侧描述符，入口不产出。
  return EMPTY_EVENTS;
}

function fromSessionUpdate(
  sessionUpdate: string,
  update: Record<string, unknown>,
  turnId: string | null,
): readonly SyncIngressEvent[] {
  switch (sessionUpdate) {
    case "agent_message_chunk":
      return textDeltaEvents(update, turnId, TEXT_SLOT);
    case "agent_thought_chunk":
      return textDeltaEvents(update, turnId, REASONING_SLOT);
    case "tool_call":
    case "tool_call_update":
      return toolEvents(update, turnId);
    case "permission_request":
      return permissionEvents(update, turnId, "pending");
    case "permission_response":
      return permissionEvents(update, turnId, "resolved");
    default:
      return EMPTY_EVENTS;
  }
}

/** 文本提取与 state/aggregator.ts 的 `extractText` 同口径：先 `content.text`，再顶层 `text`。 */
function textOf(update: Record<string, unknown>): string | null {
  const content = asRecord(update.content);
  const nested = content === null ? undefined : content.text;
  if (typeof nested === "string") return nested;
  const direct = update.text;
  return typeof direct === "string" ? direct : null;
}

/** 文本增量：空字符串与 CRLF 原样保留；同 entry/slot 的连续增量保持分片（合并在 live/merge-buffer.ts）。 */
function textDeltaEvents(
  update: Record<string, unknown>,
  turnId: string | null,
  slot: string,
): readonly SyncIngressEvent[] {
  if (turnId === null) return EMPTY_EVENTS;
  const delta = textOf(update);
  if (delta === null) return EMPTY_EVENTS;
  return [
    {
      kind: "text-delta",
      turnId,
      entryId: assistantEntryId(turnId),
      contentSlot: slot,
      contentType: TEXT_CONTENT_TYPE,
      delta,
    },
  ];
}

/** 工具实体：身份是 `toolCallId`（缺它就无法定位运行态实体，返回空数组而不是编造 id）。 */
function toolEvents(update: Record<string, unknown>, turnId: string | null): readonly SyncIngressEvent[] {
  if (turnId === null) return EMPTY_EVENTS;
  const toolCallId = optionalString(update.toolCallId);
  if (toolCallId === null || toolCallId.length === 0) return EMPTY_EVENTS;
  const metadata: Record<string, unknown> = {};
  for (const field of ["title", "status", "kind"]) {
    const value = optionalString(update[field]);
    if (value !== null) metadata[field] = value;
  }
  // 终态工具必须移出运行态实体；只把状态写进 metadata 会让实体永久占位（累计 257 个即停写）。
  // 不同引擎/私有帧的终态词表不一致（ACP completed/failed、peri complete/done/error）。
  const status = optionalString(update.status)?.toLowerCase() ?? null;
  const terminal =
    status === "completed" || status === "complete" || status === "done" || status === "failed" || status === "error";
  return [
    semanticEvent(turnId, assistantEntryId(turnId), "tool", {
      entityId: toolCallId,
      toolCallId,
      metadata,
      ...(terminal ? { terminal: true } : {}),
    }),
  ];
}

/** 权限实体：请求与决议共用 `permissionId ?? requestId` 作实体身份，决议只加状态与 decision。 */
function permissionEvents(
  update: Record<string, unknown>,
  turnId: string | null,
  status: "pending" | "resolved",
): readonly SyncIngressEvent[] {
  if (turnId === null) return EMPTY_EVENTS;
  const permissionId = optionalString(update.permissionId) ?? optionalString(update.requestId);
  if (permissionId === null) return EMPTY_EVENTS;
  const toolCall = asRecord(update.toolCall);
  const toolCallId =
    optionalString(update.toolCallId) ?? (toolCall === null ? null : optionalString(toolCall.toolCallId));
  const title =
    optionalString(update.title) ??
    optionalString(update.tool) ??
    (toolCall === null ? null : optionalString(toolCall.title));
  const metadata: Record<string, unknown> = { status };
  if (title !== null) metadata.title = title;
  if (status === "resolved") {
    const decision = optionalString(update.decision) ?? optionalString(update.optionId);
    if (decision !== null) metadata.decision = decision;
  }
  const payload: Record<string, unknown> = { entityId: permissionId, metadata };
  if (toolCallId !== null) payload.toolCallId = toolCallId;
  // 决议即终态：权限实体不能再占用运行态活动表。
  if (status === "resolved") payload.terminal = true;
  return [semanticEvent(turnId, assistantEntryId(turnId), "permission", payload)];
}

/** 轮次级屏障（error / cancel）：实体身份带轮次与种类，同一轮的两种屏障不互相覆盖。 */
function turnBarrierEvents(
  turnId: string | null,
  kind: "error" | "cancel",
  metadata: Record<string, unknown>,
): readonly SyncIngressEvent[] {
  if (turnId === null) return EMPTY_EVENTS;
  return [
    semanticEvent(turnId, assistantEntryId(turnId), kind, {
      entityId: `${turnId}:${kind}`,
      metadata,
    }),
  ];
}

function semanticEvent(
  turnId: string,
  entryId: string,
  kind: BarrierKind,
  payload: Record<string, unknown>,
): SyncIngressEvent {
  return {
    kind: "semantic",
    turnId,
    entryId,
    contentSlot: SEMANTIC_SLOT,
    contentType: SEMANTIC_CONTENT_TYPE,
    semantic: { kind, payload },
  };
}

/** 与 state/turn-machine.ts 的 `turnAssistantEntryId` 同一派生规则（sync 层不得 import ../state）。 */
function assistantEntryId(turnId: string): string {
  return `${turnId}:assistant`;
}
