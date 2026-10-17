// packages/chat-channel/src/sync/client/transport.ts
// 客户端同步传输适配（设计 §8.6，规格 §2.5，裁决 D2）：入站帧 → `ApplyTask` → DocHub，结果 → `APPLY_ACK`
// / `RESYNC` 帧。
//
// 为什么需要这一层：现有 `transport/ws.ts` 是 Yjs 语义的同构 WS 客户端（不做帧解码、无 deliveryId 记账、无基线
// 补齐语义），与本协议的入站单位（`SyncFrame`）不吻合；把解码、身份记账与回执编帧收在这里，DocHub 才能保持纯职责。
// 浏览器安全（规格 §2.5）：不 import node 内建、fs、process、Buffer；时间取注入的 `now`，不直取全局时钟；
// 载荷解码不使用全局 `atob`（本包 lib 不含 DOM，声明全局只会在每个消费方重复）。
//
// 回执契约（裁决 D2）：**两种结果都要回执**，`rejected` 不得静默丢弃。服务端 `session.onAck(deliveryId,
// result)` 对两种结果都先 `ledger.settle` 归还额度，`rejected` 另把该 Doc 置为 resync-required；而
// `ack-ledger` 自身没有超时，唯一兜底是连接级 ackDeadline——不回执等于让服务端额度与游标悬挂到断连。
// `doc-hub.ts` 的 `ApplyOutcome` 注释「`processed` 才允许被调用方当作 ACK 发出」约束的是**不得把 rejected
// 当成功回执**（不得借它推进服务端 base/appliedSeq 游标），不是「rejected 不发回执」：本层把结果原样带回
// 帧里，由服务端按 `result` 分流。
//
// 结果 → 动作穷举表（回执一律先发，动作是附加项；`REJECT_ACTION` 与表一一对应，新增原因时编译器强制补表）：
// | 拒绝原因 | 追加动作 | 理由 |
// | base-not-ready / sequence-gap / apply-failed / duplicate-range | RESYNC | 帧属于当前 attempt，服务端
//   onAck 会给该 Doc 置 resync-required 并停止 pump，不补拉即永久停摆；duplicate-range 无内容风险但同样落在
//   当前 attempt 上，故同路。 |
// | generation-mismatch | RESYNC | 本层不裁决代次归属：RESYNC 把问题交回服务端（代次权威），其答复为 RESYNC 或 ERROR。 |
// | subscription-epoch-stale / sync-attempt-stale | 无 | 纯作废：服务端因 attempt 引用不等而提前返回（不置
//   resync-required），此时补拉反而会用旧身份换掉健康的当前 attempt。 |
// | unknown-doc | 无 | 该 Doc 已 release（doc-hub「只结清传输额度，不申请补齐」），只为它结清账本。 |
// | malformed-task → MALFORMED_FRAME；payload-too-large / queue-overflow → CAPACITY_EXCEEDED；词表外原因 →
//   MALFORMED_FRAME | onFatal | 本层无法承载或契约漂移、不能自愈：结构非法（帧 schema + 本层构造之下不可达）、
//   超出接收预算、拒绝原因漂移；上报后由调用方重建连接，回执仍先发出，不悬挂投递。 |
//
// 顺序即契约：先回执（结清服务端账本），再补拉或上报——settle 与业务恢复是两件事（与 `onAck` 同序）。
// `onFrame` 是 onmessage 边界：解码与载荷失败一律转 `onFatal`，异常不得抛回调用方栈上（那里是浏览器事件
// 循环，抛错没有接收者）。

