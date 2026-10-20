// packages/chat-channel/src/sync/protocol/identity.ts
// 同步身份：scope、各类派生标识、docId 与序号连续性。
//
// 身份不可混用（设计 §4.1）：`scope` 只来自服务端鉴权结果，本模块**不提供**任何从客户端入参
// 构造 scope 的函数；`generation` 表示一次一致的同步投影，普通断线不得改变；`docId` 创建后到
// 删除不变，禁止用 Yjs `clientID` 或客户端 guid 替代。所有生成器接收注入的 `RandomSource`：
// 时间戳不能充当「幂等」来源（同毫秒会撞号，且重启后不可比），随机性必须来自随机源。

import type { RandomSource } from "../clock";
import { SyncProtocolError } from "./errors";

/** 单个标识的 UTF-8 字节上限；控制帧头与 docId 的每个分段都按此约束。 */
export const MAX_IDENTIFIER_BYTES = 256;

/** 同步隔离范围：服务端鉴权后的组织与会话绑定，不接受客户端自行授权。 */
export interface SyncScope {
  organizationId: string;
  rcsSessionId: string;
}

/** docId 的谱系类型（设计 §4.2）。 */
export type DocKind = "control" | "directory" | "content" | "runtime";

/** 单个 Doc 的生命周期状态。 */
export type DocState = "active" | "sealing" | "sealed" | "failed" | "retired";

/** 一次同步投影代次的生命周期状态。 */
export type GenerationState = "staging" | "committed" | "failed" | "retired";

/** docId：`sync/<kind>/<generation>/<blockIndex>/<nonce>`，与 `parseDocId` 的结果同构。 */
export interface DocIdParts {
  kind: DocKind;
  generation: string;
  blockIndex: number;
  nonce: string;
}

const DOC_KINDS: ReadonlySet<string> = new Set<DocKind>(["control", "directory", "content", "runtime"]);
const DOC_ID_PREFIX = "sync";
const SEGMENT_SEPARATOR = "/";
const DOC_ID_SEGMENT_COUNT = 5;
/** 规范化十进制：拒绝 `01`、`+1`、`1.0`、空串与带空白的写法，保证 docId 可稳定往返。 */
const BLOCK_INDEX_PATTERN = /^(0|[1-9][0-9]*)$/;
const UTF8_ENCODER = new TextEncoder();

/** C0（含 NUL/TAB）、DEL 与 C1 控制字符：它们会破坏日志、帧头与键的可解析性。 */
function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

function isDocKind(value: string): value is DocKind {
  return DOC_KINDS.has(value);
}

/** UTF-8 字节数：标识上限按字节计，多字节字符不能按 UTF-16 码元折算。 */
function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).length;
}

interface IdentifierViolation {
  code: "MALFORMED_FRAME" | "IDENTIFIER_TOO_LONG";
  reason: string;
}

/**
 * 标识违规分类；合法返回 null。
 *
 * 规则集中在此一处，使 `assertIdentifier`（抛精确错误码）与 `parseDocId`（统一抛
 * `MALFORMED_FRAME`）共用同一套判定，不会出现两处规则漂移。
 */
function identifierViolation(value: string): IdentifierViolation | null {
  if (value.length === 0) {
    return { code: "MALFORMED_FRAME", reason: "must not be empty" };
  }
  if (hasControlCharacters(value)) {
    return { code: "MALFORMED_FRAME", reason: "must not contain control characters" };
  }
  const bytes = utf8ByteLength(value);
  if (bytes > MAX_IDENTIFIER_BYTES) {
    return { code: "IDENTIFIER_TOO_LONG", reason: `is ${bytes} UTF-8 bytes, limit is ${MAX_IDENTIFIER_BYTES}` };
  }
  return null;
}

/**
 * 校验单个标识：非空、UTF-8 字节数 ≤ `MAX_IDENTIFIER_BYTES`、不含控制字符。
 *
 * 错误信息只带字段名与违规类型，不回显原值：标识可能来自鉴权上下文或不可信输入，
 * 回显会把任意字节带进日志与 ERROR 帧。
 */
export function assertIdentifier(value: string, field: string): void {
  const violation = identifierViolation(value);
  if (violation !== null) {
    throw new SyncProtocolError(violation.code, { message: `identifier "${field}" ${violation.reason}` });
  }
}

/** 复合键分段（scope 字段、docId 的 generation/nonce）合法性：标识约束 + 不含分隔符 `/`。 */
function assertKeySegment(value: string, field: string): void {
  assertIdentifier(value, field);
  if (value.includes(SEGMENT_SEPARATOR)) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: `identifier "${field}" must not contain "/"` });
  }
}

/** 与 `assertKeySegment` 同规则的判定式；`parseDocId` 用它在解析期统一收敛错误码。 */
function isKeySegment(value: string): boolean {
  return identifierViolation(value) === null && !value.includes(SEGMENT_SEPARATOR);
}

/**
 * 归一化范围键：`"{organizationId}/{rcsSessionId}"`。
 *
 * 两个字段都不允许含 `/`，否则键会被拆出多于两段、无法反解出归属；scope 只应由服务端
 * 鉴权结果构造，本函数不接受任何未经鉴权的客户端入参。
 */
export function scopeKey(scope: SyncScope): string {
  assertKeySegment(scope.organizationId, "scope.organizationId");
  assertKeySegment(scope.rcsSessionId, "scope.rcsSessionId");
  return `${scope.organizationId}${SEGMENT_SEPARATOR}${scope.rcsSessionId}`;
}

