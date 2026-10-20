// packages/chat-channel/src/sync/history/fidelity-json.ts
// 历史对象与实时文本的保真字节层（设计 §4.3）：有界扫描、保真序列化、按字节/代码单元分片。
// 本模块是「内容不失真」的唯一实现点：不 trim、不做 Unicode 规范化、不替换或补齐字符、不静默裁剪。
// - 孤立代理项由 `JSON.stringify`（ES2019 well-formed）写成 `\uXXXX`，往返后仍是同一代码单元；
// - JSON 载荷按字节切、实时字符串按 UTF-16 代码单元切，多字节字符与代理对允许跨分片，重组后才解码；
// - 超限与非法输入在 `JSON.parse` 之前拒绝：静默裁剪会把「内容缺失」伪装成「内容完整」（设计 §4.3.4）。
// 已知取舍：扫描是递归下降，栈深受传入 `maxDepth` 与内部安全上限双重截断（SCAN_STACK_SAFETY_DEPTH）；
// 默认档位 `inputs.jsonMaxDepth = 64` 远低于该上限，正常路径不受影响。

import { INPUT_LIMITS } from "../capacity/profile";
import { type DigestFn, sha256Digest } from "../clock";
import { SyncProtocolError } from "../protocol/errors";

/** 解析前有界扫描的输入上限：UTF-8 字节数、最大嵌套深度、最大节点数。 */
export interface JsonScanLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

/** 内容类型：`json` 表示可按结构化值还原，`text` 表示按不透明文本处理。 */
export type PayloadContentType = "json" | "text";

/**
 * 保真载荷分片：`[byteStart, byteEnd)` 为半开区间，`byteEnd - byteStart === payload.byteLength`。
 * `digest` 是**整个载荷**的摘要而非本片摘要（设计 §4.3.4 的「摘要通过」针对逻辑对象整体），
 * 因此任一单片被篡改都能在重组时发现，不必信任分片自身携带的元数据。
 */
export interface JsonPart {
  partIndex: number;
  partCount: number;
  byteStart: number;
  byteEnd: number;
  digest: string;
  payload: Uint8Array;
}

/** 逻辑对象描述（设计 §4.3.2）：总字节数、片段数、载荷摘要与内容类型。 */
export interface PayloadSummary {
  totalBytes: number;
  partCount: number;
  digest: string;
  contentType: PayloadContentType;
}

const PROXY_PAIR_BYTES = 4;
const UTF8_ENCODER = new TextEncoder();
/** 非法字节序列直接失败：替换字符会静默改写内容（`bytes` 计数仍按替换结果与 `TextEncoder` 对齐）。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
/** 默认分片粒度取 §10.2 `inputs.payloadChunkMaxBytes`：与 ingest 的分片口径一致，partCount 才能对齐。 */
const DEFAULT_PART_BYTES = INPUT_LIMITS.payloadChunkMaxBytes;
/** 扫描栈安全上限：递归下降的栈深等于 `maxDepth`，误传极大值会让深嵌套输入先耗尽调用栈而抛 RangeError，
 * 使「容量拒绝」退化成未分类异常；默认档位 64 远低于此值，更深嵌套必须先改成显式栈实现。 */
const SCAN_STACK_SAFETY_DEPTH = 1024;

/** 一次扫描的状态：输入上限在扫描期内不变，与游标放在一起，免去每个递归函数重复传递上限字段。其中
 * `maxBytes`/`maxDepth`/`maxNodes` 是上限，`bytes`/`depth`/`nodes` 是观测值，`index` 是代码单元下标。 */