import { CLIENT_BUDGET } from "../capacity/profile";
import { asSyncProtocolError, type SyncErrorCode, SyncProtocolError } from "../protocol/errors";
import {
  type ApplyAckFrame,
  type DocBaseFrame,
  type DocUpdateFrame,
  decodeSyncFrame,
  encodeSyncFrame,
  type ResyncFrame,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../protocol/frames";
import { createSyncAttemptId, parseDocId } from "../protocol/identity";
import {
  APPLY_REJECT_REASONS,
  type ApplyOutcome,
  type ApplyRejectReason,
  type ApplyTask,
  createDocHub,
  type DocHub,
} from "./doc-hub";

export interface SyncClientTransportOptions {
  readonly send: (bytes: Uint8Array) => boolean; // 已认证 WS 发送；false = 饱和，调用方重试
  readonly now: () => number;
  readonly yieldToHost: () => Promise<void>;
  /** 收到控制帧（HELLO/MANIFEST/SEALED/GENERATION_REPLACE/ERROR）：本层不自行解释，交给上层。 */
  readonly onControl?: (frame: SyncFrame) => void;
  /** 协议级失败（ERROR 帧或解码失败）：调用方据此提示重建连接。 */
  readonly onFatal: (code: string, detail?: string) => void;
}

export interface SyncClientTransport {
  /** onmessage 边界：解码 → 数据帧转 `ApplyTask` 入 hub；控制帧交 `onControl`。 */
  onFrame(bytes: Uint8Array): void;
  /** 驱动一次 apply 调度（内部转调 `hub.drain`）；两种结果的回执都由本层编成 `APPLY_ACK` 帧发出。 */
  drain(): Promise<void>;
  /** 主动申请补齐某 Doc（RESYNC 帧）。 */
  requestResync(docId: string): void;
  readonly hub: DocHub;
  dispose(): void;
}

/** 一次已发出数据帧的本地记账：`ApplyOutcome` 只带 deliveryId，回执与身份都要在此保留。 */
interface DeliveryRecord {
  readonly docId: string;
  readonly transportEpoch: string;
  readonly subscriptionEpoch: string;
  readonly syncAttemptId: string;
}

/** 某 Doc 当前在途的订阅身份：RESYNC 必填的「旧 subscriptionEpoch / 旧 syncAttemptId」来源。 */
interface DocIdentity {
  readonly subscriptionEpoch: string;
  readonly syncAttemptId: string;
}

/** `rejected` 的追加动作：换新 attempt 补基线、不补拉，或按连接级失败上报（穷举与理由见文件头表）。 */
type RejectAction =
  | { readonly kind: "resync" }
  | { readonly kind: "ack-only" }
  | { readonly kind: "fatal"; readonly code: SyncErrorCode };

/** 词表全量：分类只按 `APPLY_REJECT_REASONS` 的取值，不做自由文本匹配。 */
const KNOWN_REJECT_REASONS: readonly ApplyRejectReason[] = Object.values(APPLY_REJECT_REASONS);

/** `APPLY_REJECT_REASONS` → 追加动作的穷举表：回执与动作解耦，本表只决定「是否补拉 / 是否上报」。 */
const REJECT_ACTION: Readonly<Record<ApplyRejectReason, RejectAction>> = {
  [APPLY_REJECT_REASONS.malformedTask]: { kind: "fatal", code: "MALFORMED_FRAME" },
  [APPLY_REJECT_REASONS.unknownDoc]: { kind: "ack-only" },
  [APPLY_REJECT_REASONS.generationMismatch]: { kind: "resync" },
  [APPLY_REJECT_REASONS.subscriptionEpochStale]: { kind: "ack-only" },
  [APPLY_REJECT_REASONS.syncAttemptStale]: { kind: "ack-only" },
  [APPLY_REJECT_REASONS.baseNotReady]: { kind: "resync" },
  [APPLY_REJECT_REASONS.sequenceGap]: { kind: "resync" },
  [APPLY_REJECT_REASONS.duplicateRange]: { kind: "resync" },
  [APPLY_REJECT_REASONS.payloadTooLarge]: { kind: "fatal", code: "CAPACITY_EXCEEDED" },
  [APPLY_REJECT_REASONS.queueOverflow]: { kind: "fatal", code: "CAPACITY_EXCEEDED" },
  [APPLY_REJECT_REASONS.applyFailed]: { kind: "resync" },
};

/**
 * 待发控制帧缓冲：与接收侧共用同一份客户端控制预算（`CLIENT_BUDGET`），不另抄数值。
 *
 * 必须缓冲而不是丢弃：`send` 返回 false 只表示瞬时饱和，被丢掉的 APPLY_ACK 会让服务端账本一直挂到断连。
 */
const PENDING_FRAMES_MAX = CLIENT_BUDGET.receiveQueueTasks;
const PENDING_BYTES_MAX = CLIENT_BUDGET.receiveControlBytes;

/** 标准 base64 字母表（RFC 4648 §4）：索引即 6 位值，`-1` 表示非法字符。 */
const BASE64_LOOKUP = ((): Int16Array => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const lookup = new Int16Array(128).fill(-1);
  for (let index = 0; index < alphabet.length; index += 1) {
    lookup[alphabet.charCodeAt(index)] = index;
  }
  return lookup;
})();

