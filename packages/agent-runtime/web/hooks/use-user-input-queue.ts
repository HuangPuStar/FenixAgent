// web/hooks/use-user-input-queue.ts
// 从 Session Doc 单独订阅待发送队列投影（root.userInputQueue，peri steer 的入队交互）。
//
// 为什么单独一个 hook（与 `use-task-views.ts` 同款理由）：只绑定 Session Doc，Chat Doc 的流式更新
// （token 流、消息时间线）不触发本 selector 重算——队列区的渲染成本与消息流解耦；Chat Doc 变化
// 也不得让「待发送」列表重派生。
//
// 为什么在本包读 Y.Doc：`@fenix/chat-channel` 的浏览器安全入口没有现成的响应式 selector，
// 读取形状统一走它的 `readUserInputQueue`（合同 owner 实现，含 enabled 对 `agent.capabilities` 的兜底），
// 本文件只负责订阅时机与展示形状收窄，不重复实现读取。
//
// 派生规则（前端只读，不产生本地队列状态）：
// - `delivered` 从队列区消失（用户气泡由服务端写 Chat Doc）；`withdrawn` 立即移除；
// - `queued` / `dispatching` / `claimed` 保留（后两者在 UI 上显示为发送中且不可重复操作）；
// - 未知 state 由读取侧收敛为 `unknown`（可见但不可操作），不因脏数据让整块区域消失；
// - 引用稳定性：子树未变时复用上次投影（=== 稳定），配合 useSyncExternalStore 避免无谓重渲染。
//
// 缓存挂在 Y.Doc 实例上（WeakMap，纯投影、可从后端 doc 全量重建），dirty 由 observeDeep 标记：
// 只有 userInputQueue 子树的事件会置脏。

import { createYjsStore, readUserInputQueue, type YjsStore } from "@fenix/chat-channel";
import type {
  UserInputQueueItemState,
  UserInputQueueItemView,
  UserInputQueueView,
} from "@fenix/ui-components/chat/shell/chat-interface-types";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import * as Y from "yjs";
import { createSessionDocBinding, getDocHubReplacementVersion, subscribeDocHubReplacement } from "../yjs/doc-hub";

/** 队列区不展示的终态：delivered 已落到 Chat Doc 时间线，withdrawn 已由用户取回。 */
const HIDDEN_ITEM_STATES: ReadonlySet<UserInputQueueItemState> = new Set(["delivered", "withdrawn"]);

/** 共享空数组常量：无待发送项时返回稳定引用（不产生新的 [] 实例）。 */
const EMPTY_ITEMS: readonly UserInputQueueItemView[] = [];

/** 能力位与 enabled 都为假时的默认快照：队列未启用（含 Session Doc 尚未同步）。 */
const DISABLED_QUEUE: UserInputQueueView = {
  enabled: false,
  generation: null,
  revision: 0,
  activeRequestId: null,
  items: EMPTY_ITEMS,
};

/** 派生缓存（WeakMap 按 Y.Doc 键，纯投影、可从后端 doc 全量重建）。 */
interface UserInputQueueCache {
  view: UserInputQueueView | null;
  dirty: boolean;
}

const queueCaches = new WeakMap<Y.Doc, UserInputQueueCache>();

/**
 * 把读取侧的投影收窄为展示形状：剔除终态项、把空 `originalDraft` 归一为缺省
 * （入队请求的可选字段语义是「没有草稿」而不是「空草稿」，取回时据此回退到 content）。
 */
function toViewState(ydoc: Y.Doc): UserInputQueueView {
  const projection = readUserInputQueue(ydoc);
  const items: UserInputQueueItemView[] = [];
  for (const item of projection.items) {
    if (HIDDEN_ITEM_STATES.has(item.state)) continue;
    items.push({
      inputId: item.inputId,
      content: item.content,
      originalDraft: item.originalDraft.length > 0 ? item.originalDraft : undefined,
      state: item.state,
    });
  }
  return {
    enabled: projection.enabled,
    generation: projection.generation,
    revision: projection.revision,
    activeRequestId: projection.activeRequestId,
    items: items.length > 0 ? items : EMPTY_ITEMS,
  };
}

/** 单个 observeDeep 事件 → dirty 标记（path 相对 Session Doc root） */
function markQueueEvent(cache: UserInputQueueCache, event: Y.YEvent<Y.AbstractType<unknown>>): void {
  const path = event.path;
  if (path.length === 0) {
    if (event.keys.has("userInputQueue")) cache.dirty = true;
    return;
  }
  if (path[0] === "userInputQueue") cache.dirty = true;
}

