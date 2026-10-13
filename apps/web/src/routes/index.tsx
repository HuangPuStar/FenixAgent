import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * 根入口（`/ctrl`）→ 控制台入口 `/agent`。
 *
 * 必须走 `beforeLoad`，不能放组件里的 `useEffect(navigate)`（§2.3「路由壳内的重定向一律用
 * `beforeLoad` + `throw redirect`」）：入口路由在 `/agent` 重定向前仍是**已提交**的匹配，过渡中的
 * 重新挂载会把导航 effect 再跑一遍；而 `/agent` 又被自己的 beforeLoad 换成 `/agent/home`，于是
 * URL 在 `/ctrl/agent ↔ /ctrl/agent/home` 之间以毫秒级节奏互跳——每次导航都顶掉上一次尚未提交的
 * load，循环自己停不下来。`beforeLoad` 每次 load 只执行一次、不随 React 提交重跑，因此没有这条
 * 反馈回路；`replace` 保证 `/ctrl` 不留在历史栈里（router 的 load 也会按 `replace` 提交重定向）。
 */
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/agent", replace: true });
  },
});
