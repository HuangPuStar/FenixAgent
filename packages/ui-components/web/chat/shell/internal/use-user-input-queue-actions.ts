/**
 * 待发送队列（peri steer）的动作编排：把队列区的三个操作收敛到控制面端口，并把失败变成可重试的提示。
 *
 * 为什么单独一个内部 hook：`ChatInterface` 已接近单文件 500 行红线，而这段逻辑与渲染无关
 * （能力位/开关判定、提交分流谓词、失败态与重试闭包、取回回填），抽出来才能同时守住红线与
 * 「队列只有 Session Doc 一份事实源」这条约束。
 *
 * 队列状态一律来自 `queue` 投影（Y.Doc），本 hook 不持有任何条目副本：三个操作只发出控制面
 * action，界面等 Y.Doc 回推后自然收敛（与用户消息由服务端写 Chat Doc 同一口径）。本地 state 只有
 * 一个**瞬时**失败条目——它不是队列状态，不参与渲染条目，仅承载「这次操作没送达 + 重试入口」。
 */

import { useCallback, useState } from "react";
import type { ContentBlock } from "../../types";
import type { UserInputQueueEnqueueRequest, UserInputQueueItemView, UserInputQueueView } from "../chat-interface-types";

/** 动作未送达时的可重试提示（`retry` 重放同一动作）。 */
export interface UserInputQueueFailure {
  message: string;
  retry: () => void;
}

/** 未送达的动作（按描述重放，避免在 useCallback 里写自引用闭包）。 */
type FailedAction =
  | { kind: "enqueue"; content: ContentBlock[]; originalDraft: string }
  | { kind: "dispatch"; inputIds: string[] }
  | { kind: "takeback"; inputId: string };

/** useUserInputQueueActions 选项。 */
export interface UserInputQueueActionsOptions {
  /** 能力位 `capabilities['peri.userInputQueue']`（宿主从 Session Doc agent.capabilities 派生） */
  supportsUserInputQueue?: boolean;
  /** Session Doc `userInputQueue` 投影；未注入时视为未启用 */
  queue?: UserInputQueueView | null;
  onEnqueueUserInput?: (request: UserInputQueueEnqueueRequest) => boolean;
  onDispatchUserInputs?: (inputIds: string[]) => boolean;
  onTakebackUserInput?: (inputId: string) => boolean;
  /**
   * 取回成功后把草稿交回输入岛。是否覆盖由输入岛判定：草稿非空时不覆盖
   * （`ChatComposer` 的 `restore-draft` 事件语义，见 `../composer/composer-effects`）。
   */
  restoreDraft: (text: string) => void;
  /** 动作未送达的提示文案（由组件翻译后传入，本 hook 不依赖 i18n） */
  actionFailedMessage: string;
}

/** useUserInputQueueActions 返回值。 */
export interface UserInputQueueActions {
  /** 入队交互是否启用（能力位、队列 `enabled` 与入队端口同时为真） */
  enabled: boolean;
  /** 待展示项（已剔除 delivered / withdrawn） */
  items: readonly UserInputQueueItemView[];
  /** 队列非空：与 loading 一起决定下次提交是入队还是直发 */
  hasItems: boolean;
  /** 可「单发/取回」的项（state=queued 且端口在位） */
  canOperateItems: boolean;
  /** 可「全部发送」的项 id（state=queued） */
  queuedIds: readonly string[];
  canDispatch: boolean;
  canTakeback: boolean;
  failure: UserInputQueueFailure | null;
  dismissFailure: () => void;
  /**
   * 入队：`content` 为本次提交归一化后的内容块，`originalDraft` 为用户原始草稿正文。
   * 返回是否发出（false 已写好失败提示）。签名与提交链路的 `onEnqueuePrompt` 逐字一致。
   */
  enqueue: (content: ContentBlock[], originalDraft: string) => boolean;
  /** 单发/全发：`inputIds` 为一项即单发，为全部 queued 即全发 */
  dispatch: (inputIds: string[]) => void;
  /** 取回：发出 takeback 并在成功后把草稿交回输入岛 */
  takeback: (inputId: string) => void;
}

const EMPTY_ITEMS: readonly UserInputQueueItemView[] = [];
const EMPTY_IDS: readonly string[] = [];

/** 取回回填文本：优先用户原始草稿，缺失或空串时回退队列项的可展示文本。 */
export function resolveTakebackDraft(item: UserInputQueueItemView): string {
  const draft = item.originalDraft;
  return draft && draft.length > 0 ? draft : item.content;
}

