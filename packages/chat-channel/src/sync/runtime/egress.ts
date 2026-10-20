// packages/chat-channel/src/sync/runtime/egress.ts
// G2 出帧网关（规格 §2.4；额度职责按裁决 §6.1 收口）：入站字节的版本协商与派发、出站的 socket 门禁与帧类交接、
// ACK 登记与超时扫描、搁置帧的重试与连接终态收敛。
//
// 入站顺序不可交换：尺寸预检 → **原始** `protocolVersion` 协商 → `decodeSyncFrame` → 派发给会话 → 回帧走本层出站路径。
// 协商必须在严格解析之前：`protocolVersion` 在 schema 里是字面量，先解析只会把「版本不对」报成 `MALFORMED_FRAME`，
// 客户端拿不到「请重新加载」的可操作原因；不兼容时回一条 ERROR 帧并关闭连接，不静默降级。
//
// 出站两段：**先编码再判定**，然后按帧类分流（控制帧过 governor，数据帧直接交接）。判定必须用真实编码字节：按
// `message.length` 估算（UTF-16 代码单元）对多字节文本是低估，会在临界区放行超水位帧。一帧的编码代价有界
// （数据帧 ≤ `MAX_DATA_FRAME_BYTES`、控制帧 ≤ 头预算），因此「先编码」不会被放大成编码风暴（设计 §8.4 关心的是
// 持续饱和下的重复编码，由「搁置位只有一位」限住，见偏差④）。
//
// 偏差与依据（偏离规格 §2.4 的文字，均因既有实现已持有账目或规格自身缺口；移除条件见每条）：
// ① 网关**不参与额度记账**（§2.4 要求数据帧走 `quota.tryReserve` / `quota.release`）：连接窗口（已发送未 ACK
//    字节）的唯一所有者在 `session` + `AckLedger`——session 每帧已 `tryReserve`，ACK 经 `ledger.onRelease` 归还
//    （`session.ts:192-200`）。网关对同一帧再记一次会让在途帧被扣两份，连接窗口等于减半；故工厂入参没有额度。
// ② 网关的判据只剩 socket 真值：`transport.bufferedAmount() + 真实编码字节 > config.quota.socketHighWatermark`
//    即拒发该帧（该水位与 `capacity.concurrency.socketHighWatermarkBytes` 等值，装配期已断言）。这是网关能
//    提供而会话拿不到的唯一真值。
// ③ 残留近似：会话内部的 socket 水位仍以未结算字节近似（`session.ts:199-200`，本阶段不可改），原先「网关预留时
//    注入真实 `bufferedAmount`」的路径随额度一并删除。影响：会话可能产出一条会顶到水位之上的帧，由本层门禁在
//    下一次出帧时拦下。移除条件＝session 能接收注入的 bufferedAmount。
// ④ 搁置与重试（取代原先的「只留一位引用且不重试」，被拒帧既不重发也不登记会让缺口永久跳过）：
//    - 搁置位只有一位：帧 + **本段搁置的最早时刻** + 拒发原因；起始时刻不随后续帧刷新，否则连续拒发可以一边丢帧
//      一边永不超期，连接永久停发而没有定时器来清账。
//    - 重试由编排者 `tick()` 经 `driveWithheld()` 驱动：传输饱和（socket 门禁拒发或 `send` 返回 false）每 tick
//      重试一次；控制限流（governor 拒发）不在 tick 重试（T22-2 固化的契约：搁置 ≠ 排队重发），只在搁置期限到期
//      时做一次「最后机会」重试——客户端因此不再停在无重试触发、也无超时的半握手。
//    - 终态：搁置到期仍发不出去即由本层关连接，与 ACK 超时共用同一条收敛路径（`onConnectionClosed`），不会出现
//      「宿主关了连接而 tick 仍推进会话」或「清了账但会话仍被驱动」。
//    - 重试不产生重复投递：帧在发出前先从搁置位移除，发出的就是搁置位里那唯一一份；同一 `deliveryId` 不会既被
//      登记又在搁置位（登记只发生在交接成功后，而那一刻帧已离开搁置位），会话也从不重发同一 `deliveryId`。
//    - 顶替按帧类分流（「只留一位」的必要补全，否则被换下的那一帧既无归宿也无补偿）：
//      · 数据帧被顶替：通知 `onDeliveryAbandoned` 由账本所有者归还窗口字节（它从未上线，客户端无从回执；
//        规格 §2.4「`send` 返回 false 时归还上次预留」）。缺口不在这里补——设计 §8.5 允许丢弃冗余发送任务
//        （「丢弃的是冗余发送任务，不是唯一内容」），客户端检出序号缺口后申请补齐（§8.3、场景矩阵 T10）。
//      · 控制帧被顶替：直接关连接。控制帧线上不带 `deliveryId`、没有第二次产出它的入口，静默顶替会留下
//        「看起来健康、实际订不到内容」的半握手；补发在单搁置位下不可能发生，于是只剩明确断连这一条出路。
// ⑤ 版本不兼容的 ERROR 帧走终结路径、不进门禁与控制窗口：这条帧之后连接立即关闭，若也被挡下，「版本不对」
//    都报不出去，客户端只能看到无声断开。
// ⑥ 公开面比 §2.4 多一个方法：`driveWithheld()`（§2.4 未列）。重试必须由 `tick()` 驱动，而 `scanTimeouts()` 的
//    语义是「只判定超期数」，把出帧塞进它会让判定与动作在同一方法里不可分；故另开一个名实一致的入口。
//
// 本层不做的事：不持有额度/账本/存储（记账职责见偏差①），不解释业务语义（派发即转交），不清账——会话/额度/账本/
// 投递登记的清理由 `onConnectionClosed` 通知编排者执行（规格 §2.2 第 3 条，清账只做一次且幂等）。

