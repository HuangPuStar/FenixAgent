/**
 * model-gateway-query.ts — 「手动查询」结果的渲染分支判定（纯函数，无 React / 无 DOM）。
 *
 * 为什么单独成模块：管理页的用量与预算两个 Tab 都是「点查询才发请求」的形态，三个状态
 * （进行中 / 失败 / 还没查过）互斥且顺序敏感。判定散在渲染函数里就只能靠读 JSX 验证，而漏掉的那一支
 * 恰恰是 §3.4 点名的静默缺陷：失败的请求会让 `data` 停在 `undefined`，于是界面显示「请先查询」或一张
 * 空表——用户把「请求挂了」读成「我还没点过查询」「这个区间确实没有用量」。
 * 抽成纯函数后，规则可以脱离 DOM 直接断言（与 `resource-channel` 的列表状态判定同款）。
 *
 * 优先级（从高到低）：
 *   1. `loading`：进行中优先，否则重查期间会先闪一次上一轮的失败态；
 *   2. `failure`：失败即失败态 + 重试；
 *   3. `idle`：确实没查过（没有数据也没有错误）；
 *   4. `ready`：有数据可渲染。
 *
 * 这里**不**沿用列表的「已有数据就保留旧数据、只弹提示」口径（见 `channel-list-state.ts`）：这两个 Tab 的
 * 按钮语义是「查这个区间 / 这组筛选」，ahooks 在失败时保留上一轮 `data`，若照旧渲染，用户会把上一轮的
 * 指标与预算行当成这次查询的结果——静默错误比列表场景更严重。失败时用失败块顶掉旧结果，重试按钮即
 * 「按当前筛选重查一次」。
 */
export type ModelGatewayQueryBranch = "loading" | "failure" | "idle" | "ready";

/** 判定本次查询该渲染哪个分支。`error` 只在 ahooks 的失败态非空时传入。 */
export function resolveModelGatewayQueryBranch(input: {
  loading: boolean;
  error: unknown;
  hasData: boolean;
}): ModelGatewayQueryBranch {
  if (input.loading) return "loading";
  if (input.error) return "failure";
  if (!input.hasData) return "idle";
  return "ready";
}
