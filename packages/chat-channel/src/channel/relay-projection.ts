import type * as Y from "yjs";
import { type NormalizedEvent, type NormalizedEventType, TURN_TERMINAL_STATUSES, type TurnStatus } from "../schema";
import type { DocManager } from "../state";
import { CALLBACK_ENTRY_PREFIX } from "../state/chat-writer";
import { REPLAY_WINDOW_MS, type SharedRelay } from "./connection-types";
import type { RelayEventHandlerDependencies } from "./relay-event-dependencies";

/** 需要活动 turn 才能投影的增量类事件（无头回放流的开头需要合成回放 turn） */
const REPLAY_NEEDS_TURN: ReadonlySet<NormalizedEventType> = new Set([
  "reasoning_delta",
  "message_delta",
  "tool_call_started",
  "tool_call_updated",
  "tool_call_completed",
  "tool_call_failed",
  "permission_requested",
  // AskUserQuestion 可能是 Agent 恢复后的首个业务帧；没有可写 turn 时必须与
  // permission 一样先补建回放 turn，否则聚合层会拒绝投影，前端不会显示提问面板。
  "question_requested",
]);

/** 生成回放 turnId（turn_replay_ 前缀与实时 turn 区分，便于日志排查） */
function createReplayTurnId(): string {
  return `turn_replay_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/** callback 流事件（无 turnId 时需按绑定归属，而非回落到活动 turn） */
const CALLBACK_STREAM_EVENTS: ReadonlySet<NormalizedEventType> = new Set([
  "message_delta",
  "reasoning_delta",
  "turn_completed",
  "turn_cancelled",
  "turn_failed",
]);

/** callback 流的终态事件：到达即解绑；代际不符时不得回落活动 turn */
const CALLBACK_TERMINAL_EVENTS: ReadonlySet<NormalizedEventType> = new Set([
  "turn_completed",
  "turn_cancelled",
  "turn_failed",
]);

/**
 * 新同步协议旁路需要 turn 归属的事件。
 *
 * ACP 实时载荷不带 turnId；这里只使用旧投影已提交的 activeTurnId（由 registerUserMessage /
 * pendingPromptTurns 建立的同一份服务端绑定），不读取客户端字段，也不在无绑定时猜造。
 */
const SYNC_TURN_BOUND_EVENTS: ReadonlySet<NormalizedEventType> = new Set([
  ...REPLAY_NEEDS_TURN,
  "permission_resolved",
  "turn_failed",
  "turn_cancelled",
  "turn_interrupted",
]);

/** 提取 user_message 文本（与聚合层 extractText 同口径：content 优先，回落 update 顶层） */
function extractUserMessageText(event: NormalizedEvent): string {
  const contentText = event.content?.text;
  if (typeof contentText === "string") return contentText;
  const updateText = event.update.text;
  return typeof updateText === "string" ? updateText : "";
}

/** 读取聚合层活动 turn（Session Doc root.session.activeTurnId/Status 为权威，与 chat-writer 一致） */
function readActiveTurn(
  docManager: DocManager,
  rcsSessionId: string,
): { turnId: string | null; turnStatus: TurnStatus | null } {
  const sessionYdoc = docManager.getSessionYdoc(rcsSessionId);
  if (!sessionYdoc) return { turnId: null, turnStatus: null };
  const session = sessionYdoc.getMap("root").get("session") as Y.Map<unknown> | undefined;
  if (!session) return { turnId: null, turnStatus: null };
  const turnId = session.get("activeTurnId");
  const turnStatus = session.get("activeTurnStatus");
  return {
    turnId: typeof turnId === "string" && turnId.length > 0 ? turnId : null,
    turnStatus: (turnStatus as TurnStatus | null | undefined) ?? null,
  };
}

/** 与聚合层 canWriteToTurn 一致的写入判定：turn 是否仍可接受内容增量 */
function isTurnWritable(status: TurnStatus | null): boolean {
  if (!status || status === "cancelling") return false;
  return !TURN_TERMINAL_STATUSES.has(status);
}

/** relay 回放与实时事件共享同一投影入口及 turn 归属规则。 */
export class RelayProjection {
  constructor(private readonly dependencies: RelayEventHandlerDependencies) {}
  /**
   * 开启回放窗口（load/resume 转发前与 JSON-RPC result 确认时各调用一次，幂等重置）：
   * 记录截止时间戳，并注册到期定时器——回放流无终态信号（unstable_resumeSession
   * 只回放 chunk 帧），到期时把窗口内合成/分配的回放 turn 收敛为 completed，
   * 否则回放 turn 永久卡 running、前端一直显示输出中。期间用户发出新消息时
   * 聚合层按 turnId 归属拒绝该终态（见 aggregator.applyTurnTerminal），不误伤新 turn。
   */
  openReplayWindow(shared: SharedRelay, options: { resampleSkip?: boolean } = {}): void {
    shared.replayWindowUntil = Date.now() + REPLAY_WINDOW_MS;
    // 不在此处清空 callback 绑定：调用本方法 ≠ 换代——同会话 load（刷新页面恢复，
    // session-channel.prepareLoadSession 的早退路径）不替换投影，绑定指向的 entry
    // 仍在当前 Chat Doc 中，清空会让在途回调的尾部增量全部失去归属（静默丢内容）。
    // 投影真被替换时由消费端按 callbackBindingGeneration 与当前 generation 的事实
    // 差异解绑（dispatchReplayAware）。
    // 窗口开启瞬间判定一次 Chat Doc 是否已有时间线内容（重连跳过回放语义）并缓存：
    // 合成投影本身会写 Chat Doc，若窗口内实时检查，回放自己写入的第一条会把后续
    // 回放帧全部误判为"已有内容"挡住——多轮历史回放只投影第一条（后续全丢）。
    // 判定只在窗口未开启时捕获：JSON-RPC result 分支会幂等重开窗口，而 result 必然
    // 晚于已开始的回放流，重开时重算会把回放自己写入的内容当作"已有内容"，切换后
    // 回放剩余轮次全被拒绝（历史消息消失、助手增量落到上一轮 entry）。
    // resampleSkip：action 路径（命令执行完成、换代已生效）调用时作废上一窗口的判定
    // 重新采样——10s 窗口内连续切换时上一窗口的判定属于旧会话（如复用持久化投影的
    // 「已有内容」），继承会让新会话回放被整体跳过（消息区空白）。
    if (options.resampleSkip) shared.replaySkipSynthesis = undefined;
    if (shared.replaySkipSynthesis === undefined) {
      shared.replaySkipSynthesis = this.dependencies.docManager.hasTimelineContent(shared.rcsSessionId);
    }
    // 窗口一开就建立回放 turn（不写 entry）：前端无需等首个回放事件才知道 replaying，
    // 慢启动 Agent（2s/4s 后才吐历史）也不会被客户端的“无活动”兜底提前放行。
    if (shared.replaySkipSynthesis === false && shared.replayTurnId == null) {
      const turnId = createReplayTurnId();
      shared.replayTurnId = turnId;
      this.dispatch(shared, { type: "replay_started", update: {}, content: null, turnId });
    }
    if (shared.replayWindowTimer) clearTimeout(shared.replayWindowTimer);
    shared.replayWindowTimer = setTimeout(() => {
      this.convergeReplayWindow(shared);
    }, REPLAY_WINDOW_MS);
  }

  /**
   * 回放窗口到期收敛（openReplayWindow 的定时器到点回调，独立成方法供测试直调）：
   * 关闭窗口并把窗口内合成/分配的回放 turn 收敛为 completed——回放流无终态信号
   * （unstable_resumeSession 只回放 chunk 帧），不收敛则回放 turn 永久卡 running、
   * 前端一直显示输出中。用户已发出新消息时聚合层按 turnId 归属拒绝该终态
   * （aggregator.applyTurnTerminal 的 stale turn 校验），不误伤新 turn。
   * 幂等：窗口未开启或无回放 turn 时 no-op。
   */
  convergeReplayWindow(shared: SharedRelay): void {
    shared.replayWindowUntil = null;
    shared.replaySkipSynthesis = undefined;
    const replayTurnId = shared.replayTurnId;
    shared.replayTurnId = null;
    if (replayTurnId) {
      this.dispatch(shared, {
        type: "turn_completed",
        update: {},
        content: null,
        turnId: replayTurnId,
      });
    }
  }

  /**
   * 回放窗口内的事件投递：Agent 历史回放（load/resume 后）在聚合层 turn 状态机下
   * 没有可写的 turn 上下文，直接投递会被全部拒绝（前端时间线为空）。窗口内且 Chat Doc
   * 无时间线内容时（无持久化快照 / 会话切换已清空）为两类回放形态补全 turn 上下文，
   * 窗口外或 doc 已有内容（重连跳过回放语义，避免重复）保持原语义由聚合层拒绝：
   * - user_message 无 turnId（全量回放开头，或回放内后续消息）→ 一律分配回放 turnId
   *   （含已有活动回放 turn 的场景：不分配会被聚合层以 missing turnId 拒绝而丢失）；
   * - 增量类事件无活动 turn 可写（中断 turn 的无头回放）→ 先合成空文本回放 turn。
   * 实时流 agent 回显（聚合层已有可写 turn，如 registerUserMessage 创建的 turn）不干预，
   * 仍由聚合层拒绝，避免用户消息双写。
   *
   * 窗口外的无 turnId 帧另走 callback 分类：真异步回调需要独立条目承载（b253e3684
   * 的隔离意图），而回显/迟到回放必须先按"文档已有同文本 user entry"剔除，
   * 且回调绑定必须带代际校验，否则陈旧绑定会把后续轮次的增量吸进旧条目。
   */
  dispatchReplayAware(shared: SharedRelay, event: NormalizedEvent): void {
    const inReplayWindow = shared.replayWindowUntil !== null && Date.now() < shared.replayWindowUntil;
    // 窗口内跳过合成的判定在窗口开启瞬间固定（shared.replaySkipSynthesis，见
    // openReplayWindow）：重连场景 doc 已有时间线内容时跳过回放投影（聚合层拒绝，
    // 否则多客户端收到重复历史，session-channel prepareLoadSession 路径 1 的 P1 注释）；
    // 空 doc 时允许合成。手动开启窗口（测试直设 replayWindowUntil）时首次事件
    // 缓存判定，窗口内保持一致。
    if (inReplayWindow) {
      if (shared.replaySkipSynthesis === undefined) {
        shared.replaySkipSynthesis = this.dependencies.docManager.hasTimelineContent(shared.rcsSessionId);
      }
      if (!shared.replaySkipSynthesis) {
        const active = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId);
        if (event.type === "user_message" && !event.turnId) {
          // 回放内所有无 turnId 的 user_message 都分配回放 turnId：开头无活动 turn、
          // 后续消息有活动回放 turn（聚合层 applyUserMessage 会终结旧回放 turn）
          // 两种情况缺一不可，否则回放历史中的后续用户消息直接丢失
          event = { ...event, turnId: createReplayTurnId() };
          shared.replayTurnId = event.turnId;
        } else if (REPLAY_NEEDS_TURN.has(event.type) && !isTurnWritable(active.turnStatus)) {
          // 无头回放：增量无 user_message 开头（中断 turn 的回放），先合成空文本回放 turn
          const replayTurnId = createReplayTurnId();
          shared.replayTurnId = replayTurnId;
          this.dispatch(shared, {
            type: "user_message",
            update: {},
            content: null,
            acpSessionId: event.acpSessionId,
            turnId: replayTurnId,
          });
        }
      }
    }
    if (!inReplayWindow && event.type === "user_message" && !event.turnId) {
      // 窗口外的无 turnId user_message 有三种来源：实时 prompt 回显、回放窗口过期后
      // 迟到的历史回放、真异步回调（Peri callback）。仅凭"无 turnId"无法区分：
      // 一律按回调建条目会让回显多出一条重复 user 气泡，且该 callback 对永远收不到
      // 终态（实时 prompt 的终态必然按 pendingPromptTurns 回填 turnId，不进下面的
      // 绑定分支）→ 本轮回答写进 callback 条目、真实 turn 的 assistant 恒空且
      // 永久 streaming。此处以"文档已存在同文本 user entry"保守判定回显/重复回放：
      // 命中即丢弃（文本已由 registerUserMessage 写入，不产生第二条）；未命中
      // （真回调）保持原语义建 callback 对，b253e3684 的隔离意图不变。
      const text = extractUserMessageText(event);
      if (text && this.dependencies.docManager.hasUserMessageText(shared.rcsSessionId, text)) {
        this.dependencies.log?.("[YJS-FE] duplicate user echo dropped");
        return;
      }
      const callbackEntryId = `${CALLBACK_ENTRY_PREFIX}${crypto.randomUUID()}`;
      shared.callbackAssistantEntryId = callbackEntryId;
      // 绑定代际：记录建立时的 active turn 与投影 generation。无 turnId 增量到达时
      // 任一已变，说明绑定属于上一轮/更早（或被替换的投影）的回调流，必须失效
      // （见下方分支）。
      shared.callbackBindingTurnId = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId).turnId ?? null;
      shared.callbackBindingGeneration = this.dependencies.docManager.getProjectionGeneration(shared.rcsSessionId);
      event = { ...event, callbackEntryId };
    } else if (shared.callbackAssistantEntryId && !event.turnId && CALLBACK_STREAM_EVENTS.has(event.type)) {
      const bindingTurnId = shared.callbackBindingTurnId ?? null;
      const currentTurnId = readActiveTurn(this.dependencies.docManager, shared.rcsSessionId).turnId ?? null;
      const bindingGeneration = shared.callbackBindingGeneration ?? null;
      const currentGeneration = this.dependencies.docManager.getProjectionGeneration(shared.rcsSessionId);
      // 解绑条件：turn 代际变了（用户已开始新一轮 / 换代后活动 turn 清空），或投影
      // generation 变了（load/resume 换代，绑定指向的 callback_* entry 在新投影中已
      // 不存在）。后者按事实判定而非在 openReplayWindow 里清空——同会话 load 不换代，
      // 绑定仍有效。绑定时投影未打开（generation 为 null）则不参与判定，只按 turn 代际。
      const generationChanged = bindingGeneration !== null && bindingGeneration !== currentGeneration;
      if (generationChanged || bindingTurnId !== currentTurnId) {
        // 绑定已失效（用户已开始新一轮 / 投影被替换）：继续按绑定归属会把新一轮的回答
        // 追加进遥远的旧 callback assistant entry（2026-09-24 用户报告的聚合错位根因），
        // 或把内容投给新投影中不存在的 entry（静默丢内容）。解绑后：
        // - 增量交回聚合层按当前活动 turn 归位（本轮回答落 turn_X:assistant）；
        // - 终态直接丢弃——聚合层会把无 callbackEntryId 的终态归给当前活动 turn，
        //   提前终结用户正在进行的回答（新 turn 增量全被丢弃、答案永不出现）。
        shared.callbackAssistantEntryId = null;
        shared.callbackBindingTurnId = null;
        shared.callbackBindingGeneration = null;
        if (CALLBACK_TERMINAL_EVENTS.has(event.type)) {
          this.dependencies.log?.("[YJS-FE] stale callback terminal dropped");
          return;
        }
      } else {
        event = { ...event, callbackEntryId: shared.callbackAssistantEntryId };
        if (CALLBACK_TERMINAL_EVENTS.has(event.type)) {
          shared.callbackAssistantEntryId = null;
          shared.callbackBindingTurnId = null;
          shared.callbackBindingGeneration = null;
        }
      }
    }
    this.dispatch(shared, event);
  }

  /** 投递规范化事件到聚合层（binding 不存在时由 docManager 丢弃） */
  dispatch(shared: SharedRelay, event: NormalizedEvent): void {
    try {
      this.dependencies.docManager.processNormalizedEvent(shared.rcsSessionId, event);
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] processNormalizedEvent failed, event skipped:", err);
    }
    // 旧投影路径已完成；新协议旁路只消费实时事件。回放 turn（turn_replay_*）的历史由旧
    // Chat Doc 提供，禁止灌入新 runtime 的 live ingress（入口只有 pending 预算，且回放工具
    // 事件无可写 turn）。实时 turn 使用真实 turnId，因此回放期间的实时输出仍会正常进入。
    try {
      // 子 Agent / callback 事件自身不带 turnId 时不得借用主 Agent 的活动 turn：
      // 两者已有独立归属键（sourceAgentId / callbackEntryId），借用会把输出混入主回复。
      const canBindActiveTurn =
        !event.sourceAgentId && !event.callbackEntryId && SYNC_TURN_BOUND_EVENTS.has(event.type);
      const boundTurnId =
        event.turnId ??
        (canBindActiveTurn ? readActiveTurn(this.dependencies.docManager, shared.rcsSessionId).turnId : null);
      if (boundTurnId?.startsWith("turn_replay_")) return;
      this.dependencies.onNormalizedEvent?.(
        shared.rcsSessionId,
        boundTurnId ? { ...event, turnId: boundTurnId } : event,
      );
    } catch (err) {
      this.dependencies.reportError("[YJS-FE] sync protocol event fanout failed:", err);
    }
  }
}
