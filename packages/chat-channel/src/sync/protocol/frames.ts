// packages/chat-channel/src/sync/protocol/frames.ts
// 同步协议帧：11 种帧的严格 schema、字节预算与编解码。
//
// 为什么字节预算集中在这一层：帧是同步协议唯一进入网络与存储的字节边界，控制帧 ≤32KiB、数据帧含头
// ≤288KiB、头 ≤4KiB（设计 §8.3）必须在**编码前**与**解析前**各自判定——先编码再截断会静默丢数据，
// 先做无界解析则把超限输入的开销转嫁给接收方。
//
// 边界分工（本文件不做的事）：docId 谱系（`parseDocId`）、scope 归属与订阅配额、delivery 记账
// （`assertDeliveryAccounting`，属 E 阶段）分别由订阅层、握手层与传输层负责；帧层只保证结构与字节。
//
// 依赖方向（规格 §1）：protocol 不得 import capacity，故本文件的字节上限独立声明，与 `capacity/profile.ts`
// 的同类配置项同值；改动需同批修改并有测试覆盖。

import { z } from "zod/v4";
import { SYNC_ERROR_CODES, SyncProtocolError } from "./errors";
import { assertIdentifier, MAX_IDENTIFIER_BYTES } from "./identity";

export { MAX_IDENTIFIER_BYTES };

/** 当前协议版本。非本版本的帧由握手层在调用 `parseSyncFrame` 之前按 `PROTOCOL_VERSION_UNSUPPORTED` 拒绝。 */
export const SYNC_PROTOCOL_VERSION = 1;

/** 控制帧总字节上限（含头）。 */
export const MAX_CONTROL_FRAME_BYTES = 32 * 1024;

/** 数据帧总字节上限（含头与 base64 载荷）。 */
export const MAX_DATA_FRAME_BYTES = 288 * 1024;

/** 帧头（`frameHeaderOf` 的浅拷贝）字节上限。 */
export const MAX_FRAME_HEADER_BYTES = 4 * 1024;

/**
 * 任意可提交 Doc 快照的原始字节上限：按数据帧总预算扣除最大合法头与 base64 封装反推。
 *
 * 存储、实时轮换、历史构建、目录与运行态都只能引用本值；单独放宽任一层都会产生「写入成功、
 * 空客户端却无法用单帧重建」的快照。
 */
export const MAX_DOC_SNAPSHOT_BYTES = Math.floor((MAX_DATA_FRAME_BYTES - MAX_FRAME_HEADER_BYTES - 13) / 4) * 3;

/**
 * `SEALED.dependsOn` 条目上限。
 *
 * 与 §10.2 `inputs.dependsOnMax` 同值：超限一律拒绝而不是截断——截断会静默丢掉依赖，
 * 客户端随后会把「依赖缺失」误判成内容完整。
 */
export const MAX_SEALED_DEPENDS_ON = 8;

/** `ERROR.message` 的字符（码点）上限：只允许诊断短句，正文与凭据不得进入 ERROR 帧。 */
export const MAX_ERROR_MESSAGE_CHARS = 200;

/** 帧类：决定总字节上限与发送队列归属。 */
export type FrameClass = "control" | "data";

const UTF8_ENCODER = new TextEncoder();
/** 非法字节序列直接失败：替换字符会掩盖损坏，且带 U+FFFD 的标识仍可能通过 schema。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const protocolVersionField = z.literal(SYNC_PROTOCOL_VERSION);

/** 非负安全整数：序号、修订号与编码长度共用（zod 的 `.int()` 已排除超出安全整数范围的值）。 */
const nonNegativeInteger = z.number().int().min(0);

/**
 * 标识边界判定：直接复用 identity 的单一权威规则（非空、无控制字符、UTF-8 ≤256 字节）。
 *
 * 这里刻意只取「合格/不合格」，不重复实现规则也不向上抛具体码：帧层最终统一抛 `MALFORMED_FRAME`，
 * 需要精确原因（`IDENTIFIER_TOO_LONG`）的调用方走 `assertIdentifier`。
 */