function malformedPayload(): SyncProtocolError {
  return new SyncProtocolError("MALFORMED_FRAME", { message: "payload is not standard base64 or length mismatched" });
}

/**
 * 严格标准 base64 解码：字符必须在字母表内，`=` 只允许出现在末组尾部，长度必须是 4 的倍数。帧 schema 已
 * 限定该形态也不省掉判定：静默解出错误字节会让 Yjs 应用一段损坏的 update（apply 失败会弃用该 Doc 实例）。
 */
function decodeBase64(text: string): Uint8Array {
  const padding = text.endsWith("==") ? 2 : text.endsWith("=") ? 1 : 0;
  if (text.length % 4 !== 0) {
    throw malformedPayload();
  }
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  const contentLength = text.length - padding;
  let written = 0;
  for (let offset = 0; offset < text.length; offset += 4) {
    let group = 0;
    for (let slot = 0; slot < 4; slot += 1) {
      const index = offset + slot;
      const code = text.charCodeAt(index);
      if (index >= contentLength) {
        if (code !== 0x3d) {
          throw malformedPayload(); // `=` 出现在内容区：把它当 0 解会静默产出错误字节。
        }
        group <<= 6;
        continue;
      }
      const digit = code < BASE64_LOOKUP.length ? BASE64_LOOKUP[code] : -1;
      if (digit < 0) {
        throw malformedPayload();
      }
      group = (group << 6) | digit;
    }
    // 填充组只写得出已确定的字节；`written` 守卫同时挡住末组的多余输出。
    if (written < bytes.length) bytes[written++] = (group >>> 16) & 0xff;
    if (written < bytes.length) bytes[written++] = (group >>> 8) & 0xff;
    if (written < bytes.length) bytes[written++] = group & 0xff;
  }
  return bytes;
}

/**
 * 载荷解码 + `encodedLength` 交叉校验。摘要需要注入的 `DigestFn`（本层 options 不含），长度是本层唯一可自行
 * 验证的不变量：服务端在两个数据帧构造点都写 `payload.byteLength`（`provider/session.ts` base 与 tail 路径）。
 */
function decodePayload(base64: string, encodedLength: number): Uint8Array {
  const bytes = decodeBase64(base64);
  if (bytes.byteLength !== encodedLength) {
    throw malformedPayload();
  }
  return bytes;
}

/** 数据帧 → `ApplyTask`：`DOC_BASE` 的应用区间是 `0..baseSeq`，增量的区间由帧自身给出。 */
function toApplyTask(frame: DocBaseFrame | DocUpdateFrame): ApplyTask {
  const common = {
    docId: frame.docId,
    generation: frame.generation,
    subscriptionEpoch: frame.subscriptionEpoch,
    syncAttemptId: frame.syncAttemptId,
    deliveryId: frame.deliveryId,
    payload: decodePayload(frame.payload, frame.encodedLength),
    digest: frame.payloadDigest,
  };
  return frame.type === "DOC_BASE"
    ? { kind: "base", ...common, fromSeq: 0, toSeq: frame.baseSeq }
    : { kind: "update", ...common, fromSeq: frame.fromSeq, toSeq: frame.toSeq };
}

/**
 * 词表比对只看前缀：doc-hub 的 `apply-failed` 会把 Yjs 原文接在冒号之后（原因词表只保证前缀，
 * 诊断后缀不参与分类）。词表外的原因返回 null，由调用方按协议级失败处理。
 */
