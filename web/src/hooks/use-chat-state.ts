// web/src/hooks/use-chat-state.ts
// 订阅两份 Y.Doc 派生 ChatStateSnapshot（展示形状保持，数据来源切到新 schema）：
// - Chat Doc（chat:{rcsSessionId}）：token 用量（turn 完成时写入 assistant entry）
// - Session Doc（session:{rcsSessionId}）：session/agent/pendingPermissions
//
// 旧字段（agentInfo/sessions/chatMeta/connection）已从 Y.Doc schema 删除；
// 此处按新结构派生，无法派生的字段给保守默认值。
// modelState/modeState/availableCommands 为会话级元数据：session/new、load 响应的
// models/modes 与 available_commands_update 通知经聚合层投影到 Session Doc session map，
// 此处从嵌套 Y.Map/Y.Array 转换回展示形状。
//
// Y.Doc 副本合一（SP-B1 / 根因 B1）：两份 doc 从 DocHub 取共享实例（引用计数），
// 本 hook 只读派生，WS update 由 ChatPanel 经 hub 单写（不再自带 applyUpdate）。
// meta 子树级增量派生（SP-B5 / 根因 B5）：sessions/permissions/modelState/
// modeState/availableCommands/capabilities 各自独立缓存，未变子树引用稳定。