/** 取 `byteLength` 字节随机性并编码为小写十六进制。 */
function randomHex(rand: RandomSource, byteLength: number): string {
  const bytes = rand.bytes(byteLength);
  if (bytes.length !== byteLength) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      message: `random source returned ${bytes.length} bytes, expected ${byteLength}`,
    });
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 一次同步投影代次的标识：完整重建时新建，普通断线不变。 */
export function createGenerationId(rand: RandomSource): string {
  return `gen_${randomHex(rand, 16)}`;
}

/** 一次历史导入尝试的标识：每次重试新建，不能充当源对象 ID。 */
export function createLoadId(rand: RandomSource): string {
  return `load_${randomHex(rand, 16)}`;
}

/** 一次持久化批次的标识：同键同摘要的重传据此判幂等。 */
export function createBatchId(rand: RandomSource): string {
  return `batch_${randomHex(rand, 16)}`;
}

/** 单连接发送代次：重连即换新，旧帧只用于结清原账本。 */
export function createTransportEpoch(rand: RandomSource): string {
  return `tx_${randomHex(rand, 8)}`;
}

/** 同连接内某 Doc 的订阅代次：退订、resync 或 Doc 实例变化即废止。 */
export function createSubscriptionEpoch(rand: RandomSource): string {
  return `sub_${randomHex(rand, 8)}`;
}

/** 同一 Doc 的基线尝试标识：换 attempt 即废弃旧计划与旧游标。 */
export function createSyncAttemptId(rand: RandomSource): string {
  return `att_${randomHex(rand, 8)}`;
}

/** 帧投递编号：只用于流量确认与重复帧记账，不参与业务幂等。 */
export function createDeliveryId(rand: RandomSource): string {
  return `dlv_${randomHex(rand, 8)}`;
}

/**
 * 组装 docId：`sync/<kind>/<generation>/<blockIndex>/<nonce>`。
 *
 * 各段都不允许含 `/`，否则 `parseDocId` 无法反解；`blockIndex` 只接受非负安全整数
 * （控制 Doc 与运行态 Doc 固定为 0）。
 *
 * 分段各自合规不等于整体合规：docId 是进入帧头与持久化键的**单个标识**（设计 §8.3「单标识 ≤256 字节」），
 * 故拼接后复用同一套判定再校验一次整体——否则身份层造得出、帧层发不出去，同一个上限出现两种口径。
 */
export function buildDocId(input: DocIdParts): string {
  if (!isDocKind(input.kind)) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "docId kind is not a known DocKind" });
  }
  assertKeySegment(input.generation, "docId.generation");
  assertKeySegment(input.nonce, "docId.nonce");
  if (!Number.isSafeInteger(input.blockIndex) || input.blockIndex < 0) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      message: "docId.blockIndex must be a non-negative safe integer",
    });
  }
  const docId = [DOC_ID_PREFIX, input.kind, input.generation, String(input.blockIndex), input.nonce].join(
    SEGMENT_SEPARATOR,
  );
  assertIdentifier(docId, "docId");
  return docId;
}

/**
 * 解析 docId。
 *
 * docId 可能来自对端输入，属于不可信数据：段数、前缀、kind、各段内容与序号格式任一不合规
 * 一律抛 `MALFORMED_FRAME`（不细分长度类错误——调用方的正确处理都是「拒绝该 docId」）。
 */
export function parseDocId(docId: string): DocIdParts {
  const segments = docId.split(SEGMENT_SEPARATOR);
  if (segments.length !== DOC_ID_SEGMENT_COUNT || segments[0] !== DOC_ID_PREFIX) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      message: "docId does not match sync/<kind>/<generation>/<index>/<nonce>",
    });
  }
  const kind = segments[1];
  if (!isDocKind(kind)) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "docId kind is not a known DocKind" });
  }
  const generation = segments[2];
  const nonce = segments[4];
  if (!isKeySegment(generation) || !isKeySegment(nonce)) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "docId generation or nonce segment is invalid" });
  }
  const blockIndexText = segments[3];
  if (!BLOCK_INDEX_PATTERN.test(blockIndexText)) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "docId blockIndex is not a canonical decimal integer" });
  }
  const blockIndex = Number.parseInt(blockIndexText, 10);
  if (!Number.isSafeInteger(blockIndex)) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "docId blockIndex exceeds the safe integer range" });
  }
  return { kind, generation, blockIndex, nonce };
}

/**
 * 谱系比较：`kind + generation + blockIndex` 相同即同一谱系，`nonce` 只区分同一谱系内的不同尝试。
 *
 * 任一 docId 畸形时抛 `MALFORMED_FRAME`：谱系结论用于安全判定（能否复用已有基线），
 * 对不可解析输入「猜一个结果」会把错误传播成数据串扰。
 */
export function isSameDocLineage(a: string, b: string): boolean {
  const left = parseDocId(a);
  const right = parseDocId(b);
  return left.kind === right.kind && left.generation === right.generation && left.blockIndex === right.blockIndex;
}

/**
 * 校验应用层连续序号：`next` 必须是 `prev + 1`，或在 `prev === 0`（尚无已应用连续更新）时取起点
 * `0` / `1`——base 快照是否计入 0 号由调用方决定，两种起点都合法。其余一律 `SEQUENCE_GAP`。
 *
 * 缺号必须显式补齐：跳过会让「连续更新覆盖到 finalSeq」不再构成完整性证明。
 */
export function assertMonotonicSeq(next: number, prev: number): void {
  const continuous = Number.isSafeInteger(prev) && prev >= 0 && Number.isSafeInteger(next) && next >= 0;
  const isStart = prev === 0 && (next === 0 || next === 1);
  if (!continuous || !(next === prev + 1 || isStart)) {
    throw new SyncProtocolError("SEQUENCE_GAP", {
      message: `expected seq ${prev + 1}, or a 0/1 start from an empty cursor`,
      safeContext: { seq: next },
    });
  }
}
