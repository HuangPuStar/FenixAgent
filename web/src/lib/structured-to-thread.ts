// web/src/lib/structured-to-thread.ts
// 新 schema（文档 5.2 Chat Doc：entries/blocks）→ StructuredMessage[] → ThreadEntry[] 渲染转换层。
//
// 职责错位纠正后消息时间线在 Chat Doc，本文件新增 chatDocEntriesToStructuredMessages：
// Chat Doc → 展示层 StructuredMessage[]（保持既有 StructuredMessage 形状，
// 使 structuredToThreadEntries 与上层组件无需感知 schema 变化）。

import {
  getEntriesMap,
  getEntryOrder,
  getToolCallsMap,
  type PermissionOption,
  type StructuredMessage,
} from "@fenix/chat-channel";
// 直接引用 i18next 全局实例（web/src/i18n/index.ts 在此实例上注册各语言资源）：
// 不 import "../i18n" 模块 —— 测试环境有测试文件 mock.module 该模块为无 default
// 导出的假模块，静态 import 链会触发 "Missing default export"。
import i18n from "i18next";
import * as Y from "yjs";
import type { AssistantChunk, PlanDisplayEntry, ThreadEntry, ToolCallData, ToolCallStatus } from "./types";

/**
 * Session Doc 三态权限选项（allow_once/allow_session/deny）→ acp-link PermissionOption[]。
 * 仅用于展示翻译：optionId 保留 Session Doc 语义字符串（后端 CAS 以 deny/reject 前缀判拒，
 * 控制面 respond_permission 原样回传），kind 映射到最近邻 acp-link 枚举以驱动按钮样式。
 */
export function sessionOptionKindsToPermissionOptions(rawOptions: unknown): PermissionOption[] {
  const kinds = Array.isArray(rawOptions) ? rawOptions : [];
  const result: PermissionOption[] = [];
  for (const kind of kinds) {
    if (kind === "allow_once") {
      result.push({
        optionId: "allow_once",
        // i18next 未初始化（如测试环境）时 t 返回 undefined，回退 key 保证按钮文案非空
        name: i18n.t("permissionPanel.allow", { ns: "components" }) ?? "permissionPanel.allow",
        kind: "allow_once",
      });
    } else if (kind === "allow_session") {
      result.push({
        optionId: "allow_session",
        name: i18n.t("permissionPanel.allowSession", { ns: "components" }) ?? "permissionPanel.allowSession",
        kind: "allow_always",
      });
    } else if (kind === "deny") {
      result.push({
        optionId: "deny",
        name: i18n.t("permissionPanel.deny", { ns: "components" }) ?? "permissionPanel.deny",
        kind: "reject_once",
      });
    }
  }
  return result;
}

/** 规范化脱敏错误（后端 ChatEntry.error / ToolCallProjection.publicError 投影），message 为空则视为无错误 */
function extractPublicErrorInfo(raw: Record<string, unknown>): { code: string; message: string } | undefined {
  const code = typeof raw.code === "string" && raw.code ? raw.code : "agent_error";
  const message = typeof raw.message === "string" && raw.message ? raw.message : "";
  if (!message) return;
  return { code, message };
}

function mapStatus(status: string): ToolCallStatus {
  switch (status) {
    case "running":
      return "running";
    case "complete":
    case "completed":
    case "done":
      return "complete";
    case "error":
      return "error";
    case "waiting_for_confirmation":
    case "awaiting_permission":
      return "waiting_for_confirmation";
    case "canceled":
    case "cancelled":
      return "canceled";
    case "rejected":
      return "rejected";
    default:
      return "running";
  }
}

/**
 * 将 Yjs StructuredMessage[] 转换为 ChatInterface 渲染用的 ThreadEntry[]。
 * 纯函数，无副作用。
 */