function isBoundedIdentifier(value: string): boolean {
  try {
    assertIdentifier(value, "frame");
    return true;
  } catch {
    return false;
  }
}

/** 帧头标识字段：长度、控制字符与 `MAX_IDENTIFIER_BYTES` 由 identity 的规则统一约束。 */
function identifierField(field: string): z.ZodString {
  return z.string().refine(isBoundedIdentifier, {
    message: `${field} must be a non-empty identifier without control characters, at most ${MAX_IDENTIFIER_BYTES} UTF-8 bytes`,
  });
}

/** 诊断文本：拒绝 C0/C1/DEL 控制字符，避免把日志行拆开或伪造出结构。 */
function hasNoControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return false;
    }
  }
  return true;
}

/**
 * HELLO：握手声明。
 *
 * `stateful=false` 表示客户端**没有**任何本地状态（设计 §8.3）：禁止用空 state vector 表达「无状态」，
 * 否则服务端分不清「全新客户端」与「有状态但恰好为空」，会错误地只回差分。
 * `loadedDocs` 只带 Doc 身份与已应用边界、不带 payload，条目数由 4KiB 头预算天然受限。
 */
const helloFrameSchema = z.strictObject({
  type: z.literal("HELLO"),
  protocolVersion: protocolVersionField,
  scope: z.strictObject({
    organizationId: identifierField("scope.organizationId"),
    rcsSessionId: identifierField("scope.rcsSessionId"),
  }),
  generation: identifierField("generation").optional(),
  loadedDocs: z.array(
    z.strictObject({
      docId: identifierField("loadedDocs.docId"),
      subscriptionEpoch: identifierField("loadedDocs.subscriptionEpoch").optional(),
      syncAttemptId: identifierField("loadedDocs.syncAttemptId").optional(),
      lastAppliedSeq: nonNegativeInteger.optional(),
    }),
  ),
  stateful: z.boolean(),
});

/**
 * MANIFEST：当前代的入口与修订。
 *
 * `pointerRevision` / `referenceRevision` 是客户端挡住在途旧控制的依据：帧层只保证非负整数，
 * 「只增不减」的单调性由持有上一次取值的会话层判定。
 * `recoveryState` 的取值域由握手层与 ACP 绑定恢复流程共同定义，本层只按标识边界约束：固化枚举会把尚未
 * 冻结的恢复语义写进线上契约，且帧层没有判断取值合法性的依据。
 */
const manifestFrameSchema = z.strictObject({
  type: z.literal("MANIFEST"),
  protocolVersion: protocolVersionField,
  generation: identifierField("generation"),
  pointerRevision: nonNegativeInteger,
  referenceRevision: nonNegativeInteger,
  controlDocId: identifierField("controlDocId"),
  runtimeDocId: identifierField("runtimeDocId"),
  directoryDocId: identifierField("directoryDocId"),
  recoveryState: identifierField("recoveryState"),
});

/** SUBSCRIBE：申请订阅有限的 Doc 与优先级；空列表的语义（退订或空操作）归会话层，帧层不做语义裁剪。 */
const subscribeFrameSchema = z.strictObject({
  type: z.literal("SUBSCRIBE"),
  protocolVersion: protocolVersionField,
  docIds: z.array(identifierField("docIds[]")),
  priority: z.enum(["live", "currentHistory", "backgroundHistory"]),
});

/**
 * DOC_BASE：基线快照或差分。
 *
 * `mode` 必须显式给出（设计 §8.4）：空 payload 或相等的 state vector 都不能推断「无差分」，服务端必须
 * 实际应用后返回字节。`payloadDigest` / `encodedLength` 只服务传输层记账与字节校验，**不**构成
 * 「基线已可信」的证明——那是 `BASE_READY` 的语义。
 * 载荷用标准 base64（RFC 4648 字母表 + 填充）：浏览器 `atob` 只认这一种形态，url-safe 变体会在客户端
 * 静默失败，因此 schema 直接拒绝，而不是留到运行时再猜。
 * 摘要算法由注入的 `DigestFn` 决定，本层只按标识边界约束摘要串，不固化十六进制格式。
 */