function getQueueCache(ydoc: Y.Doc): UserInputQueueCache {
  const existing = queueCaches.get(ydoc);
  if (existing) return existing;
  const cache: UserInputQueueCache = { view: null, dirty: true };
  // 首次派生必然全量：把观察者挂载前已存在的内容全部纳入基线
  ydoc.getMap("root").observeDeep((events) => {
    for (const event of events) markQueueEvent(cache, event);
  });
  queueCaches.set(ydoc, cache);
  return cache;
}

/**
 * 从 Session Doc 派生待发送队列（纯函数，无副作用）。导出仅供测试。
 * 只订阅 userInputQueue 子树：其余 Session Doc 子树（session/agent/pendingPermissions/…）的变化
 * 不触发重派生。
 */
export function computeUserInputQueue(ydoc: Y.Doc): UserInputQueueView {
  const root = ydoc.getMap("root");
  // Session Doc 尚未同步（快照未到达）时子树缺失：直接给稳定的未启用快照，不进缓存
  // （结构补建时 observeDeep 会把 cache 置脏，下一次读取自然走到派生分支）
  const queue = root.get("userInputQueue");
  if (!(queue instanceof Y.Map)) return DISABLED_QUEUE;

  const cache = getQueueCache(ydoc);
  if (!cache.dirty && cache.view !== null) return cache.view;
  cache.view = toViewState(ydoc);
  cache.dirty = false;
  return cache.view;
}

/**
 * 订阅指定 RCS 会话的待发送队列（只绑定 Session Doc）。
 * 内部 store 绑定 DocHub 的共享 doc 实例（ownsDoc=false），WS update 由 ChatPanel 经
 * applyDocHubUpdate 单写，本 hook 只读派生。
 */
export function useUserInputQueue(rcsSessionId: string) {
  const storeRef = useRef<YjsStore<UserInputQueueView> | null>(null);
  if (!storeRef.current) {
    storeRef.current = createYjsStore<UserInputQueueView>(computeUserInputQueue, DISABLED_QUEUE);
  }
  const store = storeRef.current;

  // 绑定工厂：从 DocHub 取共享 Session Doc（ownsDoc=false，生命周期归 hub 引用计数）；
  // useCallback 保持引用稳定，渲染期与 effect 期复用同一工厂
  const bindSessionDoc = useCallback(() => createSessionDocBinding(rcsSessionId), [rcsSessionId]);
  const subscribeReplacement = useCallback(
    (listener: () => void) => subscribeDocHubReplacement(rcsSessionId, listener),
    [rcsSessionId],
  );
  const getReplacementVersion = useCallback(() => getDocHubReplacementVersion(rcsSessionId), [rcsSessionId]);
  const replacementVersion = useSyncExternalStore(subscribeReplacement, getReplacementVersion, getReplacementVersion);

  // 重订阅驱动（bind epoch）：destroy 会清空 store listeners（store 契约），
  // 而 useSyncExternalStore 只在 subscribe 引用变化时重订阅——cleanup destroy
  // 后必须重建订阅，否则切换会话 / StrictMode 双挂载后后续 update 不再触发
  // 渲染（快照永久 stale，SP-B1 回归测试捕获的真实缺陷）。
  const [bindEpoch, setBindEpoch] = useState(0);
  // bindEpoch 不在回调体内使用，作为 subscribe 引用变化的驱动依赖（见上注释）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: bindEpoch 是刻意的重订阅驱动（移除会退回 SP-B1 的快照永久 stale 缺陷），而 store 由 ref 持有、store.subscribe 恒稳定，无需入列；同 `packages/resources/task/web/hooks/use-task-views.ts` 的同一模式。
  const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [bindEpoch]);

  const snapshot = useSyncExternalStore(subscribe, store.getSnapshot);

  useEffect(() => {
    // doc 绑定只在 effect 期执行（不在渲染期 switchDoc）：渲染期 switchDoc 的
    // notify() 会在渲染进行中触发已订阅组件的 setState（React 报错），且本组件
    // 的 listeners 已被 cleanup destroy 清空，必须经 bindEpoch 重订阅兜底。
    // 会话换代（replaceDocHubUpdate 换掉 doc 实例）由 bindingKey 里的 replacementVersion 驱动重绑。
    const bindingKey = `${rcsSessionId}:${replacementVersion}`;
    store.switchDoc(bindingKey, bindSessionDoc);
    setBindEpoch((e) => e + 1);
    return () => {
      store.destroy();
    };
  }, [store, rcsSessionId, bindSessionDoc, replacementVersion]);

  return { state: snapshot };
}
