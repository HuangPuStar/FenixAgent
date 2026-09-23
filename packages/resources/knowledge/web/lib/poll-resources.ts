/**
 * 资源列表轮询：上传 / 重新解析后每 2s 刷新一次资源，直到解析结束或到达次数上限。
 *
 * 为什么抽成模块：`AgentKnowledgeBasesPage` 里「上传后等解析完成」与「重新解析后等这次解析完成」两段
 * 轮询此前各写一份，`ticks += 1` / 拉列表 / `Array.isArray` 兜底 / `setResources` 四行逐字相同，
 * `clearInterval` 清理也是两份，且两处的间隔（2s）与次数上限（150 次）本就该是同一个契约
 * （2026-09-22 前端去重）。两段剩余的差异只在**领域判据**：前者看「是否还有文档在解析」，
 * 后者看「本次重新解析的那个资源是否落定」——正是调用方该传的东西。
 *
 * 抽取时刻意逐字保留原语义：
 * - 到达上限的判定仍是**自增之后** `ticks > MAX`（即最坏 151 次、约 5 分钟），与原实现的 `ticks > 150` 等价；
 * - 拉取抛错时只停止轮询，不吞掉调用方的收尾动作（`onError` 可选）；
 * - `Array.isArray` 兜底命中时**不停止**轮询，只是跳过本次（后端返回非数组属异常，不值得立刻放弃）；
 * - 到点后先 `clearInterval` 再回调，回调里再次触发停止（如刷新详情）不会重复清理。
 *
 * 停止是幂等的：句柄被调用两次、或卸载清理与到点回调同时发生，都只停止一次。
 */

import type { KnowledgeResourceInfo } from "../types/knowledge";

/** 轮询间隔（毫秒）。 */
export const RESOURCE_POLL_INTERVAL_MS = 2000;

/**
 * 次数上限：`RESOURCE_POLL_INTERVAL_MS × 150 ≈ 5 分钟`。
 *
 * 判定位置在自增之后（`ticks > RESOURCE_POLL_MAX_TICKS`），因此实际最多轮询 151 次，
 * 与原实现一致；不改成 `>=` 以免悄悄缩短超时窗口。
 */
export const RESOURCE_POLL_MAX_TICKS = 150;

export interface ResourcePollOptions {
  /** 拉取一次资源列表（调用方绑定 kbId 与请求层）。 */
  fetchResources: () => Promise<KnowledgeResourceInfo[]>;
  /** 每次成功拉到数组后把结果交给调用方（刷新其持有的列表）。 */
  onResources: (resources: KnowledgeResourceInfo[]) => void;
  /** 领域停止条件：拿到本次列表后判断是否已经落定。返回 `true` 即结束轮询。 */
  isSettled: (resources: KnowledgeResourceInfo[]) => boolean;
  /** 满足停止条件（含到达次数上限）后的收尾；入参是触发停止的那次列表。 */
  onSettled: (resources: KnowledgeResourceInfo[]) => void;
  /** 拉取失败后的收尾（原实现只清定时器与本地状态，故默认不做任何事）。 */
  onError?: () => void;
}

/** 轮询句柄：调用即停止，可重复调用。 */
export type ResourcePollStop = () => void;

/** 启动轮询并返回停止句柄。 */
export function startResourcePolling(options: ResourcePollOptions): ResourcePollStop {
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticks = 0;

  const stop: ResourcePollStop = () => {
    if (timer === null) return;
    clearInterval(timer);
    timer = null;
  };

  timer = setInterval(async () => {
    try {
      ticks += 1;
      const resList = await options.fetchResources();
      if (!Array.isArray(resList)) return;
      options.onResources(resList);
      if (options.isSettled(resList) || ticks > RESOURCE_POLL_MAX_TICKS) {
        stop();
        options.onSettled(resList);
      }
    } catch {
      stop();
      options.onError?.();
    }
  }, RESOURCE_POLL_INTERVAL_MS);

  return stop;
}
