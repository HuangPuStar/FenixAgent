// web/src/yjs/doc-hub.ts
// 会话级 Y.Doc 副本合一（SP-B1 / 根因 B1）：
//
// 改造前 use-chat-state 与 use-session-state 各自 new 两份 Y.Doc 并各自 applyUpdate，
// 同一浏览器页面同一会话存在 4 份 doc 副本（apply CPU / 内存 ×2，且每条 WS update
// 被双写）。本模块按 rcsSessionId 持有唯一的 Chat Doc + Session Doc，两个 hook 的
// store 通过 createYjsStore 绑定到同一实例（各自 computeSnapshot 独立），WS update
// 只经 applyDocHubUpdate 写一次。
//
// 架构边界（issue 统一裁决原则 1）：hub 是「共享同一份后端投影」，不是新增前端
// 事实源——副本与派生缓存可随时从后端 doc 全量重建，不持久化任何本地状态。
//
// 生命周期：引用计数。store 通过 switchDoc 工厂拿到 ownsDoc=false 的绑定
// （doc 生命周期归 hub），切换/销毁时经 cleanup 释放引用；计数归零才 destroy
// 两份 doc。StrictMode 双挂载与切换会话由 yjs-store 的 activeKey 幂等保护 +
// 本模块 acquire/release 配对保证（每成功 switchDoc 恰好 acquire 一次、每
// destroy/切换恰好 release 一次）。

import { applyRemoteDocUpdate } from "@fenix/chat-channel";
import * as Y from "yjs";

interface DocHubEntry {
  chatDoc: Y.Doc;
  sessionDoc: Y.Doc;
  chatGeneration: string | null;
  sessionGeneration: string | null;
  /** 活跃绑定数（每个 hook 的每个 store 各持 1）；归零即销毁并移除 entry */
  refs: number;
}

/** 会话 → doc 副本注册表（模块级单例：页面内同一会话全局唯一） */
const hubEntries = new Map<string, DocHubEntry>();
const replacementListeners = new Map<string, Set<() => void>>();
const replacementVersions = new Map<string, number>();
const stagedReplacements = new Map<string, { generation: string; chatDoc?: Y.Doc; sessionDoc?: Y.Doc }>();

export function getDocHubReplacementVersion(rcsSessionId: string): number {
  return replacementVersions.get(rcsSessionId) ?? 0;
}