interface ScanState extends JsonScanLimits {
  index: number;
  bytes: number;
  depth: number;
  nodes: number;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;
const isDigit = (code: number): boolean => code >= 0x30 && code <= 0x39;
const isHexDigit = (code: number): boolean =>
  isDigit(code) || (code >= 0x41 && code <= 0x46) || (code >= 0x61 && code <= 0x66);
/** JSON 允许的 8 个简单转义：`"` `/` `\` `b` `f` `n` `r` `t`；其余转义（含 `\x`、`\0`）非法。 */
const SIMPLE_ESCAPES: ReadonlySet<number> = new Set([0x22, 0x2f, 0x5c, 0x62, 0x66, 0x6e, 0x72, 0x74]);
/** 分片数：与 `splitJsonParts` 共用同一算式，避免「摘要里的 partCount」与「实际分片数」漂移。 */
const partCountOf = (totalBytes: number, maxPartBytes: number): number =>
  Math.max(1, Math.ceil(totalBytes / maxPartBytes));

/** 单个代码单元独立编码时的 UTF-8 字节数；孤立代理项按 `TextEncoder` 的 U+FFFD（3 字节）计。 */
function utf8BytesOfUnit(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  return 3;
}
/** 超限一律抛 `CAPACITY_EXCEEDED` 并指明是哪一项：调用方据此区分「限流重试」与「输入结构非法」。 */
function scanLimitExceeded(state: ScanState, field: keyof JsonScanLimits, observed: number): SyncProtocolError {
  const message = `json scan exceeded ${field}: limit ${state[field]}, observed ${observed}`;
  return new SyncProtocolError("CAPACITY_EXCEEDED", { message });
}
/** 结构非法（非法转义、非有限数字、尾随内容等）：重试不会改变输入，按 `MALFORMED_FRAME` 归类。 */
function malformedScan(reason: string): SyncProtocolError {
  return new SyncProtocolError("MALFORMED_FRAME", { message: `json scan rejected input: ${reason}` });
}
/** 分片大小非法属配置错误（来自 capacity profile 或调用方旋钮），不是载荷问题，故不按输入错误归类。 */
function assertPositivePartSize(field: "maxPartBytes" | "maxBytes", value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new SyncProtocolError("ADMISSION_REJECTED", {
      message: `${field} must be a positive integer, received ${String(value)}`,
    });
  }
}
/** 分片失败的两个出口：缺片/区间不连续按 `IMPORT_INCOMPLETE`（显示未同步），摘要不符按 `DIGEST_CONFLICT`。 */
function partsError(code: "IMPORT_INCOMPLETE" | "DIGEST_CONFLICT", reason: string): SyncProtocolError {
  return new SyncProtocolError(code, { message: `json parts rejected: ${reason}` });
}
/** 消费一个代码单元并计入 UTF-8 字节数：合法代理对按 4 字节整体消费，孤立代理项按 3 字节计——
 * `TextEncoder` 会把孤立代理项替换成 U+FFFD（3 字节），本模块只对齐计数、不做替换，从而维持
 * 「扫描字节数 == 编码字节数」这一不变量；超字节上限立即失败，不等扫完。 */
