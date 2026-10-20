// packages/chat-channel/src/channel/user-input-queue-wire.ts
// Peri 待发送队列（steer）的 wire 解析与响应收敛：把 session/input/* 的 JSON-RPC
// 结果 / 错误收敛成「投影输入」与「可直接回浏览器的公开错误类型」。
//
// 与 protocol/acp-channel.ts 的事件规范化是两条路径：那里解析 peri/agent_event 的
// 事件载荷（serde snake_case），这里解析 session/input/* 的响应（camelCase DTO）与
// 拒绝错误的 data。两者共用 schema 的投影类型与上限常量，但不共用解析函数
// （响应形态不同，且响应侧还要按 rpcId 认领在途登记）。
//
// 安全口径：上游 message 与载荷一律不进入浏览器、不进入日志；只读 code 与稳定的
// data 标记（rejected）做公开归类，快照内容只经上限截断后写入 Y.Doc。

import { fromPeriMessageContent } from "../protocol/translator";
import type { PublicErrorType } from "../public-error";
import {
  type NormalizedUserInputQueueEvent,
  PERI_USER_INPUT_QUEUE_CAPABILITY,
  truncateUtf8Safe,
  USER_INPUT_CONTENT_MAX,
  USER_INPUT_DRAFT_MAX,
  USER_INPUT_IMAGE_PLACEHOLDER,
  USER_INPUT_QUEUE_MAX_ITEMS,
  USER_INPUT_STATES,
  type UserInputQueueItemProjection,
  type UserInputQueueSnapshot,
} from "../schema";
import type { DocManager } from "../state/doc-manager";
import { readUserInputQueue } from "../state/user-input-queue";
import type { SharedRelay } from "./connection-types";
import { settleUserInputRequest } from "./user-input-pending";

/** 读取对象字段（数组/null/原始值一律视为缺失） */
function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 多键读取字符串：peri 的 DTO 在不同通道间序列化口径不稳定（JSON-RPC 响应是
 * camelCase、事件载荷是 snake_case），投影层不接受"赌一种写法"导致的静默空队列。
 */
function readVariantString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/** 读取原始字段值（同上，用于 content 这类非字符串字段） */
function readVariant(record: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null) return value;
  }
  return;
}

/**
 * 能力协商判定：peri 把 clientCapabilities._meta 原样回显到 agentCapabilities._meta，
 * 而 acp-link 的 status 帧可能已扁平化到顶层。两种形状都读，任一为 true 即协商成功；
 * 都读不到即未协商（此时 session/input/* 会被 peri 以 -32601 拒绝，不补拉）。
 */
export function readUserInputQueueCapability(capabilities: unknown): boolean {
  const record = readRecord(capabilities);
  if (!record) return false;
  if (record[PERI_USER_INPUT_QUEUE_CAPABILITY] === true) return true;
  const meta = readRecord(record._meta);
  return meta?.[PERI_USER_INPUT_QUEUE_CAPABILITY] === true;
}

/** 队列项状态归一化：未知取值收敛为 unknown（状态机由 peri 权威，前向兼容） */
function readUserInputState(raw: unknown): UserInputQueueItemProjection["state"] {
  return typeof raw === "string" && (USER_INPUT_STATES as ReadonlySet<string>).has(raw)
    ? (raw as UserInputQueueItemProjection["state"])
    : "unknown";
}

/**
 * 队列项展示文本：peri MessageContent（裸字符串 | 块数组）→ 可展示文本。
 * 图片块只留占位标记——base64 数据既不进 Y.Doc（Session Doc 首帧整体同步的体积）
 * 也不回显前端；未知块忽略（只展示可展示的内容，不猜语义）。
 */
function displayTextOf(content: unknown): string {
  const parts: string[] = [];
  for (const block of fromPeriMessageContent(content)) {
    if (block.type === "image") parts.push(USER_INPUT_IMAGE_PLACEHOLDER);
    else if (block.text.length > 0) parts.push(block.text);
  }
  return truncateUtf8Safe(parts.join("\n"), USER_INPUT_CONTENT_MAX);
}

/** 归一化单个队列项；缺 inputId 的项无法按键控与去重（摘除/派发都按 id），直接丢弃 */
function parseUserInputItem(raw: unknown): UserInputQueueItemProjection | null {
  const record = readRecord(raw);
  if (!record) return null;
  const inputId = readVariantString(record, "inputId", "input_id");
  if (!inputId) return null;
  return {
    inputId,
    content: displayTextOf(readVariant(record, "content")),
    originalDraft: truncateUtf8Safe(
      readVariantString(record, "originalDraft", "original_draft") ?? "",
      USER_INPUT_DRAFT_MAX,
    ),
    state: readUserInputState(readVariant(record, "state")),
  };
}