import type { ChatStateSnapshot } from "@fenix/chat-channel";
import { createYjsStore, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { sessionOptionKindsToPermissionOptions } from "../lib/structured-to-thread";
import {
  createChatDocBinding,
  createSessionDocBinding,
  getDocHubReplacementVersion,
  subscribeDocHubReplacement,
} from "../yjs/doc-hub";

// ── Chat Doc 派生：token 用量（turn 终态写入 assistant entry 的 tokenUsage）──

interface ChatTokenSnapshot {
  tokenUsage: ChatStateSnapshot["tokenUsage"];
}

/**
 * 从 Chat Doc 派生 token 用量（纯函数，无副作用）。
 * 导出仅供测试：直接构造 entryOrder/entries 验证倒序扫描（SP-B4）的
 * 行为等价性——取最后一个带 tokenUsage 的 assistant entry，找到即停。
 */
export function computeTokenSnapshot(ydoc: Y.Doc): ChatTokenSnapshot {
  const root = ydoc.getMap("root");
  // Chat Doc 尚未同步（快照未到达）时返回默认值：不得创建未插入 doc 的
  // Y 类型占位后读取（Yjs 会抛 "Invalid access: Add Yjs type to a document..."）
  const order = root.get("entryOrder") as Y.Array<string> | undefined;
  const entries = root.get("entries") as Y.Map<Y.Map<unknown>> | undefined;
  if (!order || !entries) return { tokenUsage: null };

  // 取最后一个携带 tokenUsage 的 assistant entry（prompt_complete 写入）。
  // 倒序扫描（SP-B4）：tokenUsage 总是随 turn 终态追加在尾部，从 entryOrder
  // 末端找到第一个命中即停，避免长会话每个流式批次都 O(N) 全量扫描
  const orderIds = order.toArray();
  for (let i = orderIds.length - 1; i >= 0; i--) {
    const entry = entries.get(orderIds[i]);
    if (!entry) continue;
    if (entry.get("kind") !== "message" || entry.get("role") !== "assistant") continue;
    const usage = entry.get("tokenUsage") as
      | { totalTokens?: number; inputTokens?: number; outputTokens?: number; contextWindow?: number }
      | undefined;
    if (usage && typeof usage === "object") return { tokenUsage: usage };
  }
  return { tokenUsage: null };
}

// ── Session Doc 派生：会话元信息 + Agent 状态 + 权限 ──

/** 从 Session Doc session map 读取 Model 状态（嵌套 Y.Map/Y.Array 结构 → plain object） */
function readModelState(session: Y.Map<unknown> | undefined): ChatStateSnapshot["modelState"] {
  const raw = session?.get("modelState");
  if (!(raw instanceof Y.Map)) return null;
  const currentModelId = raw.get("currentModelId");
  const models = raw.get("availableModels");
  if (typeof currentModelId !== "string" || !(models instanceof Y.Array)) return null;
  const availableModels: Array<{ modelId: string; name: string }> = [];
  for (const m of models) {
    if (!(m instanceof Y.Map)) continue;
    availableModels.push({
      modelId: String(m.get("modelId") ?? ""),
      name: String(m.get("name") ?? ""),
    });
  }
  if (availableModels.length === 0) return null;
  return { currentModelId, availableModels };
}

/** 从 Session Doc session map 读取 Mode 状态（嵌套 Y.Map/Y.Array 结构 → plain object） */
function readModeState(session: Y.Map<unknown> | undefined): ChatStateSnapshot["modeState"] {
  const raw = session?.get("modeState");
  if (!(raw instanceof Y.Map)) return null;
  const currentModeId = raw.get("currentModeId");
  const modes = raw.get("availableModes");
  if (typeof currentModeId !== "string" || !(modes instanceof Y.Array)) return null;
  const availableModes: Array<{ id: string; name: string; description?: string | null }> = [];
  for (const m of modes) {
    if (!(m instanceof Y.Map)) continue;
    availableModes.push({
      id: String(m.get("id") ?? ""),
      name: String(m.get("name") ?? ""),
      description: (m.get("description") as string | null | undefined) ?? null,
    });
  }
  if (availableModes.length === 0) return null;
  return { currentModeId, availableModes };
}

/** 从 Session Doc session map 读取可用命令列表（available_commands_update 投影，slash 命令菜单数据源） */
function readAvailableCommands(session: Y.Map<unknown> | undefined): ChatStateSnapshot["availableCommands"] {
  const raw = session?.get("availableCommands");
  if (!(raw instanceof Y.Array)) return [];
  const commands: ChatStateSnapshot["availableCommands"] = [];
  for (const c of raw) {
    if (!(c instanceof Y.Map)) continue;
    // input 存储形状为 null 或 { hint }，读取时 null 直接省略字段（与 acp-link
    // AvailableCommand 展示类型一致，避免 null 泄漏到 UI 层）
    const input = c.get("input");
    const cmd: ChatStateSnapshot["availableCommands"][number] = {
      name: String(c.get("name") ?? ""),
      description: String(c.get("description") ?? ""),
    };
    if (input && typeof input === "object") {
      cmd.input = { hint: String((input as { hint?: unknown }).hint ?? "") };
    }
    commands.push(cmd);
  }
  return commands;
}

/** 从 Session Doc agent map 读取能力集（Y.Map<boolean> → plain object） */
function readCapabilities(agent: Y.Map<unknown> | undefined): Record<string, boolean> | null {
  const capsMap = agent?.get("capabilities");
  return capsMap instanceof Y.Map && capsMap.size > 0 ? Object.fromEntries(capsMap.entries()) : null;
}

/** 从 Session Doc pendingPermissions 派生权限卡片列表 */
function readPermissions(pending: Y.Map<Y.Map<unknown>> | undefined): ChatStateSnapshot["permissions"] {
  const permissions: ChatStateSnapshot["permissions"] = [];
  if (!pending) return permissions;
  for (const [permissionId, permission] of pending.entries()) {
    // Session Doc 三态（pending/resolved/expired）→ 前端展示态：
    // 只有 pending 可操作；resolved 按 CAS 落盘的 decision 展示 approved/denied
    // （兼容旧快照：无 decision 字段时 resolved 仍显示 approved）；
    // expired 一律 denied（后端过期不写 decision，保持 null）
    const rawStatus = permission.get("status");
    const decision = permission.get("decision");
    const displayStatus: "pending" | "approved" | "denied" =
      rawStatus === "pending"
        ? "pending"
        : rawStatus === "resolved"
          ? decision === "deny"
            ? "denied"
            : "approved"
          : "denied";
    permissions.push({
      id: permissionId,
      tool: (permission.get("title") as string) || "",
      args: (permission.get("description") as Record<string, unknown> | undefined) ?? undefined,
      level: "ask",
      status: displayStatus,
      ts: permission.get("expiresAt") ? new Date(permission.get("expiresAt") as string).getTime() : 0,
      options: sessionOptionKindsToPermissionOptions(permission.get("options")),
    });
  }
  return permissions;
}

/** 从 Session Doc sessions 投影派生会话列表（含当前会话兜底条目） */
function readSessions(
  rawSessions: unknown,
  session: Y.Map<unknown> | undefined,
  currentSessionId: string | undefined,
): ChatStateSnapshot["sessions"] {
  // 会话列表：Session Doc sessions 投影派生（sessionId/title/updatedAt），
  // 无标题/未命名会话不在 agent 列表时以当前会话兜底（status=active）
  const sessions: ChatStateSnapshot["sessions"] = [];
  const currentSessionUpdatedAt = new Date().toISOString();
  if (rawSessions instanceof Y.Map) {
    for (const [sessionId, entry] of rawSessions.entries()) {
      const updatedAt = entry.get("updatedAt") as string | undefined;
      sessions.push({
        sessionId,
        title: (entry.get("title") as string | null | undefined) ?? "",
        preview: "",
        status: sessionId === currentSessionId ? "active" : "idle",
        lastMsgTs: 0,
        // 新会话尚未被 agent 写入 updatedAt 时，当前会话仍应位于历史列表最前面。
        updatedAt: updatedAt ?? (sessionId === currentSessionId ? currentSessionUpdatedAt : undefined),
      });
    }
  }
  if (currentSessionId && !sessions.some((s) => s.sessionId === currentSessionId)) {
    sessions.unshift({
      sessionId: currentSessionId,
      title: (session?.get("title") as string | null | undefined) ?? "",
      preview: "",
      status: "active",
      lastMsgTs: 0,
      // 新会话尚未被 agent 的 session_list 收录时没有 updatedAt；使用当前时间，
      // 确保它在前端历史列表中作为最新会话显示在最前面。
      updatedAt: new Date().toISOString(),
    });
  }
  return sessions;
}

// ── meta 子树级增量派生缓存（SP-B5 / 根因 B5）──
//
// computeMetaSnapshot 每次重算原本遍历整个 sessions map + pendingPermissions +
// modelState 等全部子树。此处按子树独立缓存 + observeDeep dirty 标记：未变子树
// 直接复用缓存引用（=== 稳定），重算只处理脏子树。缓存挂在 Y.Doc 实例上
// （WeakMap），纯投影、可从后端 doc 全量重建（issue 裁决原则 1/3）。

interface MetaSubtreeFlags {
  sessions: boolean;
  permissions: boolean;
  modelState: boolean;
  modeState: boolean;
  availableCommands: boolean;
  capabilities: boolean;
}

interface MetaDerivationCache {
  sessions: ChatStateSnapshot["sessions"] | null;
  permissions: ChatStateSnapshot["permissions"] | null;
  modelState: ChatStateSnapshot["modelState"] | null;
  modeState: ChatStateSnapshot["modeState"] | null;
  availableCommands: ChatStateSnapshot["availableCommands"] | null;
  // capabilities 派生结果为 Y.Map<boolean> 的 plain 投影（Record<string, boolean>）；
  // 合并进 ChatStateSnapshot 时结构兼容 CapabilitiesInfo（宽松索引签名）
  capabilities: Record<string, boolean> | null;
  dirty: MetaSubtreeFlags;
}

const metaCaches = new WeakMap<Y.Doc, MetaDerivationCache>();

/** session map 顶层 key → 受影响子树路由 */
function markSessionSubtree(dirty: MetaSubtreeFlags, key: string): void {
  switch (key) {
    case "modelState":
      dirty.modelState = true;
      break;
    case "modeState":
      dirty.modeState = true;
      break;
    case "availableCommands":
      dirty.availableCommands = true;
      break;
    // sessionId 决定列表 active 标记与兜底条目；title 为兜底条目标题来源
    case "sessionId":
    case "title":
      dirty.sessions = true;
      break;
    default:
      break; // status/updatedAt 等标量为逐次直读，无缓存
  }
}

/** 单个 observeDeep 事件 → 子树 dirty 标记（path 相对 Session Doc root） */
function markMetaEvent(cache: MetaDerivationCache, event: Y.YEvent<Y.AbstractType<unknown>>): void {
  const dirty = cache.dirty;
  const path = event.path;
  if (path.length === 0) {
    // root 自身 key 变化（子树整体替换 / sessionListLoaded / projectionVersion）。
    // 子树整体替换时无法断言内部未变，按整树失效处理
    for (const key of event.keys.keys()) {
      switch (key) {
        case "sessions":
          dirty.sessions = true;
          break;
        case "pendingPermissions":
          dirty.permissions = true;
          break;
        case "agent":
          dirty.capabilities = true;
          break;
        case "session":
          dirty.modelState = true;
          dirty.modeState = true;
          dirty.availableCommands = true;
          dirty.sessions = true;
          break;
        default:
          break;
      }
    }
    return;
  }
  switch (path[0]) {
    case "sessions":
      dirty.sessions = true;
      break;
    case "pendingPermissions":
      dirty.permissions = true;
      break;
    case "agent":
      if (path.length === 1) {
        if (event.keys.has("capabilities")) dirty.capabilities = true;
      } else if (path[1] === "capabilities") {
        dirty.capabilities = true;
      }
      break;
    case "session":
      // session 子树内变更：顶层 key 粒度路由（嵌套变更经 path[1] 定位归属子树）
      if (path.length === 1) {
        for (const key of event.keys.keys()) markSessionSubtree(dirty, key);
      } else {
        markSessionSubtree(dirty, String(path[1]));
      }
      break;
    default:
      break;
  }
}

function getMetaCache(ydoc: Y.Doc): MetaDerivationCache {
  const existing = metaCaches.get(ydoc);
  if (existing) return existing;
  const cache: MetaDerivationCache = {
    sessions: null,
    permissions: null,
    modelState: null,
    modeState: null,
    availableCommands: null,
    capabilities: null,
    // 首次派生必然全量：把观察者挂载前已存在的内容全部纳入基线
    dirty: {
      sessions: true,
      permissions: true,
      modelState: true,
      modeState: true,
      availableCommands: true,
      capabilities: true,
    },
  };
  ydoc.getMap("root").observeDeep((events) => {
    for (const event of events) markMetaEvent(cache, event);
  });
  metaCaches.set(ydoc, cache);
  return cache;
}

interface ChatMetaSnapshot {
  sessionId: string;
  title: string | null;
  status: string;
  instanceId: string | null;
  acpSessionId: string | null;
  /** 当前会话的 Model 状态（session/new、load 响应投影，会话级元数据） */
  modelState: ChatStateSnapshot["modelState"];
  /** 当前会话的 Mode 状态 */
  modeState: ChatStateSnapshot["modeState"];
  /** 当前会话的可用命令列表 */
  availableCommands: ChatStateSnapshot["availableCommands"];
  capabilities: Record<string, boolean> | null;
  permissions: ChatStateSnapshot["permissions"];
  /** 会话列表（Session Doc sessions 投影派生；含当前会话兜底） */
  sessions: ChatStateSnapshot["sessions"];
  /** agent 会话列表是否已权威确认（session_list 响应投影过；空列表 ≠ 无会话，见 ChatStateSnapshot 注释） */
  sessionListLoaded: boolean;
}

/**
 * 从 Session Doc 派生 meta 快照（子树级增量，未变子树引用稳定）。
 * 导出仅供测试：直接构造 Session Doc 验证子树级按需派生的失效边界。
 */
export function computeMetaSnapshot(ydoc: Y.Doc): ChatMetaSnapshot {
  const root = ydoc.getMap("root");
  // Session Doc 尚未同步（快照未到达）时字段缺失按默认值处理；
  // 不得用 new Y.Map() 占位后读取（Yjs 抛 "Invalid access: Add Yjs type to a document..."）
  const session = root.get("session") as Y.Map<unknown> | undefined;
  const agent = root.get("agent") as Y.Map<unknown> | undefined;

  const cache = getMetaCache(ydoc);
  const currentSessionId = session?.get("sessionId") as string | undefined;

  // 标量子树读取（cheap）：每次直读，不参与缓存
  // 脏子树重建 → 写回缓存；未脏子树复用缓存引用（=== 稳定）
  if (cache.dirty.permissions || cache.permissions === null) {
    cache.permissions = readPermissions(root.get("pendingPermissions") as Y.Map<Y.Map<unknown>> | undefined);
  }
  if (cache.dirty.sessions || cache.sessions === null) {
    cache.sessions = readSessions(root.get("sessions"), session, currentSessionId);
  }
  if (cache.dirty.capabilities || cache.capabilities === null) {
    cache.capabilities = readCapabilities(agent);
  }
  if (cache.dirty.modelState || cache.modelState === null) {
    cache.modelState = readModelState(session);
  }
  if (cache.dirty.modeState || cache.modeState === null) {
    cache.modeState = readModeState(session);
  }
  if (cache.dirty.availableCommands || cache.availableCommands === null) {
    cache.availableCommands = readAvailableCommands(session);
  }
  cache.dirty = {
    sessions: false,
    permissions: false,
    modelState: false,
    modeState: false,
    availableCommands: false,
    capabilities: false,
  };

  return {
    sessionId: currentSessionId ?? "",
    title: (session?.get("title") as string | null | undefined) ?? null,
    status: (session?.get("status") as string | undefined) ?? "initializing",
    instanceId: (agent?.get("instanceId") as string | null | undefined) ?? null,
    acpSessionId: (agent?.get("acpSessionId") as string | null | undefined) ?? null,
    capabilities: cache.capabilities,
    modelState: cache.modelState,
    modeState: cache.modeState,
    availableCommands: cache.availableCommands,
    permissions: cache.permissions,
    sessions: cache.sessions,
    sessionListLoaded: root.get("sessionListLoaded") === true,
  };
}

// ── 合并快照 ──

function computeChatSnapshot(token: ChatTokenSnapshot, meta: ChatMetaSnapshot): ChatStateSnapshot {
  return {
    sessions: meta.sessions,
    activeSessionId: meta.sessionId,
    permissions: meta.permissions,
    capabilities: meta.capabilities,
    modelState: meta.modelState,
    modeState: meta.modeState,
    availableCommands: meta.availableCommands,
    sessionListLoaded: meta.sessionListLoaded,
    tokenUsage: token.tokenUsage,
  };
}

/**
 * 订阅 chat 级别状态（时间线 token + 会话元信息）。
 * 内部双 store（Chat Doc / Session Doc）绑定 DocHub 的共享 doc 实例
 * （SP-B1），WS update 由 ChatPanel 经 applyDocHubUpdate 单写，本 hook 只读派生。
 */
export function useChatState(rcsSessionId: string) {
  const storeRef = useRef<{
    chat: YjsStore<ChatTokenSnapshot>;
    meta: YjsStore<ChatMetaSnapshot>;
  } | null>(null);
  if (!storeRef.current) {
    storeRef.current = {
      chat: createYjsStore<ChatTokenSnapshot>(computeTokenSnapshot, { tokenUsage: null }),
      meta: createYjsStore<ChatMetaSnapshot>(computeMetaSnapshot, {
        sessionId: "",
        title: null,
        status: "initializing",
        instanceId: null,
        acpSessionId: null,
        capabilities: null,
        modelState: null,
        modeState: null,
        availableCommands: [],
        permissions: [],
        sessions: [],
        sessionListLoaded: false,
      }),
    };
  }
  const stores = storeRef.current;

  // 绑定工厂：从 DocHub 取共享 doc（ownsDoc=false，生命周期归 hub 引用计数）；
  // useCallback 保持引用稳定，渲染期与 effect 期复用同一工厂
  const bindChatDoc = useCallback(() => createChatDocBinding(rcsSessionId), [rcsSessionId]);
  const bindSessionDoc = useCallback(() => createSessionDocBinding(rcsSessionId), [rcsSessionId]);

  // 重订阅驱动（bind epoch）：destroy 会清空 store listeners（store 契约），
  // 而 useSyncExternalStore 只在 subscribe 引用变化时重订阅——cleanup destroy
  // 后必须重建订阅，否则切换会话 / StrictMode 双挂载后后续 update 不再触发
  // 渲染（快照永久 stale，SP-B1 回归测试捕获的真实缺陷）。
  const [bindEpoch, setBindEpoch] = useState(0);
  const subscribeReplacement = useCallback(
    (listener: () => void) => subscribeDocHubReplacement(rcsSessionId, listener),
    [rcsSessionId],
  );
  const getReplacementVersion = useCallback(() => getDocHubReplacementVersion(rcsSessionId), [rcsSessionId]);
  const replacementVersion = useSyncExternalStore(subscribeReplacement, getReplacementVersion, getReplacementVersion);
  // biome-ignore lint/correctness/useExhaustiveDependencies: bindEpoch 不在回调体内使用，作为 subscribe 引用变化的驱动依赖（见上注释）
  const subscribeChat = useCallback((cb: () => void) => stores.chat.subscribe(cb), [bindEpoch]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同上，bindEpoch 仅驱动引用变化
  const subscribeMeta = useCallback((cb: () => void) => stores.meta.subscribe(cb), [bindEpoch]);

  const token = useSyncExternalStore(subscribeChat, stores.chat.getSnapshot);
  const meta = useSyncExternalStore(subscribeMeta, stores.meta.getSnapshot);
  const state = useMemo(() => computeChatSnapshot(token, meta), [token, meta]);

  useEffect(() => {
    // Doc 绑定只在 effect 期执行（不在渲染期 switchDoc）：渲染期 switchDoc 的
    // notify() 会在渲染进行中触发已订阅组件的 setState（React 报错），且本组件
    // 的 listeners 已被 cleanup destroy 清空，必须经 bindEpoch 重订阅兜底。
    // StrictMode 双挂载 / 切换会话：cleanup destroy 已重置 activeKey（""），
    // 此处 switchDoc 重建 hub 绑定；destroy 经 binding.cleanup 释放 hub 引用，
    // 计数归零才销毁共享 doc。绑定完成后推进 epoch 驱动重订阅。
    const bindingKey = `${rcsSessionId}:${replacementVersion}`;
    stores.chat.switchDoc(bindingKey, bindChatDoc);
    stores.meta.switchDoc(bindingKey, bindSessionDoc);
    setBindEpoch((e) => e + 1);
    return () => {
      stores.chat.destroy();
      stores.meta.destroy();
    };
  }, [stores, rcsSessionId, bindChatDoc, bindSessionDoc, replacementVersion]);

  return { state };
}