function consumeUnit(state: ScanState, text: string): void {
  const code = text.charCodeAt(state.index);
  const paired = isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(state.index + 1));
  state.index += paired ? 2 : 1;
  state.bytes += paired ? PROXY_PAIR_BYTES : utf8BytesOfUnit(code);
  if (state.bytes > state.maxBytes) throw scanLimitExceeded(state, "maxBytes", state.bytes);
}
/** 跳过 JSON 定义的四种空白（`JSON.parse` 同样只认这四种）；U+00A0 等其它空白按非法输入拒绝。 */
function skipWhitespace(state: ScanState, text: string): void {
  while (state.index < text.length) {
    const code = text.charCodeAt(state.index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return;
    consumeUnit(state, text);
  }
}
/** 进入容器：深度只在此处推进，超限立即失败（不等整段扫完）。深度必须在 `JSON.parse` 之前检查——
 * `[` 大量嵌套的载荷字节数很小，只靠 `maxBytes` 挡不住结构炸弹。 */
function enterContainer(state: ScanState, text: string, depth: number): void {
  const nextDepth = depth + 1;
  if (nextDepth > state.maxDepth) throw scanLimitExceeded(state, "maxDepth", nextDepth);
  if (nextDepth > SCAN_STACK_SAFETY_DEPTH) {
    const ceiling = SCAN_STACK_SAFETY_DEPTH;
    const message = `json scan exceeded maxDepth: scan stack safety ceiling ${ceiling}, observed ${nextDepth}`;
    throw new SyncProtocolError("CAPACITY_EXCEEDED", { message });
  }
  if (nextDepth > state.depth) state.depth = nextDepth;
  consumeUnit(state, text);
}
/** 转义序列：`\uXXXX` 必须恰好四位十六进制；其余只允许 8 个简单转义。 */
function scanEscape(state: ScanState, text: string): void {
  consumeUnit(state, text); // 反斜杠
  if (text.charCodeAt(state.index) === 0x75) {
    consumeUnit(state, text); // u
    for (let digit = 0; digit < 4; digit += 1) {
      if (!isHexDigit(text.charCodeAt(state.index))) {
        throw malformedScan(`\\u escape requires four hex digits at index ${state.index}`);
      }
      consumeUnit(state, text);
    }
    return;
  }
  if (!SIMPLE_ESCAPES.has(text.charCodeAt(state.index))) {
    throw malformedScan(`illegal escape sequence at index ${state.index}`);
  }
  consumeUnit(state, text);
}
/** 字符串字面量：只接受 JSON 的转义集合，未转义控制字符与非法转义一律失败。 */
function scanString(state: ScanState, text: string): void {
  consumeUnit(state, text); // 开引号
  while (true) {
    if (state.index >= text.length) throw malformedScan("unterminated string");
    const code = text.charCodeAt(state.index);
    if (code === 0x22) {
      consumeUnit(state, text);
      return;
    }
    if (code === 0x5c) {
      scanEscape(state, text);
      continue;
    }
    if (code < 0x20) throw malformedScan(`unescaped control character at index ${state.index}`);
    consumeUnit(state, text);
  }
}
/** 数字字面量：按 JSON 语法逐段校验（无前导零、小数与指数必须有数字），最后确认它能表示为有限数——
 * `1e999` 语法合法却解析成 `Infinity`，而 `JSON.stringify(Infinity)` 得到 `null`，静默变成 null 等于篡改
 * 内容，故在入口拒绝（设计 §4.3.1「超出契约明确拒绝」）；`NaN`/`Infinity` 首字符不合法，走默认分支。 */
function scanNumber(state: ScanState, text: string): void {
  const start = state.index;
  if (text.charCodeAt(state.index) === 0x2d) consumeUnit(state, text); // -
  const integerCode = text.charCodeAt(state.index);
  if (integerCode === 0x30) {
    consumeUnit(state, text);
  } else if (isDigit(integerCode)) {
    while (isDigit(text.charCodeAt(state.index))) consumeUnit(state, text);
  } else {
    throw malformedScan(`number requires an integer part at index ${state.index}`);
  }
  if (text.charCodeAt(state.index) === 0x2e) {
    consumeUnit(state, text); // .
    if (!isDigit(text.charCodeAt(state.index))) throw malformedScan("fraction requires at least one digit");
    while (isDigit(text.charCodeAt(state.index))) consumeUnit(state, text);
  }
  const exponentCode = text.charCodeAt(state.index);
  if (exponentCode === 0x45 || exponentCode === 0x65) {
    consumeUnit(state, text); // e
    const signCode = text.charCodeAt(state.index);
    if (signCode === 0x2b || signCode === 0x2d) consumeUnit(state, text);
    if (!isDigit(text.charCodeAt(state.index))) throw malformedScan("exponent requires at least one digit");
    while (isDigit(text.charCodeAt(state.index))) consumeUnit(state, text);
  }
  if (!Number.isFinite(Number(text.slice(start, state.index)))) {
    throw malformedScan("number literal is not representable as a finite number");
  }
}
/** 字面量 `true`/`false`/`null`：先做整词前缀核对，再逐字符消费（`truex` 这类由尾随内容检查拒绝）。 */
function scanLiteral(state: ScanState, text: string, literal: string): void {
  if (!text.startsWith(literal, state.index)) {
    throw malformedScan(`expected literal ${literal} at index ${state.index}`);
  }
  for (let index = 0; index < literal.length; index += 1) consumeUnit(state, text);
}
/** 对象与数组共用一条扫描路径（只有键值语法与闭合符不同）：两者结构一致，分开写容易在修正一侧时漏掉另一侧；
 * 空容器、尾随逗号、缺失冒号、错误闭合符都在状态检查处失败。 */
function scanContainer(state: ScanState, text: string, depth: number, isObject: boolean): void {
  const kind = isObject ? "object" : "array";
  const closeCode = isObject ? 0x7d : 0x5d;
  const closeChar = isObject ? "}" : "]";
  enterContainer(state, text, depth);
  skipWhitespace(state, text);
  if (text.charCodeAt(state.index) === closeCode) {
    consumeUnit(state, text);
    return;
  }
  while (true) {
    if (isObject) {
      if (text.charCodeAt(state.index) !== 0x22) {
        throw malformedScan(`object key must be a string at index ${state.index}`);
      }
      scanString(state, text);
      skipWhitespace(state, text);
      if (text.charCodeAt(state.index) !== 0x3a) {
        throw malformedScan(`object member requires ':' at index ${state.index}`);
      }
      consumeUnit(state, text);
      skipWhitespace(state, text);
    }
    scanValue(state, text, depth + 1);
    skipWhitespace(state, text);
    const code = text.charCodeAt(state.index);
    if (code === 0x2c) {
      consumeUnit(state, text);
      skipWhitespace(state, text);
      continue;
    }
    if (code === closeCode) {
      consumeUnit(state, text);
      return;
    }
    throw malformedScan(`${kind} must continue with ',' or '${closeChar}' at index ${state.index}`);
  }
}
/** 一个 JSON 值：`depth` 是所在容器的层数（顶层为 0），节点计数在每个值入口处递增。 */
function scanValue(state: ScanState, text: string, depth: number): void {
  state.nodes += 1;
  if (state.nodes > state.maxNodes) throw scanLimitExceeded(state, "maxNodes", state.nodes);
  const code = text.charCodeAt(state.index);
  switch (code) {
    case 0x7b: // {
      scanContainer(state, text, depth, true);
      return;
    case 0x5b: // [
      scanContainer(state, text, depth, false);
      return;
    case 0x22: // "
      scanString(state, text);
      return;
    case 0x74: // t
      scanLiteral(state, text, "true");
      return;
    case 0x66: // f
      scanLiteral(state, text, "false");
      return;
    case 0x6e: // n
      scanLiteral(state, text, "null");
      return;
    default:
      if (code === 0x2d || isDigit(code)) {
        scanNumber(state, text);
        return;
      }
      throw malformedScan(`unexpected value start at index ${state.index}`);
  }
}

/**
 * 解析前的有界扫描：统计 UTF-8 字节数（与 `TextEncoder` 编码长度一致）、最大嵌套深度与节点数（对象/数组/
 * 标量各算一个节点，对象键不单独计；顶层标量深度为 0）。必须在 `JSON.parse` 之前调用：`JSON.parse` 没有
 * 深度与节点上限，先解析再判断等于已吃下结构炸弹的分配成本。任一超限立即抛 `CAPACITY_EXCEEDED`，不读完
 * 整个输入；非有限数字与非法转义一并拒绝。
 */
export function scanJsonText(text: string, limits: JsonScanLimits): { bytes: number; depth: number; nodes: number } {
  const state: ScanState = { ...limits, index: 0, bytes: 0, depth: 0, nodes: 0 };
  skipWhitespace(state, text);
  if (state.index >= text.length) throw malformedScan("empty input");
  scanValue(state, text, 0);
  skipWhitespace(state, text);
  if (state.index !== text.length) throw malformedScan(`unexpected trailing content at index ${state.index}`);
  return { bytes: state.bytes, depth: state.depth, nodes: state.nodes };
}

/**
 * 保真序列化：`JSON.stringify` 后按 UTF-8 编码，不 trim、不做 Unicode 规范化、不改字符串代码单元；孤立代理项
 * 被写成 `\uXXXX` 转义序列，解码后仍是同一代码单元。JS 独有值（`undefined`/函数/Symbol）没有 JSON 表示：
 * 顶层出现时直接拒绝，否则会返回空字节把「不可表示」伪装成「空内容」；嵌套在对象里时按 JSON 语义丢弃。
 */
export function fidelitySerialize(value: unknown): Uint8Array {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    // 循环引用、BigInt 等：保留原始异常用于诊断，对外只暴露稳定错误码。
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "value is not JSON-serializable", cause: error });
  }
  if (text === undefined) {
    const message = "value has no JSON representation (undefined, function or symbol)";
    throw new SyncProtocolError("MALFORMED_FRAME", { message });
  }
  return UTF8_ENCODER.encode(text);
}