export function structuredToThreadEntries(messages: StructuredMessage[]): ThreadEntry[] {
  return messages.map((m): ThreadEntry => {
    switch (m.type) {
      case "assistant_message":
        return {
          type: "assistant_message",
          id: m.id,
          chunks: m.chunks.map(
            (c): AssistantChunk => ({
              type: c.type,
              text: c.text,
            }),
          ),
          error: m.error,
        };

      case "user_message":
        return {
          type: "user_message",
          id: m.id,
          content: m.content,
        };

      case "tool_call": {
        const permReq = m.permissionRequest
          ? ({
              requestId: m.permissionRequest.requestId,
              options: [...m.permissionRequest.options],
            } as unknown as ToolCallData["permissionRequest"])
          : undefined;

        const toolCallData: ToolCallData = {
          id: m.id,
          title: m.title,
          status: mapStatus(m.status),
          content: m.content as ToolCallData["content"],
          rawInput: m.rawInput,
          rawOutput: m.rawOutput,
          display: m.display
            ? {
                type: m.display.type,
                path: m.display.path,
                lineStart: m.display.lineStart,
                lineEnd: m.display.lineEnd,
                totalLines: m.display.totalLines,
                text: m.display.text,
                truncated: m.display.truncated,
              }
            : undefined,
          permissionRequest: permReq,
          isStandalonePermission: m.isStandalonePermission,
          publicError: m.publicError,
          subEntries: m.subMessages ? structuredToThreadEntries(m.subMessages) : undefined,
        };
        return { type: "tool_call", toolCall: toolCallData };
      }

      case "plan":
        return {
          type: "plan",
          id: m.id,
          entries: m.entries.map((e) => ({
            content: e.content,
            priority: e.priority,
            status: e.status,
          })),
        } as PlanDisplayEntry;

      default:
        return {
          type: "assistant_message",
          id: `unknown-${Date.now()}`,
          chunks: [],
        };
    }
  });
}

// =============================================================================
// 新 schema 派生：Chat Doc（entries/blocks）→ StructuredMessage[]
// =============================================================================

/** 提取 block 文本（Y.Text） */
function blockText(block: Y.Map<unknown> | undefined): string {
  if (!block) return "";
  const text = block.get("text");
  return text instanceof Y.Text ? text.toString() : "";
}

// ── 增量派生缓存（SP-B2 第二步 / 根因 B2）──
//
// 时间线派生从"每批次全量重建全部 entry"改为 per-entry 缓存 + dirty 标记：
// 未变 entry 的派生结果直接复用引用（使 ChatView 的 React.memo 引用比较真正
// 生效），重算只重建脏 entry。缓存挂在 Y.Doc 实例上（WeakMap），doc 销毁后
// 随之回收——副本为纯投影，可随时从后端 doc 全量重建（issue 裁决原则 1/3）。
//
// 失效安全网：任何无法精确定位的变更（如新建 toolCall 时引用关系未知、entry
// 结构性删除导致后续 entry 输出位移）都回落全量重算——增量只是性能优化，
// 正确性永远以全量重算结果为准。

/** 单个 entry 的缓存元数据：派生结果对输出位置敏感（seq / 段 id），位移即失效 */
interface EntryDerivationMeta {
  /** 派生时该 entry 在 entryOrder 中的位序（user_message.seq 的取值来源） */
  orderIndex: number;
  /** 派生时该 entry 首条消息在全局输出中的序号（assistant 段 seq 的基准） */
  startOutputSeq: number;
  /** 派生时该 entry 的 blockOrder 引用到的 toolCallId（反向索引维护用） */
  toolCallIds: string[];
}

interface TimelineDerivationCache {
  /** entryId → 派生消息（未脏直接复用，保证引用稳定） */
  perEntry: Map<string, StructuredMessage[]>;
  entryMeta: Map<string, EntryDerivationMeta>;
  /** 脏 entry 集合；null 表示全量失效（冷启动 / 失效边界不确定） */
  dirtyEntries: Set<string> | null;
  /** toolCallId → 引用它的 entryId 集合（toolCalls 变更定向失效） */
  toolCallOwners: Map<string, Set<string>>;
}

const timelineCaches = new WeakMap<Y.Doc, TimelineDerivationCache>();

/**
 * 获取（或懒初始化）doc 的时间线派生缓存，并挂载失效观察者。
 *
 * 结构未同步（快照未到达）时返回 null：entries/toolCalls 实例由首个 update
 * 创建，此时退回全量路径；观察者挂在实例上，实例在 doc 生命周期内稳定
 * （initChatDocStructure 只在缺失时创建，clear 路径复用同一实例）。
 */