const docBaseFrameSchema = z.strictObject({
  type: z.literal("DOC_BASE"),
  protocolVersion: protocolVersionField,
  docId: identifierField("docId"),
  generation: identifierField("generation"),
  transportEpoch: identifierField("transportEpoch"),
  subscriptionEpoch: identifierField("subscriptionEpoch"),
  syncAttemptId: identifierField("syncAttemptId"),
  deliveryId: identifierField("deliveryId"),
  baseSeq: nonNegativeInteger,
  mode: z.enum(["full", "diff"]),
  payloadDigest: identifierField("payloadDigest"),
  encodedLength: nonNegativeInteger,
  payload: z.base64(),
});

/**
 * BASE_READY：可信基线已建立，其后才允许发送尾部更新；与「退额度的 ACK」是两件事（设计 §8.4）。
 *
 * apply 返回或序号追平都不足以证明基线完整，因此这条控制帧必须独立存在。
 */
const baseReadyFrameSchema = z.strictObject({
  type: z.literal("BASE_READY"),
  protocolVersion: protocolVersionField,
  docId: identifierField("docId"),
  generation: identifierField("generation"),
  transportEpoch: identifierField("transportEpoch"),
  subscriptionEpoch: identifierField("subscriptionEpoch"),
  syncAttemptId: identifierField("syncAttemptId"),
  baseSeq: nonNegativeInteger,
});

/**
 * DOC_UPDATE：已持久化连续边界上的增量。
 *
 * 头沿用设计 §8.3 的通用数据帧头（protocolVersion、docId、generation、transportEpoch、
 * subscriptionEpoch、syncAttemptId、deliveryId）；`baseSeq` 与 `mode` 只属于 `DOC_BASE`，增量帧不接受：
 * 带上它们会让人误以为更新自带基线语义，而基线只由 `BASE_READY` 建立。
 * `fromSeq` / `toSeq` 的方向与连续性由应用层的 `SEQUENCE_GAP` 判定，帧层不做跨字段推算。
 */
const docUpdateFrameSchema = z.strictObject({
  type: z.literal("DOC_UPDATE"),
  protocolVersion: protocolVersionField,
  docId: identifierField("docId"),
  generation: identifierField("generation"),
  transportEpoch: identifierField("transportEpoch"),
  subscriptionEpoch: identifierField("subscriptionEpoch"),
  syncAttemptId: identifierField("syncAttemptId"),
  deliveryId: identifierField("deliveryId"),
  fromSeq: nonNegativeInteger,
  toSeq: nonNegativeInteger,
  payloadDigest: identifierField("payloadDigest"),
  encodedLength: nonNegativeInteger,
  payload: z.base64(),
});

/** SEALED：Doc 已封口。`snapshotDigest` 是服务端封口事实，不代表客户端已完整证明。 */
const sealedFrameSchema = z.strictObject({
  type: z.literal("SEALED"),
  protocolVersion: protocolVersionField,
  docId: identifierField("docId"),
  generation: identifierField("generation"),
  subscriptionEpoch: identifierField("subscriptionEpoch"),
  syncAttemptId: identifierField("syncAttemptId"),
  finalSeq: nonNegativeInteger,
  snapshotDigest: identifierField("snapshotDigest"),
  dependsOn: z.array(identifierField("dependsOn[]")).max(MAX_SEALED_DEPENDS_ON),
});

/** APPLY_ACK：只按自身账本结清一次投递；`appliedSeq` 仅在 `processed` 时有意义，客户端不得被信任字节数。 */
const applyAckFrameSchema = z.strictObject({
  type: z.literal("APPLY_ACK"),
  protocolVersion: protocolVersionField,
  transportEpoch: identifierField("transportEpoch"),
  deliveryId: identifierField("deliveryId"),
  result: z.enum(["processed", "rejected"]),
  docId: identifierField("docId"),
  appliedSeq: nonNegativeInteger.optional(),
});