/**
 * 保真反序列化：严格 UTF-8 解码 + `JSON.parse`。
 *
 * 解码用 `fatal: true`：非 fatal 会把坏字节替换成 U+FFFD，等于把「字节损坏」变成「内容变了」，
 * 而重组的首要职责是让损坏可见（坏块显示未同步，不显示成空内容）。
 */
export function fidelityDeserialize(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "payload is not well-formed UTF-8", cause: error });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "payload is not valid JSON", cause: error });
  }
}

/**
 * 按字节切分 JSON 载荷：允许切断多字节字符（多字节字符与代理对都可跨分片），重组后再解码。
 *
 * 空载荷也产出一个零长度分片：分片是摘要的唯一载体，若允许 0 片，`joinJsonParts` 就失去校验依据，
 * 一个空数组就能冒充「完整且未损坏」。`payload` 一律复制，不与调用方缓冲共享内存。
 */
export function splitJsonParts(bytes: Uint8Array, maxPartBytes: number, digest: DigestFn = sha256Digest): JsonPart[] {
  assertPositivePartSize("maxPartBytes", maxPartBytes);
  const payloadDigest = digest(bytes);
  const totalBytes = bytes.byteLength;
  const partCount = partCountOf(totalBytes, maxPartBytes);
  const parts: JsonPart[] = [];
  for (let partIndex = 0; partIndex < partCount; partIndex += 1) {
    const byteStart = Math.min(partIndex * maxPartBytes, totalBytes);
    const byteEnd = Math.min(byteStart + maxPartBytes, totalBytes);
    const payload = bytes.slice(byteStart, byteEnd);
    parts.push({ partIndex, partCount, byteStart, byteEnd, digest: payloadDigest, payload });
  }
  return parts;
}