import type { Clock } from "../clock";
import { SyncProtocolError } from "../protocol/errors";
import {
  decodeSyncFrame,
  type ErrorFrame,
  encodeSyncFrame,
  frameClassOf,
  MAX_DATA_FRAME_BYTES,
  SYNC_PROTOCOL_VERSION,
  type SyncFrame,
} from "../protocol/frames";
import { type SyncScope, scopeKey } from "../protocol/identity";
import type { AckTimeoutTracker } from "../provider/ack-timeout";
import type { ControlGovernor } from "../provider/control-governor";
import type { OutboundFrame, ProviderSession } from "../provider/session";
import type { SyncRuntimeConfig } from "./config";

/** 出站传输端口：由宿主把已认证 WebSocket 适配到这三个原语。 */
export interface SyncFrameTransport {
  /** 发送一帧已编码字节；返回 false 表示传输层饱和（调用方保留任务引用，不重试同一帧）。 */
  send(bytes: Uint8Array): boolean;
  /** socket 待发送字节真值（`bufferedAmount` 口径），消除 session 的未结算字节近似。 */
  bufferedAmount(): number;
  /** 终止该连接（额度违规 / ACK 超时 / dirty 超限）；同一连接的后续 send 必须已被调用方停止。 */
  close(reason: string): void;
}

export interface SyncFrameGateway {
  /** 入站字节：尺寸预检 → 版本协商 → `decodeSyncFrame` → 派发给 session → 发送回帧。 */
  onInboundBytes(bytes: Uint8Array): Promise<void>;
  /** 出站一帧：先编码，再过 socket 门禁，控制帧再过 governor；被拒即搁置（只留一位有界引用，见文件头偏差④）。 */
  sendOutbound(frame: OutboundFrame): void;
  /**
   * 搁置位驱动（由 `scope-runtime.tick()` 调用，见文件头偏差④）：按拒发原因重试搁置帧，搁置到期仍发不出去即
   * 关闭连接并通知 `onConnectionClosed`。连接已是终态时无动作。
   */
  driveWithheld(): void;
  /** ACK 超时扫描：返回本次判定超期的 deliveryId 数；>0 时网关已关闭连接。 */
  scanTimeouts(): number;
  /** 已发送未回执的投递数（观测与测试）。 */
  outstandingDeliveries(): number;
  close(reason: string): void;
}