function classifyRejectReason(reason: string | undefined): ApplyRejectReason | null {
  if (reason === undefined) {
    return null;
  }
  for (const known of KNOWN_REJECT_REASONS) {
    if (reason === known || reason.startsWith(`${known}:`)) {
      return known;
    }
  }
  return null;
}

export function createSyncClientTransport(options: SyncClientTransportOptions): SyncClientTransport {
  const deliveries = new Map<string, DeliveryRecord>();
  const identities = new Map<string, DocIdentity>();
  const resyncInFlight = new Map<string, DocIdentity>();
  const pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let resyncSequence = 0;
  let disposed = false;

  const hub = createDocHub({
    // 接收队列与调度预算全部取自 `CLIENT_BUDGET`（单一来源）：条数/字节决定一次调度最多清空一整个接收队列，
    // 时间上限取 apply 切片目标——超过它就该让出执行权（doc-hub 的预算是「两次 apply 之间」的判定）。
    maxQueueBytes: CLIENT_BUDGET.receiveQueueBytes,
    maxQueueTasks: CLIENT_BUDGET.receiveQueueTasks,
    budget: {
      maxBytes: CLIENT_BUDGET.receiveQueueBytes,
      maxTasks: CLIENT_BUDGET.receiveQueueTasks,
      maxMillis: CLIENT_BUDGET.applySliceTargetMs,
    },
    now: options.now,
    yieldToHost: options.yieldToHost,
    onOutcome: handleOutcome,
    onResyncRequired: (docId, reason) => emitResync(docId, reason, false),
  });

  function reportFatal(error: SyncProtocolError): void {
    // 只把稳定码与安全短句交给调用方：`SyncProtocolError` 不回显输入，`cause` 留给本地诊断。
    options.onFatal(error.code, error.message);
  }

  function emitFrame(frame: SyncFrame): void {
    if (disposed) {
      return;
    }
    let bytes: Uint8Array;
    try {
      bytes = encodeSyncFrame(frame);
    } catch (error) {
      // 编帧失败说明本层要发的帧自身不合法（头/总字节超限）：不抛到调度栈上，也不静默丢。
      reportFatal(asSyncProtocolError(error, "MALFORMED_FRAME"));
      return;
    }
    if (pending.length > 0) {
      // 先到先发：越过后面的帧会让服务端的 deliveryId 结算次序与本端观察不一致。
      holdFrame(bytes);
      return;
    }
    if (!options.send(bytes)) {
      holdFrame(bytes);
    }
  }

  function holdFrame(bytes: Uint8Array): void {
    if (pending.length + 1 > PENDING_FRAMES_MAX || pendingBytes + bytes.byteLength > PENDING_BYTES_MAX) {
      // 持续饱和且待发控制帧超过整份客户端控制预算：连接已不可用，清空积压并显式上报（不静默丢）。
      pending.length = 0;
      pendingBytes = 0;
      options.onFatal("CAPACITY_EXCEEDED", "pending sync control frames exceed the client control budget");
      return;
    }
    pending.push(bytes);
    pendingBytes += bytes.byteLength;
  }

  function flushPending(): void {
    while (!disposed && pending.length > 0) {
      const head = pending[0];
      if (head === undefined || !options.send(head)) {
        return;
      }
      pending.shift();
      pendingBytes -= head.byteLength;
    }
  }

  /** 回执编帧：`result` 原样带回；`appliedSeq` 只在 `processed` 时有意义（帧 schema 注释），故一律不带。 */
  function emitApplyAck(deliveryId: string, delivery: DeliveryRecord, result: "processed" | "rejected"): void {
    const ack: ApplyAckFrame = {
      type: "APPLY_ACK",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      transportEpoch: delivery.transportEpoch,
      deliveryId,
      result,
      docId: delivery.docId,
    };
    emitFrame(ack);
  }

  function handleOutcome(outcome: ApplyOutcome): void {
    if (disposed) {
      return;
    }
    const delivery = deliveries.get(outcome.deliveryId);
    if (delivery === undefined) {
      // 同一 deliveryId 的重复投递会先被一个结果结清（服务端账本也按 deliveryId 只结算一次），
      // 其后到的事件没有可编的帧：这里忽略的是已结算的重复信息，不是新信息。
      return;
    }
    deliveries.delete(outcome.deliveryId);
    if (outcome.result === "processed") {
      // 与当前 attempt 一致的身份只能由「已被应用」证明：迟到的旧帧虽会被 hub 拒（见下方 rejected 分支），
      // 但若在此前覆盖身份表，RESYNC 就会拿着已废止的旧 epoch/attempt 去申请补齐。
      rememberIdentity(delivery);
      const requested = resyncInFlight.get(delivery.docId);
      if (
        requested !== undefined &&
        (requested.subscriptionEpoch !== delivery.subscriptionEpoch ||
          requested.syncAttemptId !== delivery.syncAttemptId)
      ) {
        // 新 attempt 的数据已被应用，说明上一次补齐申请已由服务端处理：解除该 Doc 的限流。
        resyncInFlight.delete(delivery.docId);
      }
      // `processed` 是唯一允许推进服务端 base/appliedSeq 游标的结果，但回执形态与结果无关（裁决 D2）。
      emitApplyAck(outcome.deliveryId, delivery, "processed");
      return;
    }
    // 先回执再决策：服务端按 `result` 分流（`rejected` 只归额度并把该 Doc 置为 resync-required），
    // 分类只决定本层是否追加补拉或上报，不影响这笔投递必须被结清。
    emitApplyAck(outcome.deliveryId, delivery, "rejected");
    const reason = classifyRejectReason(outcome.reason);
    if (reason === null) {
      // 词表外的拒绝原因意味着 doc-hub 的契约漂移：账本已结清，但没有可执行的动作，只能按协议级失败上报。
      options.onFatal("MALFORMED_FRAME", "apply outcome carries an unknown reject reason");
      return;
    }
    const action = REJECT_ACTION[reason];
    if (action.kind === "resync") {
      emitResync(delivery.docId, reason, false);
      return;
    }
    if (action.kind === "fatal") {
      options.onFatal(action.code, reason);
    }
  }

  function emitResync(docId: string, detail: string, force: boolean): void {
    if (disposed) {
      return;
    }
    const identity = identities.get(docId);
    if (identity === undefined) {
      // 从未收到该 Doc 的数据帧（或身份表已淘汰最旧项）：RESYNC 必填的旧 epoch/attempt 无从给出。
      options.onFatal("DOC_NOT_FOUND", detail);
      return;
    }
    if (!force && resyncInFlight.has(docId)) {
      // 限流：同一 Doc 的补齐申请在收到新 attempt 前只发一次，否则一次缺口会把 RESYNC 打成一串。
      return;
    }
    let generation: string;
    try {
      // 代次只由握手 / GENERATION_REPLACE 引入：docId 谱系是它的唯一本地权威（与 doc-hub 的归属判定同源）。
      generation = parseDocId(docId).generation;
    } catch (error) {
      reportFatal(asSyncProtocolError(error, "MALFORMED_FRAME"));
      return;
    }
    resyncInFlight.set(docId, identity);
    const resync: ResyncFrame = {
      type: "RESYNC",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      docId,
      generation,
      previousSubscriptionEpoch: identity.subscriptionEpoch,
      previousSyncAttemptId: identity.syncAttemptId,
      attemptId: nextAttemptId(),
    };
    emitFrame(resync);
  }

  /**
   * RESYNC 需要的新 attemptId：options 的冻结签名不含 `RandomSource`，本层也不得直取全局随机（规格 §1 第 4 条），
   * 故用注入的 `now` + 单调计数器派生 8 字节，只保证「本连接内不重复」——换 attempt 由服务端在 `session.resync`
   * 里自行生成，客户端这一字段只是满足帧 schema（形态复用 `createSyncAttemptId`，不另造格式）。
   */
  function nextAttemptId(): string {
    resyncSequence += 1;
    const entropy = new Uint8Array(8);
    const stamp = BigInt(Math.max(0, Math.trunc(options.now())));
    new DataView(entropy.buffer).setBigUint64(0, stamp * 1024n + BigInt(resyncSequence));
    return createSyncAttemptId({ bytes: (length: number): Uint8Array => entropy.slice(0, length) });
  }

  /**
   * 身份表：只保存「已被应用」的 attempt（`handleOutcome` 的 processed 分支），或在还没有任何已应用帧时
   * 采用首个到达帧的身份——「基线未到先来增量」时它确实是服务端的当前 attempt，除此之外没有别的依据。
   */
  function rememberIdentity(identity: DocIdentity & { readonly docId: string }): void {
    if (!identities.has(identity.docId) && identities.size >= CLIENT_BUDGET.maxResidentDocs) {
      // 身份表与驻留 Doc 同量级（`maxResidentDocs`）：超出的最旧条目被淘汰，其后的 RESYNC 走
      // 「身份无从给出」的显式失败路径，而不是拿过期身份去废止服务端的当前 attempt。
      const oldest = identities.keys().next();
      if (!oldest.done) {
        identities.delete(oldest.value);
      }
    }
    identities.set(identity.docId, {
      subscriptionEpoch: identity.subscriptionEpoch,
      syncAttemptId: identity.syncAttemptId,
    });
  }

  function acceptDataFrame(frame: DocBaseFrame | DocUpdateFrame): void {
    let task: ApplyTask;
    try {
      task = toApplyTask(frame);
    } catch (error) {
      // 载荷解码失败与解码失败同级：不进队、不抛回调用方栈，转 onFatal。
      reportFatal(asSyncProtocolError(error, "MALFORMED_FRAME"));
      return;
    }
    // 记账必须早于 `enqueue`：hub 会在入队路径上同步回调 rejected（未 retain、代次不符、队列满），
    // 那些结果要用到这里的 docId/transportEpoch。
    deliveries.set(task.deliveryId, {
      docId: task.docId,
      transportEpoch: frame.transportEpoch,
      subscriptionEpoch: task.subscriptionEpoch,
      syncAttemptId: task.syncAttemptId,
    });
    if (!identities.has(task.docId)) {
      // 首次观测回填：该 Doc 还没有任何已应用帧，这个身份是编 RESYNC 时唯一能用的依据。
      rememberIdentity(task);
    }
    hub.enqueue(task);
  }

  function onFrame(bytes: Uint8Array): void {
    if (disposed) {
      return;
    }
    let frame: SyncFrame;
    try {
      frame = decodeSyncFrame(bytes);
    } catch (error) {
      reportFatal(asSyncProtocolError(error, "MALFORMED_FRAME"));
      return;
    }
    switch (frame.type) {
      case "DOC_BASE":
      case "DOC_UPDATE":
        acceptDataFrame(frame);
        return;
      case "ERROR":
        // ERROR 帧是服务端的终态通告：`onFatal` 的签名（码 + 安全短句）与它一一对应，
        // 因此不再重复投给 `onControl`（同一个事实两个出口只会让调用方重复决策）。
        options.onFatal(frame.code, frame.message);
        return;
      default:
        options.onControl?.(frame);
    }
  }

  async function drain(): Promise<void> {
    if (disposed) {
      return;
    }
    await hub.drain();
    // 结果回调在 drain 期间同步产出帧；饱和时留下的积压在这里冲一次，恢复后立即追平。
    flushPending();
  }

  function requestResync(docId: string): void {
    // 调用方显式申请：不受「同一 Doc 只发一次」的限流约束。
    emitResync(docId, "resync-requested", true);
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    disposed = true;
    // 断连清账由上层整体重置（§8.5）：本层不再补回执、不再回调消费方，Doc 与队列交给 hub 自行释放。
    deliveries.clear();
    identities.clear();
    resyncInFlight.clear();
    pending.length = 0;
    pendingBytes = 0;
    hub.dispose();
  }

  return { onFrame, drain, requestResync, hub, dispose };
}