/**
 * 归一化队列快照：generation 是换代键，缺失即无法判定换代，整条快照丢弃
 * （宁可保持现状，也不能把未知代号的项写进投影）；revision 非法按 0；
 * items 按 inputId 去重并截断到 PENDING_CAPACITY（重复/超量项会让前端渲染出不存在的气泡）。
 */
export function parseUserInputSnapshot(raw: unknown): UserInputQueueSnapshot | null {
  const record = readRecord(raw);
  if (!record) return null;
  const generation = readVariantString(record, "generation");
  if (!generation) return null;

  const revisionRaw = readVariant(record, "revision");
  const revision = typeof revisionRaw === "number" && Number.isFinite(revisionRaw) ? revisionRaw : 0;
  const itemsRaw = readVariant(record, "items");

  const items: UserInputQueueItemProjection[] = [];
  const seen = new Set<string>();
  if (Array.isArray(itemsRaw)) {
    for (const entry of itemsRaw) {
      if (items.length >= USER_INPUT_QUEUE_MAX_ITEMS) break;
      const item = parseUserInputItem(entry);
      if (!item || seen.has(item.inputId)) continue;
      seen.add(item.inputId);
      items.push(item);
    }
  }

  return {
    generation,
    revision,
    activeRequestId: readVariantString(record, "activeRequestId", "active_request_id"),
    items,
  };
}

/**
 * 从 JSON-RPC result 取快照：snapshot 方法的结果本身就是快照，其余三个方法返回
 * receipt（{snapshot, results, takenBack?}）。形状不符返回 null（调用方放弃投影更新，
 * 但请求本身仍算成功——回执缺失不该把已生效的命令判成失败）。
 */
export function extractUserInputSnapshot(result: unknown): UserInputQueueSnapshot | null {
  const record = readRecord(result);
  if (!record) return null;
  return parseUserInputSnapshot(record.snapshot) ?? parseUserInputSnapshot(record);
}

/** peri 拒绝的公开归类结果 */
export interface UserInputQueueRejection {
  /** 可直接回浏览器的公开错误类型（用户可读文案由 public-error 注册表产生） */
  publicErrorType: PublicErrorType;
  /** 判定为 generation 换代（快照代号与本地投影不一致；本地无代号时按无法证伪处理） */
  stale: boolean;
  /** 拒绝携带的权威快照（校正投影用；无则 null） */
  snapshot: UserInputQueueSnapshot | null;
}

/**
 * peri 拒绝的公开归类：上游 message 不参与判定（不得进入浏览器），只读 code 与稳定 data 标记。
 *
 * peri 对四类命令的**所有**队列侧失败共用同一个标记（`-32602` + `data.rejected=true` +
 * `data.snapshot`）：换代、容量满、身份冲突、会话关闭（`AcpError::with_data`，见
 * `peri-acp/src/host/requests/user_input.rs`）。因此"是否换代"必须由权威快照与本地投影的
 * 代号比对来证明，而不是看到标记就断言过期：
 * - 代号不同（或本地无代号）→ VERSION_CONFLICT，写回快照纠正过期代号；
 * - 代号相同 → 本次不是换代失败，落 RATE_LIMITED（队列已满一类，稍后可重试），
 *   避免误导用户用旧代号反复重试。
 *
 * 其余：`-32601`（未协商能力 / 方法不存在）与只读 observer 的 `-32602`（无 rejected 标记）
 * 都是明确失败且不可重试 → INVALID_STATE。
 */
export function classifyUserInputQueueRejection(
  error: unknown,
  currentGeneration: string | null = null,
): UserInputQueueRejection {
  const record = readRecord(error);
  const data = readRecord(record?.data);

  if (data?.rejected === true) {
    const snapshot = parseUserInputSnapshot(data.snapshot);
    const stale = snapshot !== null && (currentGeneration === null || snapshot.generation !== currentGeneration);
    return {
      publicErrorType: stale ? "ACTION.VERSION_CONFLICT" : "ACTION.RATE_LIMITED",
      stale,
      snapshot,
    };
  }
  return { publicErrorType: "ACTION.INVALID_STATE", stale: false, snapshot: null };
}