/** 出帧网关的装配输入（`clock` 只用于搁置期限与重试判定：超时与限频分别由两个 governor 持有）。 */
export interface SyncFrameGatewayDeps {
  readonly scope: SyncScope;
  readonly session: ProviderSession;
  readonly transport: SyncFrameTransport;
  readonly clock: Clock;
  /** socket 门禁的水位来源（`config.quota.socketHighWatermark`，与 capacity 同值，装配期已断言）。 */
  readonly config: SyncRuntimeConfig;
  readonly control: ControlGovernor;
  readonly timeouts: AckTimeoutTracker;
  /** 协议不兼容时的关闭理由（设计 §14：明确要求刷新，不静默降级）。 */
  readonly onProtocolMismatch?: (version: number) => void;
  /**
   * 搁置位被顶替、被顶替的是一条**数据帧**时的通知：该投递从未上线，需由额度/账本所有者把它的窗口字节结算归还
   * （规格 §2.4「`send` 返回 false 时归还上次预留」）。
   *
   * 控制帧不走这里：它没有可补差的内容，顶替即收敛到断连（见 `withhold`）。
   */
  readonly onDeliveryAbandoned?: (deliveryId: string) => void;
  /**
   * 连接进入终态（任何原因，含宿主主动 `close`）时通知一次，携带关闭理由。
   *
   * 编排者据此做唯一的清账（会话、账本、额度、投递登记）并停止驱动会话：清账与「不再推进」必须由同一个事实
   * 触发，否则会出现「宿主关了连接、tick 仍按已发出推进游标」或「清了账但会话仍被驱动」。
   */
  readonly onConnectionClosed?: (reason: string) => void;
}

/** 非法字节序列直接失败：替换字符会掩盖损坏，还可能让损坏的帧通过后续判定。 */
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * 搁置原因：决定 `driveWithheld()` 是否每 tick 重试。
 *
 * `transport` = 传输饱和（socket 门禁拒发或 `send` 返回 false）：瞬时状态，按端口契约「保留任务引用」由下一 tick
 * 重试；`control` = 控制限流（governor 拒发）：节流本身就是它的语义，重试只在搁置期限到期时做一次。
 */
type WithholdCause = "transport" | "control";

/** 搁置位的内容：帧 + 本段搁置的最早时刻 + 拒发原因（见文件头偏差④）。 */
interface WithheldFrame {
  readonly frame: OutboundFrame;
  readonly sinceMs: number;
  readonly cause: WithholdCause;
}

/** 畸形入站字节的统一出口：不回显原始文本，帧可能含正文，异常文本会进日志与 ERROR 帧。 */
function malformed(message: string, cause?: unknown): SyncProtocolError {
  return new SyncProtocolError("MALFORMED_FRAME", cause === undefined ? { message } : { message, cause });
}

/**
 * 取原始 `protocolVersion`：只做 UTF-8 解码、`JSON.parse` 与字段读取，不进 schema。
 *
 * 这是「协商先于严格解析」的实现方式：非本版本在 schema 里会失败成 `MALFORMED_FRAME`，无法区分
 * 「版本新」与「内容坏」。无法取到数字时返回 `null`，交由 `decodeSyncFrame` 按畸形帧处理。
 */