function getTimelineCache(ydoc: Y.Doc): TimelineDerivationCache | null {
  const entries = getEntriesMap(ydoc);
  const toolCalls = getToolCallsMap(ydoc);
  if (!entries || !toolCalls) return null;
  const existing = timelineCaches.get(ydoc);
  if (existing) return existing;

  const cache: TimelineDerivationCache = {
    perEntry: new Map(),
    entryMeta: new Map(),
    // 首次派生必然全量：把观察者挂载前已存在的内容全部纳入基线
    dirtyEntries: null,
    toolCallOwners: new Map(),
  };
  // entries 及其全部嵌套类型（blocks / blockOrder / Y.Text 文本流）任何变更：
  // 嵌套变更经 path[0] 定位 entry；entries 顶层增删改经事件 keys 定位
  entries.observeDeep((events) => {
    if (cache.dirtyEntries === null) return; // 已处于全量失效，无需细分
    for (const event of events) {
      const target = event.path[0];
      if (typeof target === "string") {
        cache.dirtyEntries.add(target);
        continue;
      }
      for (const key of event.keys.keys()) cache.dirtyEntries.add(key);
    }
  });
  // toolCalls 变更（状态/结果/权限关联，独立于 entry 结构）：能定位引用 entry
  // 则只失效这些 entry；引用关系未知（新建 toolCall，可能已有 blockOrder 引用
  // 但派生时 tool 未到达）时无法安全缩小范围，回落全量重算。
  // 必须 observeDeep：状态迁移是对 tool 内部 Y.Map 的就地修改，浅层 observe
  // 只能看到 toolCall 增删，看不到 status/result 变化
  toolCalls.observeDeep((events) => {
    for (const event of events) {
      const nestedId = event.path[0];
      const toolCallIds = typeof nestedId === "string" ? [nestedId] : [...event.keys.keys()];
      for (const toolCallId of toolCallIds) {
        const owners = cache.toolCallOwners.get(toolCallId);
        if (!owners || owners.size === 0) {
          cache.dirtyEntries = null;
          return;
        }
        if (cache.dirtyEntries !== null) {
          for (const entryId of owners) cache.dirtyEntries.add(entryId);
        }
      }
    }
  });
  timelineCaches.set(ydoc, cache);
  return cache;
}

/**
 * 派生单个 entry 的展示消息（纯函数：entry + toolCalls 内容 + 位置参数决定输出）。
 *
 * seq 语义与既有全量派生逐字段等价：user_message.seq = entryOrder 位序；
 * assistant 段 seq = startOutputSeq + 段前已输出消息数（等价于全量派生中
 * push 时刻的 messages.length）。registerToolRef 登记 blockOrder 引用的
 * toolCallId（无论 tool 是否已存在），供 toolCalls 变更定向失效。
 */
