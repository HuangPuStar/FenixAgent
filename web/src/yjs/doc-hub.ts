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
  /** 活跃绑定数（每个 hook 的每个 store 各持 1）；归零即销毁并移除 entry */
  refs: number;
}

/** 会话 → doc 副本注册表（模块级单例：页面内同一会话全局唯一） */
const hubEntries = new Map<string, DocHubEntry>();

function acquireEntry(rcsSessionId: string): DocHubEntry {
  let entry = hubEntries.get(rcsSessionId);
  if (!entry) {
    entry = { chatDoc: new Y.Doc(), sessionDoc: new Y.Doc(), refs: 0 };
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
  if (entry.refs > 0) return;
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
