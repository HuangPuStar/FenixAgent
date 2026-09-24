// web/hooks/use-chat-state.ts
// 订阅两份 Y.Doc 派生 ChatStateSnapshot（展示形状保持，数据来源切到新 schema）。
//
// 本文件只剩**订阅编排**：双 store（Chat Doc / Session Doc）+ DocHub 绑定 + 外部 store 订阅；
// 纯派生（token 用量、会话元信息、子树级缓存）已按 §4.7 拆到 `./chat-state-derivation`
// （零 React 依赖，可独立构造 Y.Doc 测试）。本文件原样再导出
// `computeTokenSnapshot` / `computeMetaSnapshot`，`src/index.ts` 的 `export *` 与既有测试
// 都按原路径引用，出口形状不变。
//
// Y.Doc 副本合一（SP-B1 / 根因 B1）：两份 doc 从 DocHub 取共享实例（引用计数），
// 本 hook 只读派生，WS update 由 ChatPanel 经 hub 单写（不再自带 applyUpdate）。

import { createYjsStore, type YjsStore } from "@fenix/chat-channel";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  createChatDocBinding,
  createSessionDocBinding,
  getDocHubReplacementVersion,
  subscribeDocHubReplacement,
} from "../yjs/doc-hub";
import {
  type ChatMetaSnapshot,
  type ChatTokenSnapshot,
  computeChatSnapshot,
  computeMetaSnapshot,
  computeTokenSnapshot,
} from "./chat-state-derivation";

export { computeMetaSnapshot, computeTokenSnapshot } from "./chat-state-derivation";

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
  // bindEpoch 不在回调体内使用，作为 subscribe 引用变化的驱动依赖（见上注释）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: bindEpoch 是刻意的引用驱动依赖，不是遗漏——见上「重订阅驱动」注释与 SP-B1 回归用例；按建议改列 stores.chat.subscribe 会让每次渲染都重订阅。
  const subscribeChat = useCallback((cb: () => void) => stores.chat.subscribe(cb), [bindEpoch]);
  // 同上，bindEpoch 仅驱动引用变化。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 同 subscribeChat，两行同一模式。
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