function deriveEntryMessages(
  entry: Y.Map<unknown>,
  entryId: string,
  toolCalls: Y.Map<Y.Map<unknown>> | undefined,
  orderIndex: number,
  startOutputSeq: number,
  registerToolRef: (toolCallId: string) => void,
): StructuredMessage[] {
  const derived: StructuredMessage[] = [];
  const kind = entry.get("kind") as string | undefined;
  const role = entry.get("role") as string | undefined;
  const blockOrder = (entry.get("blockOrder") as Y.Array<string> | undefined)?.toArray() ?? [];
  const blocks = entry.get("blocks") as Y.Map<Y.Map<unknown>> | undefined;
  const ts = entry.get("createdAt") ? new Date(entry.get("createdAt") as string).getTime() : Date.now();

  if (kind === "message" && role === "user") {
    const content = blockOrder
      .map((blockId) => blockText(blocks?.get(blockId)))
      .filter(Boolean)
      .join("\n");
    derived.push({ type: "user_message", id: entryId, content, seq: orderIndex, ts });
    return derived;
  }

  if (kind === "message" && role === "assistant") {
    // 按 tool_call 块切分展示消息：文本段被工具调用打断时拆为多条 assistant_message，
    // 保证 "ai → tool×N → ai" 按真实顺序渲染（后端已把打断后的文本写入独立 text:N 块，
    // 此处不能在一条消息内合并展示——否则工具调用全部排到两段文本之后）。
    let chunks: AssistantChunk[] = [];
    let segment = 0;
    const flushChunks = () => {
      if (chunks.length === 0) return;
      derived.push({
        type: "assistant_message",
        // 首段沿用 entryId（兼容既有消费者），后续段追加段号保证 React key 唯一
        id: segment === 0 ? entryId : `${entryId}#${segment}`,
        chunks,
        seq: startOutputSeq + derived.length,
        ts,
      });
      segment += 1;
      chunks = [];
    };
    // 遍历 blockOrder 保持输出顺序：reasoning → thought 块，text → message 块，
    // tool_call → 先冲刷已累积文本段再投影工具条目
    for (const blockId of blockOrder) {
      const block = blocks?.get(blockId);
      if (!block) continue;
      const blockType = block.get("type") as string | undefined;
      if (blockType === "tool_call") {
        flushChunks();
        const toolCallId = block.get("toolCallId") as string | undefined;
        if (!toolCallId) continue;
        registerToolRef(toolCallId);
        const tool = toolCalls?.get(toolCallId);
        if (!tool) continue;

        const status = (tool.get("status") as string) || "running";
        const permissionId = tool.get("permissionId") as string | null | undefined;
        // 工具失败脱敏错误：后端 ToolCallProjection.publicError 投影，取 message 兜底为空
        const publicErrorRaw = tool.get("publicError");
        const publicError =
          publicErrorRaw && typeof publicErrorRaw === "object"
            ? extractPublicErrorInfo(publicErrorRaw as Record<string, unknown>)
            : undefined;
        const toolMessage: StructuredMessage = {
          type: "tool_call",
          id: toolCallId,
          title: (tool.get("name") as string) || "",
          status: mapToolCallMessageStatus(status),
          content: [],
          rawInput: (tool.get("arguments") as Record<string, unknown> | undefined) ?? undefined,
          rawOutput: (tool.get("result") as Record<string, unknown> | undefined) ?? undefined,
          publicError,
        };
        if (permissionId) {
          // Chat Doc 侧拿不到权限选项（pendingPermissions 在 Session Doc）：
          // 此处保持占位空数组，真实选项由 use-session-state 合并层
          // （meta.permissionOptions → computeSessionSnapshot）按 requestId 覆盖
          toolMessage.permissionRequest = { requestId: permissionId, options: [] };
        }
        derived.push(toolMessage);
        continue;
      }
      const text = blockText(block);
      if (blockType === "reasoning" && text) chunks.push({ type: "thought", text });
      else if (blockType === "text" && text) chunks.push({ type: "message", text });
    }
    flushChunks();
    // turn 失败错误（ChatEntry.error）：挂到最后一段助手消息；整段无文本（纯失败 turn）
    // 时创建仅含错误的消息承载，保证前端能渲染失败态而非"空 assistant entry"
    const entryError = entry.get("error");
    const errorInfo =
      entryError && typeof entryError === "object"
        ? extractPublicErrorInfo(entryError as Record<string, unknown>)
        : undefined;
    if (errorInfo) {
      // 错误只挂本 entry 派生出的最后一段助手消息（id 前缀 entryId），
      // 不能在整条时间线里 find——纯失败 turn 会把错误误挂到前一个 turn 的消息上
      const lastAssistant = [...derived]
        .reverse()
        .find(
          (m): m is Extract<StructuredMessage, { type: "assistant_message" }> =>
            m.type === "assistant_message" && (m.id === entryId || m.id.startsWith(`${entryId}#`)),
        );
      if (lastAssistant) {
        lastAssistant.error = errorInfo;
      } else {
        derived.push({
          type: "assistant_message",
          id: `${entryId}#error`,
          chunks: [],
          seq: startOutputSeq + derived.length,
          ts,
          error: errorInfo,
        });
      }
    }
    return derived;
  }

  // plan 以 system entry 投影（planEntries 结构化字段 + 人类可读摘要）
  if (kind === "system") {
    const planEntries = entry.get("planEntries") as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(planEntries)) {
      derived.push({
        type: "plan",
        id: entryId,
        entries: planEntries.map((e) => ({
          content: (e.content as string) || "",
          priority: (e.priority as "high" | "medium" | "low") || "medium",
          status: (e.status as "pending" | "in_progress" | "completed") || "pending",
        })),
      });
    }
  }
  return derived;
}