/** RESYNC：废止旧计划（旧 subscriptionEpoch / syncAttemptId）并换新 attempt 重新协商基线。 */
const resyncFrameSchema = z.strictObject({
  type: z.literal("RESYNC"),
  protocolVersion: protocolVersionField,
  docId: identifierField("docId"),
  generation: identifierField("generation"),
  previousSubscriptionEpoch: identifierField("previousSubscriptionEpoch"),
  previousSyncAttemptId: identifierField("previousSyncAttemptId"),
  attemptId: identifierField("attemptId"),
});

/**
 * GENERATION_REPLACE：成套切换新代入口。
 *
 * 只接受更高的 `pointerRevision` 或同 revision 的一致重传（设计 §8.3）；帧层只保证字段齐全，
 * revision 比较与「成套切换」的原子性由会话层负责。
 */
const generationReplaceFrameSchema = z.strictObject({
  type: z.literal("GENERATION_REPLACE"),
  protocolVersion: protocolVersionField,
  generation: identifierField("generation"),
  pointerRevision: nonNegativeInteger,
  referenceRevision: nonNegativeInteger,
  controlDocId: identifierField("controlDocId"),
  directoryDocId: identifierField("directoryDocId"),
  runtimeDocId: identifierField("runtimeDocId"),
});

/**
 * ERROR：稳定协议码 + 安全上下文。
 *
 * `scope` 使用 `scopeKey()` 的归一化字符串，与 `SyncSafeContext.scope` 同一表示：ERROR 帧是安全上下文的
 * 线上形态，换成对象形态只会让两处表示需要互转，不增加信息。
 * `message` 是诊断短句：禁止控制字符（防日志注入），不得承载正文、工具参数、文件路径或凭据——
 * 长度上限拦不住内容泄露，这条靠调用方自律，`asSyncProtocolError` 也刻意不复制上游异常文本。
 */
const errorFrameSchema = z.strictObject({
  type: z.literal("ERROR"),
  protocolVersion: protocolVersionField,
  code: z.enum(SYNC_ERROR_CODES),
  retryable: z.boolean(),
  scope: identifierField("scope").optional(),
  generation: identifierField("generation").optional(),
  docId: identifierField("docId").optional(),
  message: z
    .string()
    .max(MAX_ERROR_MESSAGE_CHARS)
    .refine(hasNoControlCharacters, { message: "message must not contain control characters" })
    .optional(),
});

/** 帧联合：判别字段 `type`；成员 schema 全部严格，结构不允许未知字段穿透。 */
const syncFrameSchema = z.discriminatedUnion("type", [
  helloFrameSchema,
  manifestFrameSchema,
  subscribeFrameSchema,
  docBaseFrameSchema,
  baseReadyFrameSchema,
  docUpdateFrameSchema,
  sealedFrameSchema,
  applyAckFrameSchema,
  resyncFrameSchema,
  generationReplaceFrameSchema,
  errorFrameSchema,
]);

/** 各帧类型由 schema 推断：schema 是唯一定义来源，手写 interface 会与其漂移。 */
export type HelloFrame = z.infer<typeof helloFrameSchema>;
export type ManifestFrame = z.infer<typeof manifestFrameSchema>;
export type SubscribeFrame = z.infer<typeof subscribeFrameSchema>;
export type DocBaseFrame = z.infer<typeof docBaseFrameSchema>;
export type BaseReadyFrame = z.infer<typeof baseReadyFrameSchema>;
export type DocUpdateFrame = z.infer<typeof docUpdateFrameSchema>;
export type SealedFrame = z.infer<typeof sealedFrameSchema>;
export type ApplyAckFrame = z.infer<typeof applyAckFrameSchema>;
export type ResyncFrame = z.infer<typeof resyncFrameSchema>;
export type GenerationReplaceFrame = z.infer<typeof generationReplaceFrameSchema>;
export type ErrorFrame = z.infer<typeof errorFrameSchema>;