export function subscribeDocHubReplacement(rcsSessionId: string, listener: () => void): () => void {
  let listeners = replacementListeners.get(rcsSessionId);
  if (!listeners) {
    listeners = new Set();
    replacementListeners.set(rcsSessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners?.delete(listener);
    if (listeners?.size !== 0) return;
    replacementListeners.delete(rcsSessionId);
    const entry = hubEntries.get(rcsSessionId);
    if (entry?.refs === 0) {
      hubEntries.delete(rcsSessionId);
      entry.chatDoc.destroy();
      entry.sessionDoc.destroy();
    }
  };
}

function acquireEntry(rcsSessionId: string): DocHubEntry {
  let entry = hubEntries.get(rcsSessionId);
  if (!entry) {
    entry = { chatDoc: new Y.Doc(), sessionDoc: new Y.Doc(), chatGeneration: null, sessionGeneration: null, refs: 0 };
    hubEntries.set(rcsSessionId, entry);
  }
  entry.refs++;
  return entry;
}

function releaseEntry(rcsSessionId: string): void {
  const entry = hubEntries.get(rcsSessionId);
  // 幂等：未登记的 release（如 destroy 前从未绑定）直接忽略
  if (!entry) return;
  entry.refs--;
  if (entry.refs > 0 || replacementListeners.has(rcsSessionId)) return;
  hubEntries.delete(rcsSessionId);
  entry.chatDoc.destroy();
  entry.sessionDoc.destroy();
}

/** createYjsStore.switchDoc 工厂返回的共享 doc 绑定（ownsDoc=false：destroy 责任在 hub） */
export interface SharedDocBinding {
  ydoc: Y.Doc;
  ownsDoc: false;
  cleanup: () => void;
}

/** 绑定该会话的共享 Chat Doc（每次成功绑定 acquire 一次，cleanup 时 release） */
export function createChatDocBinding(rcsSessionId: string): SharedDocBinding {
  const entry = acquireEntry(rcsSessionId);
  return {
    ydoc: entry.chatDoc,
    ownsDoc: false,
    cleanup: () => releaseEntry(rcsSessionId),
  };
}

/** 绑定该会话的共享 Session Doc（语义同 createChatDocBinding） */
export function createSessionDocBinding(rcsSessionId: string): SharedDocBinding {
  const entry = acquireEntry(rcsSessionId);
  return {
    ydoc: entry.sessionDoc,
    ownsDoc: false,
    cleanup: () => releaseEntry(rcsSessionId),
  };
}

export function replaceDocHubUpdate(
  rcsSessionId: string,
  docName: string,
  generation: string,
  update: Uint8Array,
): void {
  let entry = hubEntries.get(rcsSessionId);
  if (!entry) {
    entry = { chatDoc: new Y.Doc(), sessionDoc: new Y.Doc(), chatGeneration: null, sessionGeneration: null, refs: 0 };
    hubEntries.set(rcsSessionId, entry);
  }
  let staged = stagedReplacements.get(rcsSessionId);
  if (!staged || staged.generation !== generation) {
    staged?.chatDoc?.destroy();
    staged?.sessionDoc?.destroy();
    staged = { generation };
    stagedReplacements.set(rcsSessionId, staged);
  }
  const replacement = new Y.Doc();
  applyRemoteDocUpdate(replacement, update);
  if (docName.startsWith("chat:")) {
    staged.chatDoc?.destroy();
    staged.chatDoc = replacement;
  } else if (docName.startsWith("session:")) {
    staged.sessionDoc?.destroy();
    staged.sessionDoc = replacement;
  } else {
    replacement.destroy();
    return;
  }
  if (!staged.chatDoc || !staged.sessionDoc) return;
  const oldChat = entry.chatDoc;
  const oldSession = entry.sessionDoc;
  entry.chatDoc = staged.chatDoc;
  entry.sessionDoc = staged.sessionDoc;
  entry.chatGeneration = generation;
  entry.sessionGeneration = generation;
  stagedReplacements.delete(rcsSessionId);
  oldChat.destroy();
  oldSession.destroy();
  replacementVersions.set(rcsSessionId, (replacementVersions.get(rcsSessionId) ?? 0) + 1);
  for (const listener of replacementListeners.get(rcsSessionId) ?? []) listener();
}

/** 返回当前 hub Doc 的 state vector，供 WS 重连执行差量同步。 */
export function getDocHubStateVectors(
  rcsSessionId: string,
): Array<{ docName: string; generation: string; stateVector: Uint8Array }> {
  const entry = hubEntries.get(rcsSessionId);
  if (!entry) return [];
  const vectors: Array<{ docName: string; generation: string; stateVector: Uint8Array }> = [];
  if (entry.chatGeneration)
    vectors.push({
      docName: `chat:${rcsSessionId}`,
      generation: entry.chatGeneration,
      stateVector: Y.encodeStateVector(entry.chatDoc),
    });
  if (entry.sessionGeneration)
    vectors.push({
      docName: `session:${rcsSessionId}`,
      generation: entry.sessionGeneration,
      stateVector: Y.encodeStateVector(entry.sessionDoc),
    });
  return vectors;
}

export function setDocHubGeneration(rcsSessionId: string, docName: string, generation: string): void {
  const entry = hubEntries.get(rcsSessionId);
  if (!entry) return;
  if (docName.startsWith("chat:")) entry.chatGeneration = generation;
  else if (docName.startsWith("session:")) entry.sessionGeneration = generation;
}

/**
 * WS update 单写入口：按 docName 前缀路由到该会话唯一的 Chat / Session doc。
 *
 * - 经 applyRemoteDocUpdate 应用（显式 origin），绑定该 doc 的所有 store 走
 *   合并宏任务重算路径——apply 一次、全部监听方可见，替代原先对两个 hook 的双写；
 * - 会话无活跃绑定时静默丢弃：副本纯投影，WS 重连后服务端会重发快照全量恢复。
 */
export function applyDocHubUpdate(rcsSessionId: string, docName: string, update: Uint8Array): void {
  const entry = hubEntries.get(rcsSessionId);
  if (!entry) return;
  if (docName.startsWith("chat:")) {
    applyRemoteDocUpdate(entry.chatDoc, update);
  } else if (docName.startsWith("session:")) {
    applyRemoteDocUpdate(entry.sessionDoc, update);
  }
  // 其他前缀：与既有 hook 路由行为一致（未知 doc 名不落地），忽略
}