/**
 * 从 Chat Doc 按 entryOrder 顺序派生 StructuredMessage[]（保持既有展示形状）。
 *
 * 增量路径（SP-B2 第二步）：未脏 entry 复用缓存派生结果（引用稳定）；脏 entry
 * 与位置位移 entry 重派生。输出数组每次新建（装配成本 O(N) 浅拷贝），但未变
 * entry 的消息对象引用不变，下游 React.memo / useMemo 依赖比较得以命中。
 */
export function chatDocEntriesToStructuredMessages(ydoc: Y.Doc): StructuredMessage[] {
  // 复用 @fenix/chat-channel 的 Chat Doc getters（state/chat-writer.ts），
  // 与后端 factory/aggregator 保持同一物理映射
  const order = getEntryOrder(ydoc);
  const entries = getEntriesMap(ydoc);
  const toolCalls = getToolCallsMap(ydoc);

  // Chat Doc 尚未同步（快照未到达）时返回空时间线：不得创建未插入 doc 的
  // Y 类型占位后读取（Yjs 会抛 "Invalid access: Add Yjs type to a document..."）
  if (!order || !entries) return [];
  const cache = getTimelineCache(ydoc);
  if (!cache) return [];

  // 全量失效（冷启动 / toolCalls 引用关系未知）：清空缓存整体重建。
  // entry 删除等结构性变更不在此处理——由"位移重派生 + 缓存修剪"兜底
  if (cache.dirtyEntries === null) {
    cache.perEntry.clear();
    cache.entryMeta.clear();
    cache.toolCallOwners.clear();
  }
  const dirty = cache.dirtyEntries;

  const entryIds = order.toArray();
  const messages: StructuredMessage[] = [];

  for (let i = 0; i < entryIds.length; i++) {
    const entryId = entryIds[i] ?? "";
    const entry = entries.get(entryId);
    if (!entry) continue;

    const cached = cache.perEntry.get(entryId);
    const meta = cache.entryMeta.get(entryId);
    // 位置敏感（seq / 段 id）：前序 entry 输出数量变化导致位移时重派生，
    // 保证与全量派生逐字段一致；追加式流式输出不会移动前序 entry，命中缓存
    const stale =
      !cached ||
      !meta ||
      (dirty?.has(entryId) ?? false) ||
      meta.orderIndex !== i ||
      meta.startOutputSeq !== messages.length;
    if (!stale && cached) {
      for (const m of cached) messages.push(m);
      continue;
    }

    // 重派生前先撤销旧的反向引用，再由派生过程登记新引用
    if (meta) {
      for (const refId of meta.toolCallIds) cache.toolCallOwners.get(refId)?.delete(entryId);
    }
    const toolCallIds: string[] = [];
    const derived = deriveEntryMessages(entry, entryId, toolCalls, i, messages.length, (toolCallId) => {
      toolCallIds.push(toolCallId);
      let ownerSet = cache.toolCallOwners.get(toolCallId);
      if (!ownerSet) {
        ownerSet = new Set();
        cache.toolCallOwners.set(toolCallId, ownerSet);
      }
      ownerSet.add(entryId);
    });
    cache.perEntry.set(entryId, derived);
    cache.entryMeta.set(entryId, { orderIndex: i, startOutputSeq: messages.length, toolCallIds });
    for (const m of derived) messages.push(m);
  }

  // 修剪已删除 entry 的缓存项（entry 删除 / 清空 doc 场景，防缓存无界增长）
  if (cache.perEntry.size > entries.size) {
    for (const key of cache.perEntry.keys()) {
      if (entries.has(key)) continue;
      cache.perEntry.delete(key);
      const removedMeta = cache.entryMeta.get(key);
      if (removedMeta) {
        for (const refId of removedMeta.toolCallIds) cache.toolCallOwners.get(refId)?.delete(key);
        cache.entryMeta.delete(key);
      }
    }
  }

  cache.dirtyEntries = new Set();
  return messages;
}

/** ToolCallProjection 状态 → ToolCallMessage 展示状态 */
function mapToolCallMessageStatus(status: string): ToolCallMessageStatus {
  switch (status) {
    case "completed":
      return "complete";
    case "awaiting_permission":
      return "waiting_for_confirmation";
    case "cancelled":
      return "canceled";
    case "error":
      return "error";
    default:
      return "running";
  }
}

type ToolCallMessageStatus = "running" | "complete" | "error" | "waiting_for_confirmation" | "canceled" | "rejected";