/** 同步帧联合。 */
export type SyncFrame = z.infer<typeof syncFrameSchema>;

/** 帧类型字面量联合。 */
export type SyncFrameType = SyncFrame["type"];

/** 帧类型 → 帧类。用穷举 Record 让新增帧类型在编译期必须分类（漏写即类型错误）。 */
const FRAME_CLASS_BY_TYPE: Readonly<Record<SyncFrameType, FrameClass>> = {
  HELLO: "control",
  MANIFEST: "control",
  SUBSCRIBE: "control",
  DOC_BASE: "data",
  BASE_READY: "control",
  DOC_UPDATE: "data",
  SEALED: "control",
  APPLY_ACK: "control",
  RESYNC: "control",
  GENERATION_REPLACE: "control",
  ERROR: "control",
};

/** 以字符串为键的查表：`decodeSyncFrame` 的类别探测只需字符串，不能借助已解析的帧对象。 */
const FRAME_CLASS_LOOKUP: ReadonlyMap<string, FrameClass> = new Map(Object.entries(FRAME_CLASS_BY_TYPE));

/** 未经 schema 校验的字符串类型名：未知类型返回 `undefined`，不得默认按控制帧处理。 */
function frameClassOfType(rawType: string): FrameClass | undefined {
  return FRAME_CLASS_LOOKUP.get(rawType);
}

/** 帧类：数据帧放宽到 `MAX_DATA_FRAME_BYTES`，其余一律按控制帧上限。 */
export function frameClassOf(frame: SyncFrame): FrameClass {
  const frameClass = frameClassOfType(frame.type);
  if (frameClass === undefined) {
    throw new SyncProtocolError("MALFORMED_FRAME", { message: "unknown sync frame type" });
  }
  return frameClass;
}

/**
 * 帧头的浅拷贝：去掉 `payload` 与 `message` 两个可承载大字节/自由文本的字段，用于头字节核算。
 *
 * 浅拷贝意味着 `scope`、`loadedDocs` 等嵌套对象仍与原帧共享引用（只读用途）；
 * 返回对象可被调用方删改而不影响原帧。
 */
export function frameHeaderOf(frame: SyncFrame): Record<string, unknown> {
  const header: Record<string, unknown> = { ...frame };
  delete header.payload;
  delete header.message;
  return header;
}

/**
 * 严格解析：结构与标识边界不合格一律 `MALFORMED_FRAME`。
 *
 * 协议版本不是本版本时同样在此失败（`protocolVersion` 是字面量）：版本协商属于握手层，它在解析前比较
 * 原始 `protocolVersion` 并以 `PROTOCOL_VERSION_UNSUPPORTED` 回错，本层不另开一条错误分支。
 * 错误信息不回显输入：帧可能含正文，异常文本会被带进日志与 ERROR 帧。
 */
export function parseSyncFrame(input: unknown): SyncFrame {
  const parsed = syncFrameSchema.safeParse(input);
  if (!parsed.success) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      cause: parsed.error,
      message: "frame does not match any sync frame schema",
    });
  }
  return parsed.data;
}

/**
 * 编码：先按头字节判定 ≤4KiB，再整体 JSON 编码，最后按帧类判定总字节。
 *
 * 顺序不可交换：先编码会把「超大头的帧」在内存里摊开后才失败。校验失败一律抛错、不截断——截断后的帧能
 * 通过长度检查却丢失内容，比直接失败更糟。入参视为已类型化的帧，本层不重复 schema 校验；来自外部字节的
 * 帧必须先经 `decodeSyncFrame`。
 */