function probeProtocolVersion(bytes: Uint8Array): number | null {
  let text: string;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch (error) {
    throw malformed("frame bytes are not valid UTF-8", error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw malformed("frame is not valid JSON", error);
  }
  if (typeof parsed !== "object" || parsed === null || !("protocolVersion" in parsed)) {
    return null;
  }
  const raw = parsed.protocolVersion;
  return typeof raw === "number" ? raw : null;
}

export function createSyncFrameGateway(deps: SyncFrameGatewayDeps): SyncFrameGateway {
  const {
    scope,
    session,
    transport,
    clock,
    config,
    control,
    timeouts,
    onProtocolMismatch,
    onDeliveryAbandoned,
    onConnectionClosed,
  } = deps;
  /** socket 门禁水位：与 `capacity.concurrency.socketHighWatermarkBytes` 同值（装配期断言），本层只读这一处。 */
  const socketHighWatermark = config.quota.socketHighWatermark;
  /** 搁置期限：与 ACK 期限同源（`config.deadlines.ackMs`），超期即该连接已无法投递。 */
  const withheldDeadlineMs = config.deadlines.ackMs;
  /** 连接已终止：终止后不再派发入站帧，也不再尝试出站（`close` 幂等）。 */
  let closed = false;
  /** 最近一次出站数据帧携带的传输代次：入站回执按它判定是否属于本连接。 */
  let streamEpoch: string | null = null;
  /** 一位有界搁置位：最近一次被拒或交接失败的帧（见文件头偏差④）。 */
  let withheld: WithheldFrame | null = null;

  function closeConnection(reason: string): void {
    if (closed) return;
    closed = true;
    withheld = null;
    transport.close(reason);
    // 终态通知在关闭之后：编排者据此清账并停止驱动会话，清账与「不再推进」由同一个事实触发（文件头偏差④）。
    onConnectionClosed?.(reason);
  }

  /**
   * 被拒或交接失败：只保留一位搁置位，不排队。先前的帧被顶替，因此内存不随拒绝次数增长。
   *
   * `sinceMs` 保留**本段搁置的最早时刻**：连续拒发不能被后续帧不断刷新期限，否则连接可以一边丢帧一边永不超期。
   *
   * 顶替不是静默丢弃，按帧类分两条出路（设计 §8.5：丢弃的是冗余发送任务，不是唯一内容）：
   * - 数据帧：任务冗余、内容可由 Doc 状态补差（客户端检出序号缺口后申请补齐），但**从未上线的投递不得占窗口**
   *   （规格 §2.4「`send` 返回 false 时归还上次预留」），故通知编排者自结算归还字节。
   * - 控制帧：线上不带 `deliveryId`、也不进 ACK 登记，客户端没有任何补差入口（MANIFEST 丢了就永远订不到内容），
   *   因此不存在「丢弃后自愈」这条路——只能收敛到明确断连，由客户端重连重新握手，不留下无超时、无错误的半握手。
   */
  function withhold(frame: OutboundFrame, sinceMs: number, cause: WithholdCause): void {
    const dropped = withheld;
    if (dropped !== null && dropped.frame.deliveryId !== frame.deliveryId) {
      if (frameClassOf(dropped.frame.frame) !== "data") {
        closeConnection(
          `withheld ${dropped.frame.frame.type} frame was superseded before delivery and has no recovery path`,
        );
        return;
      }
      onDeliveryAbandoned?.(dropped.frame.deliveryId);
    }
    withheld = { frame, sinceMs: dropped === null ? sinceMs : Math.min(dropped.sinceMs, sinceMs), cause };
  }

  /** 数据帧交接成功后的登记：数据帧线上带 `transportEpoch`，本层据此判定回执归属并登记 ACK 期限。 */
  function registerDelivery(frame: OutboundFrame): void {
    const wire = frame.frame;
    if (!("transportEpoch" in wire)) return;
    streamEpoch = wire.transportEpoch;
    timeouts.track(frame.deliveryId, wire.transportEpoch);
  }

  /**
   * socket 门禁：`bufferedAmount() + 真实编码字节` 超过水位即拒发该帧（见文件头偏差②）。
   *
   * 判据必须是编码后的真实字节数：估算（按 `message.length` 计 UTF-16 代码单元）对多字节文本是低估，会让临界区
   * 的超水位帧被放行。
   */
  function isSocketSaturated(encodedBytes: number): boolean {
    return transport.bufferedAmount() + encodedBytes > socketHighWatermark;
  }

  /**
   * 数据帧：编码、门禁、交接、登记 ACK 期限。窗口的记账在会话与账本（文件头偏差①），本层只做门禁与登记。
   *
   * `send` 返回 false 表示传输层饱和：搁置该帧、不抛错，由 `driveWithheld()` 在下一 tick 重试同一帧（§2.4 的
   * 「保留一位有界任务引用」）。
   */
  function sendDataFrame(frame: OutboundFrame, sinceMs: number): void {
    const bytes = encodeSyncFrame(frame.frame);
    if (isSocketSaturated(bytes.length)) {
      withhold(frame, sinceMs, "transport");
      return;
    }
    if (!transport.send(bytes)) {
      withhold(frame, sinceMs, "transport");
      return;
    }
    frame.onHandedOff?.();
    registerDelivery(frame);
  }

  /**
   * 控制帧：编码 → socket 门禁 → governor（帧率令牌 + 控制窗口字节）→ 交接，交接即归还窗口字节。
   *
   * 控制帧线上不带 `deliveryId`、客户端无从回执（`session.ts:8` 偏差③），把字节留在窗口里没有结算事件，
   * 会永久占用窗口；故与 session 对控制帧的「瞬时计费」同口径，交接后立即归还，帧率令牌不受归还影响。
   *
   * 顺序说明（对 §2.4「先预留后编码」的偏离，理由同文件头「出站两段」）：governor 的窗口字节要按真实编码字节
   * 记账，而真实字节只能来自编码；一帧控制帧的编码代价有界（≤ 头预算），且被拒时只搁置一位引用，不会形成风暴。
   */
  function sendControlFrame(frame: OutboundFrame, sinceMs: number): void {
    const bytes = encodeSyncFrame(frame.frame);
    if (isSocketSaturated(bytes.length)) {
      withhold(frame, sinceMs, "transport");
      return;
    }
    if (!control.tryAcquire(bytes.length)) {
      // 帧率或控制窗口不足：账目未变，可原样重试，但重试时机由搁置期限决定（文件头偏差④）。
      withhold(frame, sinceMs, "control");
      return;
    }
    try {
      if (!transport.send(bytes)) {
        withhold(frame, sinceMs, "transport");
      }
    } finally {
      control.release(bytes.length);
    }
  }

  /**
   * 出帧的一次尝试：先编码（帧类内部完成），再按帧类路由（控制 → governor，数据 → 直接交接）。
   *
   * `sinceMs` 是本段搁置的最早时刻：重试沿用原值，被拒后仍落在同一段搁置里。
   */
  function attemptSend(frame: OutboundFrame, sinceMs: number): void {
    if (frameClassOf(frame.frame) === "data") {
      sendDataFrame(frame, sinceMs);
      return;
    }
    sendControlFrame(frame, sinceMs);
  }

  /** 出帧入口：搁置中的同一投递不重复尝试（重试由 `driveWithheld()` 驱动，见文件头偏差④）。 */
  function sendOutbound(frame: OutboundFrame): void {
    if (closed) return;
    if (withheld !== null && withheld.frame.deliveryId === frame.deliveryId) return;
    attemptSend(frame, clock.now());
  }

  /**
   * 搁置位驱动（文件头偏差④）：连接终态时无动作；否则按原因重试一次，到期仍发不出去即关连接。
   *
   * 顺序：先重试再判期限——到期时若能发出就不该断连（「搁置超过期限**仍发不出去**才关闭」），也避免把一次本可
   * 成功的投递算成终态。
   */
  function driveWithheld(): void {
    if (closed) return;
    const held = withheld;
    if (held === null) return;
    const expired = clock.now() - held.sinceMs >= withheldDeadlineMs;
    // 控制限流不在 tick 重试：节流是 governor 的既定语义，`driveWithheld` 只在到期时给最后一次机会。
    if (held.cause === "control" && !expired) return;
    // 先从搁置位移除再重试：发出的就是搁置位里那唯一一份，不存在「既在搁置位又已投递」的状态。
    withheld = null;
    attemptSend(held.frame, held.sinceMs);
    if (withheld !== null && expired) {
      closeConnection(`withheld ${held.frame.frame.type} frame could not be delivered within ${withheldDeadlineMs}ms`);
    }
  }

  /** 回帧：会话产出的帧都经 `sendOutbound` 走同一条分类与计费路径，不另开旁路。 */
  function sendReplies(replies: readonly OutboundFrame[]): void {
    for (const reply of replies) {
      sendOutbound(reply);
    }
  }

  async function dispatch(frame: SyncFrame): Promise<void> {
    switch (frame.type) {
      case "HELLO": {
        const generation = frame.generation;
        // 缺代次的 HELLO 无法绑定任何入口（会话按代次指针校验），属于结构性输入错误而非额度问题。
        if (generation === undefined) throw malformed("HELLO must declare the generation it is loading");
        sendReplies(
          await session.handshake({
            protocolVersion: frame.protocolVersion,
            scope: frame.scope,
            generation,
            // 帧里只带 Doc 身份与已应用边界，没有 state vector：未声明的 Doc 因此退回规范基线（`base-plan` 决定）。
            loadedDocs: frame.loadedDocs.map((doc) => ({ docId: doc.docId })),
          }),
        );
        return;
      }
      case "SUBSCRIBE": {
        sendReplies(await session.subscribe({ docIds: frame.docIds, priority: frame.priority }));
        return;
      }
      case "APPLY_ACK": {
        // 异代次回执属于已废弃的连接代：不结算、不派发（设计 §8.3「迟到回执不改新游标」）。
        if (streamEpoch !== null && frame.transportEpoch !== streamEpoch) return;
        timeouts.settle(frame.deliveryId);
        sendReplies(await session.onAck(frame.deliveryId, frame.result));
        return;
      }
      case "RESYNC": {
        sendReplies(await session.resync(frame.docId));
        return;
      }
      case "GENERATION_REPLACE": {
        sendReplies(
          await session.replaceGeneration({
            generation: frame.generation,
            pointerRevision: frame.pointerRevision,
          }),
        );
        return;
      }
      case "ERROR": {
        // 对端报告协议级失败：本层没有恢复动作。不回显对端 `message`，它可能携带正文，会被带进日志。
        throw new SyncProtocolError(frame.code, { message: "peer reported a sync protocol error" });
      }
      default: {
        throw malformed(`frame type ${frame.type} is server-to-client only`);
      }
    }
  }

  /**
   * 版本不兼容的终结路径（见文件头偏差⑤）：回 ERROR 帧后关闭连接，不继续派发。
   *
   * ERROR 帧的 `protocolVersion` 填本端版本，客户端据此知道自己该升到哪一版。
   */
  function rejectProtocolVersion(version: number): void {
    onProtocolMismatch?.(version);
    const frame: ErrorFrame = {
      type: "ERROR",
      protocolVersion: SYNC_PROTOCOL_VERSION,
      code: "PROTOCOL_VERSION_UNSUPPORTED",
      retryable: false,
      scope: scopeKey(scope),
      message: `sync protocol version ${version} is unsupported; reload the client`,
    };
    try {
      transport.send(encodeSyncFrame(frame));
    } finally {
      closeConnection(`unsupported protocol version ${version}`);
    }
  }

  return {
    async onInboundBytes(bytes: Uint8Array): Promise<void> {
      if (closed) return;
      // 尺寸预检先于一切解析：超过数据帧上限的输入不需要内容即可判定，也不把解析开销转嫁给本端。
      if (bytes.length > MAX_DATA_FRAME_BYTES) {
        throw new SyncProtocolError("FRAME_TOO_LARGE", {
          message: `inbound frame is ${bytes.length} bytes, limit is ${MAX_DATA_FRAME_BYTES} bytes`,
        });
      }
      const rawVersion = probeProtocolVersion(bytes);
      if (rawVersion !== null && rawVersion !== SYNC_PROTOCOL_VERSION) {
        rejectProtocolVersion(rawVersion);
        return;
      }
      // 解码失败一律抛出（`MALFORMED_FRAME` / `FRAME_TOO_LARGE`），由调用方决定是否关连接：吞成静默返回
      // 会让「客户端一直在发坏帧」表现为连接正常。
      const frame = decodeSyncFrame(bytes);
      await dispatch(frame);
    },

    sendOutbound,

    driveWithheld,

    scanTimeouts(): number {
      if (closed) return 0;
      const expired = timeouts.scan();
      if (expired.length === 0) return 0;
      // 超期即该连接已失去回执能力（设计 §8.5）：关连接会经 `onConnectionClosed` 通知编排者清账（文件头偏差④）。
      closeConnection(`ack timeout for ${expired.length} outstanding deliveries`);
      return expired.length;
    },

    outstandingDeliveries(): number {
      return timeouts.outstandingCount();
    },

    close(reason: string): void {
      closeConnection(reason);
    },
  };
}