/**
 * 组装入队请求：空草稿归一为缺省。
 *
 * 「没有草稿」（纯图片/附件提交）与「空白草稿」对取回是同一件事——回填时都该退回可展示文本，
 * 因此不把空串写进请求（`UserInputQueueEnqueueRequest.originalDraft` 的可选语义即此）。
 */
function toEnqueueRequest(content: ContentBlock[], originalDraft: string): UserInputQueueEnqueueRequest {
  return { content, originalDraft: originalDraft.length > 0 ? originalDraft : undefined };
}

/**
 * 编排待发送队列的三个操作。端口缺席时对应按钮不出现（`canDispatch` / `canTakeback`），
 * 不给用户一个点了没反应的按钮。
 */
export function useUserInputQueueActions({
  supportsUserInputQueue,
  queue,
  onEnqueueUserInput,
  onDispatchUserInputs,
  onTakebackUserInput,
  restoreDraft,
  actionFailedMessage,
}: UserInputQueueActionsOptions): UserInputQueueActions {
  // 能力位、队列开关与入队端口三者同时为真才启用：任一为假时提交/渲染完全回退旧行为
  // （直发 send_prompt）。把端口也算进来是防线——缺端口而仍把提交改道入队，用户的提交会被静默丢弃。
  const enabled = Boolean(supportsUserInputQueue) && queue?.enabled === true && Boolean(onEnqueueUserInput);
  const items = enabled ? (queue?.items ?? EMPTY_ITEMS) : EMPTY_ITEMS;
  const canDispatch = enabled && Boolean(onDispatchUserInputs);
  const canTakeback = enabled && Boolean(onTakebackUserInput);
  const queuedIds: readonly string[] = enabled
    ? items.filter((item) => item.state === "queued").map((item) => item.inputId)
    : EMPTY_IDS;

  /** 未送达的动作（重试入口按它重放，不靠递归闭包） */
  const [failedAction, setFailedAction] = useState<FailedAction | null>(null);

  const dismissFailure = useCallback(() => setFailedAction(null), []);

  const run = useCallback(
    (action: FailedAction): boolean => {
      switch (action.kind) {
        case "enqueue":
          return onEnqueueUserInput?.(toEnqueueRequest(action.content, action.originalDraft)) ?? false;
        case "dispatch":
          return onDispatchUserInputs?.(action.inputIds) ?? false;
        case "takeback":
          return onTakebackUserInput?.(action.inputId) ?? false;
      }
    },
    [onEnqueueUserInput, onDispatchUserInputs, onTakebackUserInput],
  );

  /**
   * 统一出口：端口返回 false（未写入 socket）时留下可重试提示。
   *
   * 这里不自动重试也不吞掉失败——发送失败意味着这次操作对服务端**完全没发生**，
   * 静默丢弃会让用户以为草稿已入队。
   */
  const execute = useCallback(
    (action: FailedAction): boolean => {
      if (run(action)) {
        setFailedAction(null);
        return true;
      }
      setFailedAction(action);
      return false;
    },
    [run],
  );

  const enqueue = useCallback(
    (content: ContentBlock[], originalDraft: string) => execute({ kind: "enqueue", content, originalDraft }),
    [execute],
  );

  const dispatch = useCallback(
    (inputIds: string[]) => {
      if (inputIds.length === 0) return;
      execute({ kind: "dispatch", inputIds });
    },
    [execute],
  );

  const takeback = useCallback(
    (inputId: string) => {
      const item = items.find((candidate) => candidate.inputId === inputId);
      const delivered = execute({ kind: "takeback", inputId });
      // 只有真正发出取回才回填：未送达时该项仍在队列里，回填会让同一条草稿出现两份
      if (delivered && item) restoreDraft(resolveTakebackDraft(item));
    },
    [execute, items, restoreDraft],
  );

  // 重试重放同一动作（走公开出口，因此取回的重试同样会回填草稿）
  const retryFailedAction = useCallback(() => {
    if (!failedAction) return;
    if (failedAction.kind === "enqueue") enqueue(failedAction.content, failedAction.originalDraft);
    else if (failedAction.kind === "dispatch") dispatch(failedAction.inputIds);
    else takeback(failedAction.inputId);
  }, [failedAction, enqueue, dispatch, takeback]);

  const failure: UserInputQueueFailure | null = failedAction
    ? { message: actionFailedMessage, retry: retryFailedAction }
    : null;

  return {
    enabled,
    items,
    hasItems: items.length > 0,
    canOperateItems: canDispatch || canTakeback,
    queuedIds,
    canDispatch,
    canTakeback,
    failure,
    dismissFailure,
    enqueue,
    dispatch,
    takeback,
  };
}