export function encodeSyncFrame(frame: SyncFrame): Uint8Array {
  const headerBytes = UTF8_ENCODER.encode(JSON.stringify(frameHeaderOf(frame))).length;
  if (headerBytes > MAX_FRAME_HEADER_BYTES) {
    throw new SyncProtocolError("FRAME_HEADER_TOO_LARGE", {
      message: `frame header is ${headerBytes} bytes, limit is ${MAX_FRAME_HEADER_BYTES} bytes`,
    });
  }
  const bytes = UTF8_ENCODER.encode(JSON.stringify(frame));
  const limitBytes = frameClassOf(frame) === "data" ? MAX_DATA_FRAME_BYTES : MAX_CONTROL_FRAME_BYTES;
  if (bytes.length > limitBytes) {
    throw frameTooLarge(bytes.length, limitBytes);
  }
  return bytes;
}

/**
 * 解码：两道有界长度判定 → UTF-8 解码 → `JSON.parse` → 严格解析。
 *
 * 判定顺序保证「先拒绝、后解析」：超过数据帧上限直接失败，不触碰内容；介于控制帧与数据帧上限之间时，
 * 只有从文本里探测出 data 类判别字段才允许放宽。探测是有界线性扫描且可能被字符串内容误导，因此解析后
 * 还有一次以**解析结果**为准的类别与长度复核——放宽只可能被收紧，不会被误用。
 */
export function decodeSyncFrame(bytes: Uint8Array): SyncFrame {
  const length = bytes.length;
  if (length > MAX_DATA_FRAME_BYTES) {
    throw frameTooLarge(length, MAX_DATA_FRAME_BYTES);
  }
  const text = decodeUtf8(bytes);
  if (length > MAX_CONTROL_FRAME_BYTES) {
    const probedType = probeTopLevelType(text);
    if (probedType === null || frameClassOfType(probedType) !== "data") {
      throw frameTooLarge(length, MAX_CONTROL_FRAME_BYTES);
    }
  }
  const frame = parseSyncFrame(parseJsonText(text));
  if (length > MAX_CONTROL_FRAME_BYTES && frameClassOf(frame) === "control") {
    throw frameTooLarge(length, MAX_CONTROL_FRAME_BYTES);
  }
  return frame;
}

/** 超限错误：只带实际字节数与所属上限，不回显帧内容。 */
function frameTooLarge(actualBytes: number, limitBytes: number): SyncProtocolError {
  return new SyncProtocolError("FRAME_TOO_LARGE", {
    message: `frame is ${actualBytes} bytes, limit for this class is ${limitBytes} bytes`,
  });
}

/** UTF-8 解码：非法序列是畸形输入，不能用 U+FFFD 顶替后继续解析。 */
function decodeUtf8(bytes: Uint8Array): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw new SyncProtocolError("MALFORMED_FRAME", {
      cause: error,
      message: "frame bytes are not valid UTF-8",
    });
  }
}

/** JSON 解析失败即畸形帧；不回显原始文本，避免把正文带进日志与错误帧。 */
function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SyncProtocolError("MALFORMED_FRAME", { cause: error, message: "frame is not valid JSON" });
  }
}

function skipJsonWhitespace(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
      index += 1;
    } else {
      break;
    }
  }
  return index;
}

/**
 * 探测顶层 `type` 的字符串值，用于在 `JSON.parse` 之前决定适用哪一档字节上限。
 *
 * 只找第一个 `"type"` 下标字面量并读取紧随其后的字符串值：不构造对象、不递归，代价是 O(字节数)。
 * JSON 字符串里的引号必须转义，故非法的 `"type"` 序列不会出现在字符串内容中；即便被内容误导，
 * `decodeSyncFrame` 解析后的复核仍以真实帧类为准，不会把控制帧当成数据帧放行。
 */
function probeTopLevelType(text: string): string | null {
  const keyIndex = text.indexOf('"type"');
  if (keyIndex < 0) {
    return null;
  }
  let index = skipJsonWhitespace(text, keyIndex + '"type"'.length);
  if (text[index] !== ":") {
    return null;
  }
  index = skipJsonWhitespace(text, index + 1);
  if (text[index] !== '"') {
    return null;
  }
  const valueEnd = text.indexOf('"', index + 1);
  if (valueEnd < 0) {
    return null;
  }
  return text.slice(index + 1, valueEnd);
}