/**
 * 重组 JSON 分片：校验齐全（partCount 一致、索引恰为 `0..partCount-1`、字节区间连续覆盖）与总摘要。
 * 缺片、索引重复或区间不连续抛 `IMPORT_INCOMPLETE`；字节被篡改或混入其它载荷的分片抛 `DIGEST_CONFLICT`
 * （已提交边界不可信，必须重新取）。分片可乱序传入：顺序由 `partIndex` 决定，不依赖送达顺序。
 */
export function joinJsonParts(parts: readonly JsonPart[], digest: DigestFn = sha256Digest): Uint8Array {
  const first = parts[0];
  if (first === undefined) throw partsError("IMPORT_INCOMPLETE", "no parts supplied");
  const partCount = first.partCount;
  if (parts.length !== partCount) {
    throw partsError("IMPORT_INCOMPLETE", `expected ${partCount} parts, received ${parts.length}`);
  }
  const expectedDigest = first.digest;
  const ordered = [...parts].sort((left, right) => left.partIndex - right.partIndex);
  let offset = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const part = ordered[index];
    if (part.partCount !== partCount) throw partsError("IMPORT_INCOMPLETE", "parts disagree on partCount");
    if (part.partIndex !== index) {
      throw partsError("IMPORT_INCOMPLETE", `part index ${part.partIndex} is missing or duplicated`);
    }
    if (part.digest !== expectedDigest) throw partsError("DIGEST_CONFLICT", "parts disagree on payload digest");
    if (part.byteStart !== offset || part.byteEnd !== part.byteStart + part.payload.byteLength) {
      throw partsError("IMPORT_INCOMPLETE", "byte ranges are not a contiguous cover of the payload");
    }
    offset = part.byteEnd;
  }
  const joined = new Uint8Array(offset);
  for (const part of ordered) joined.set(part.payload, part.byteStart);
  if (digest(joined) !== expectedDigest) throw partsError("DIGEST_CONFLICT", "reassembled payload digest mismatch");
  return joined;
}

/** 取下一个分段单元：`maxBytes >= 4` 时把完整代理对视作原子（避免产出无谓的孤立代理项），否则退回单个代码单元
 * ——后者才是「允许在代理对中间切分」的落点（设计 §4.3.3）。`units` 是消费的代码单元数，`bytes` 是其字节数。 */
