/**
 * channel-list-state.ts — 通道绑定列表「该渲染哪个分支」的纯判定（无 React / 无 DOM 依赖）。
 *
 * 为什么单独成模块：任务 1.3 §1.3(6) 要求「请求失败必须有**持久**错误分支，不得退化成（暂无绑定的）空态」。
 * 而 `useRequest` 的 `error` 在三种场景下含义不同——首次加载失败、已有数据后刷新失败、鉴权失败——
 * 三者的渲染分支互斥且顺序敏感，把它写成渲染函数里的 if 链就只能靠读 JSX 才能验证。
 * 抽成纯函数后，优先级规则可以脱离 DOM 直接断言：被测对象是「状态 + 数据流」而不是 UI 结构，
 * 渲染断言会把测试钉在 JSX 形状上，还要额外付一次 DOM 引导的成本。
 *
 * 优先级（从高到低）：
 *   1. `loading`：加载中优先，否则刷新期间会先闪一次上一轮的旧错误；
 *   2. 无数据时的失败：401（未认证）与 403（无权限）被 request 层归一为 `UNAUTHORIZED`，
 *      因此只判定一次 → `unauthorized`；其余失败 → `error`。两者都必须走持久分支；
 *   3. `ready`：含「已有数据后某次刷新失败」——保留已渲染的列表，不因一次刷新失败清空数据
 *      （判据与 model-management 的 `error && !data`、skill 的 `error && skills.length === 0` 一致）。
 */

import { ApiError } from "@fenix/web-runtime/api/request";

/** 列表的渲染分支。`unauthorized` 与 `error` 都是持久错误态，但前者不提供无意义的重试入口。 */
export type ChannelListState = "loading" | "unauthorized" | "error" | "ready";

/**
 * 判定列表当前应渲染的分支。
 *
 * `itemCount` 是已经拿到的绑定条数：ahooks 在刷新失败时保留上一轮 `data`，因此它非 0 即说明界面已有内容，
 * 此时不能让错误态顶掉列表。
 */
export function resolveChannelListState(input: {
  loading: boolean;
  error: unknown;
  itemCount: number;
}): ChannelListState {
  if (input.loading) return "loading";
  if (input.error && input.itemCount === 0) {
    return input.error instanceof ApiError && input.error.code === "UNAUTHORIZED" ? "unauthorized" : "error";
  }
  return "ready";
}