/**
 * 用权威快照更新投影（控制面路径）：走聚合层同一入口（processNormalizedEvent），
 * 换代清空 / revision 单调 / 上限截断只由 state/user-input-queue.ts 一份规则决定。
 * 会话 Doc 不在内存时聚合层丢弃该事件（不重建旧 Doc），投影与实时流保持一致。
 */
export function applyUserInputQueueSnapshot(
  docManager: DocManager,
  rcsSessionId: string,
  snapshot: UserInputQueueSnapshot,
): void {
  // 事件形状与 protocol/acp-channel 的规范化产物同构（NormalizedUserInputQueueEvent，
  // 扁平 snapshot 字段）；聚合层按结构读取，不依赖对象身份。
  const event = {
    type: "user_input_queue_changed",
    update: {},
    content: null,
    snapshot,
  } satisfies NormalizedUserInputQueueEvent;
  docManager.processNormalizedEvent(rcsSessionId, event);
}

/** 响应收敛所需的 relay 侧依赖（relay-event-handler 第二级分派注入） */
export interface UserInputQueueResponseContext {
  shared: SharedRelay;
  rpcId: number | string;
  /** JSON-RPC 响应帧（含 id，result 或 error 二选一） */
  rpcCheck: Record<string, unknown>;
  docManager: DocManager;
  reportError: (message: string, error: unknown) => void;
  log?: (message: string) => void;
}

/**
 * 收敛一条在途 steer 响应（relay-event-handler 的响应分派入口）。
 * 返回 true 表示该响应属于 steer 请求、已被认领——调用方不得再落入 prompt /
 * 会话同步分支。投影写入（成功回执的权威快照、过期拒绝的换代校正）在此完成，
 * 等待者只拿到"成功 / 失败 + 公开错误类型"。
 */
export function settleUserInputQueueResponse(context: UserInputQueueResponseContext): boolean {
  const { shared, rpcId, rpcCheck, docManager, reportError } = context;
  const registration = shared.pendingUserInputRequests?.get(rpcId);
  if (!registration) return false;

  const rpcError = readRecord(rpcCheck.error);
  if (rpcError) {
    // 换代判定需要本地投影的当前代号：读不到（会话 Doc 不在内存）时按"无法证伪过期"处理
    const sessionDoc = docManager.getSessionYdoc(shared.rcsSessionId);
    const currentGeneration = sessionDoc ? readUserInputQueue(sessionDoc).generation : null;
    const rejection = classifyUserInputQueueRejection(rpcError, currentGeneration);
    // 换代校正：本次命令虽已失败，也必须把权威快照写回投影——否则前端继续用过期代号
    // 重试、每次都被拒（用户看到的是"点了没反应"）
    if (rejection.snapshot) applyUserInputQueueSnapshot(docManager, shared.rcsSessionId, rejection.snapshot);
    // 诊断只记录低基数字段：kind/code/stale；上游 message 与载荷不进日志
    reportError("[YJS-FE] user input queue request rejected", {
      kind: registration.kind,
      code: rpcError.code ?? null,
      stale: rejection.stale,
    });
    settleUserInputRequest(shared, rpcId, {
      ok: false,
      reason: "rejected",
      publicErrorType: rejection.publicErrorType,
    });
    return true;
  }

  const snapshot = extractUserInputSnapshot(rpcCheck.result);
  if (snapshot) applyUserInputQueueSnapshot(docManager, shared.rcsSessionId, snapshot);
  else context.log?.(`[YJS-FE] user input queue response without snapshot: kind=${registration.kind}`);
  // 取回语义校验：peri 的 takeback 对「已不在 queued 的项」不报错——回执成功但
  // takenBack 缺省（项已 dispatching/claimed/delivered）。视为成功会让前端把草稿
  // 交回输入框、而该项同时仍在投递中，同一条内容出现两份。缺省即判定未取回。
  if (registration.kind === "takeback" && !readTakenBack(rpcCheck.result)) {
    reportError("[YJS-FE] user input queue takeback not applied", { kind: registration.kind });
    settleUserInputRequest(shared, rpcId, {
      ok: false,
      reason: "not_withdrawable",
      publicErrorType: "ACTION.INVALID_STATE",
    });
    return true;
  }
  settleUserInputRequest(shared, rpcId, { ok: true });
  return true;
}

/**
 * 回执是否携带被取回的输入（peri 的 `UserInputQueueReceipt.taken_back`，
 * `skip_serializing_if` 使未取回时整个键缺省；命令幂等重放会保留原值）。
 */
function readTakenBack(result: unknown): boolean {
  const record = readRecord(result);
  if (!record) return false;
  return readRecord(readVariant(record, "takenBack", "taken_back")) !== null;
}