function nextTextUnit(text: string, index: number, maxBytes: number): { units: number; bytes: number } {
  const code = text.charCodeAt(index);
  if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(index + 1)) && maxBytes >= PROXY_PAIR_BYTES) {
    return { units: 2, bytes: PROXY_PAIR_BYTES };
  }
  return { units: 1, bytes: utf8BytesOfUnit(code) };
}

/**
 * 实时字符串按原始 UTF-16 代码单元顺序切分，不替换也不补齐字符。
 *
 * 边界落在代码单元上：`maxBytes >= 4` 时代理对整体保留；`maxBytes < 4` 时无法在不超限的前提下保留代理对，
 * 于是允许切在代理对中间（两侧各是孤立代理项，按原样保存与拼接）。单个代码单元的 UTF-8 编码最长 3 字节，
 * 故 `maxBytes < 3` 时上限不可满足，实现选择「每片至少推进一个代码单元」——零推进会死循环；按 §10.2
 * 传 16KiB 的调用方不会触达该分支。
 */
export function splitStringParts(text: string, maxBytes: number): string[] {
  assertPositivePartSize("maxBytes", maxBytes);
  const parts: string[] = [];
  let start = 0;
  let consumed = 0;
  let index = 0;
  while (index < text.length) {
    const unit = nextTextUnit(text, index, maxBytes);
    if (consumed > 0 && unit.bytes > maxBytes - consumed) {
      parts.push(text.slice(start, index));
      start = index;
      consumed = 0;
      continue;
    }
    index += unit.units;
    consumed += unit.bytes;
  }
  if (start < text.length) parts.push(text.slice(start));
  return parts;
}

/** 逆操作：代码单元级拼接，不做规范化、不修正孤立代理项。不做「补齐代理对」这类好心修正：分片可能被错配或
 * 乱序，静默修正会把坏数据变成看似正常的字符串。 */
export function joinStringParts(parts: readonly string[]): string {
  return parts.join("");
}

/** 取首个（`fromEnd = false`）或末个（`true`）非 JSON 空白字符；只用于内容类型嗅探，不改变任何字节。 */
function edgeNonWhitespace(text: string, fromEnd: boolean): string {
  for (let step = 0; step < text.length; step += 1) {
    const index = fromEnd ? text.length - 1 - step : step;
    const code = text.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) return text[index];
  }
  return "";
}

/**
 * 内容类型判定：只有「对象/数组」才判为 `json`。裸标量（`123`、`true`、`"x"`）在真实载荷里更常是 Markdown
 * 文本片段，标成 `json` 会让下游对文本走结构化解析；非法 UTF-8 与解析失败的载荷一律按 `text` 处理
 * （宁可当文本，不要当结构）。首尾字符检查是 O(n) 廉价前置，避免对明显是文本的载荷白做一次完整解析。
 */
function detectContentType(bytes: Uint8Array): PayloadContentType {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    // 这里的 catch 是分类探测而非错误处理：无法解码的字节不可能是 JSON，按不透明文本回报。
    return "text";
  }
  const first = edgeNonWhitespace(text, false);
  const last = edgeNonWhitespace(text, true);
  if (!((first === "{" && last === "}") || (first === "[" && last === "]"))) return "text";
  try {
    JSON.parse(text);
    return "json";
  } catch {
    return "text";
  }
}

/**
 * 逻辑对象摘要（设计 §4.3.2）：总字节数、片段数、载荷摘要与内容类型。
 *
 * `maxPartBytes` 默认取 §10.2 `inputs.payloadChunkMaxBytes`（与 ingest 的分片口径一致）；若调用方用了别的
 * 分片粒度，必须显式传入同一个值，否则本函数回报的 `partCount` 会与实际分片数对不上。
 */
export function summarizePayload(
  bytes: Uint8Array,
  maxPartBytes: number = DEFAULT_PART_BYTES,
  digest: DigestFn = sha256Digest,
): PayloadSummary {
  assertPositivePartSize("maxPartBytes", maxPartBytes);
  const totalBytes = bytes.byteLength;
  return {
    totalBytes,
    partCount: partCountOf(totalBytes, maxPartBytes),
    digest: digest(bytes),
    contentType: detectContentType(bytes),
  };
}
