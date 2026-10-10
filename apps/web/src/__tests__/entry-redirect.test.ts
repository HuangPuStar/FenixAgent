// 控制台入口的重定向回归（AOS-BUG-004）。
//
// 现场：登录成功后 URL 在 `/ctrl/agent` 与 `/ctrl/agent/home` 之间以毫秒级节奏互跳，页面一直停在加载态。
// 成因是入口路由 `/` 把跳转放在**组件里的 `useEffect(navigate)`**：入口匹配在 `/agent` 完成重定向前
// 仍是已提交的匹配，过渡中的重新挂载会把导航 effect 再跑一遍，而 `/agent` 又被自己的 `beforeLoad`
// 换成 `/agent/home`——每次导航都顶掉上一次尚未提交的 load，循环停不下来。
//
// 本文件钉住两条不变量（§2.3「路由壳内的重定向一律用 `beforeLoad` + `throw redirect`」）：
//   ① 入口与面板索引的重定向发生在 **load 阶段**，且链条在 3 跳内落到 `/agent/home` 后不再产生重定向；
//   ② 除根布局的会话守卫外，`routes/**` 下的壳不得自己导航——组件级导航正是 ① 的病根。
//
// 重定向在 load 阶段只表达为 `router.state.redirect`（服务端语义，不自动跟随），因此用例用内存 history
// 逐跳喂回 Location 来复现浏览器行为；建路由的方式与 `shell-navigation-routes.test.ts` 一致。

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "../routeTree.gen";

const BASE_PATH = "/ctrl";
/** 收敛上限：入口 → 面板索引 → 首页共 2 跳，留 1 跳容差；超出即视为互跳。 */
const MAX_HOPS = 3;

/** 在内存 history 上加载某个入口路径，返回该次 load 产生的重定向目标（无重定向时为 null）。 */
async function loadOnce(entry: string) {
  const router = createRouter({
    routeTree,
    basepath: BASE_PATH,
    history: createMemoryHistory({ initialEntries: [entry] }),
    // 用例进程没有 document，显式按服务端语义跑：重定向不自动跟随，一次 load 恰好暴露一跳。
    isServer: true,
  });
  await router.load();
  return {
    redirect: router.state.redirect?.headers.get("Location") ?? null,
    pathname: router.state.location.pathname,
    routeIds: router.state.matches.map((match) => match.routeId),
  };
}

/** 从入口出发逐跳跟随重定向，回到重复路径（互跳）或超过上限即失败。 */
async function followRedirects(entry: string) {
  const visited = [entry];
  let current = entry;
  for (let hop = 0; hop < MAX_HOPS; hop++) {
    const step = await loadOnce(current);
    if (!step.redirect) return step;
    if (visited.includes(step.redirect)) throw new Error(`重定向回到已访问路径：${step.redirect}（互跳）`);
    visited.push(step.redirect);
    current = step.redirect;
  }
  throw new Error(`重定向未在 ${MAX_HOPS} 跳内收敛：${visited.join(" → ")}`);
}

describe("控制台入口重定向", () => {
  // 业务意图：登录后落到的入口页必须在 load 阶段就交棒给控制台，不能等组件挂载后再跳（后者会与
  // `/agent` 自己的重定向互相顶掉，形成报告里的死循环）。
  test("入口页在 load 阶段重定向，3 跳内收敛到控制台首页", async () => {
    const final = await followRedirects(`${BASE_PATH}/`);

    expect(final.pathname).toBe("/agent/home");
    expect(final.routeIds.at(-1)).toBe("/agent/_panel/home");
  });

  // 业务意图：刷新首页的直达路径（报告验收里的「直接访问 /ctrl/agent」）同样一步到位，不来回弹。
  test("直接访问 /ctrl/agent 一步落到首页", async () => {
    const first = await loadOnce(`${BASE_PATH}/agent`);

    expect(first.redirect).toBe(`${BASE_PATH}/agent/home`);
  });

  // 业务意图：收敛点自身不得再产生重定向——它是循环的出口，这里一旦反弹回 /agent 就是死循环复发。
  test("首页不再产生重定向", async () => {
    const home = await loadOnce(`${BASE_PATH}/agent/home`);

    expect(home.redirect).toBeNull();
    expect(home.routeIds.at(-1)).toBe("/agent/_panel/home");
  });
});

describe("路由壳的导航写入点", () => {
  // 根布局的会话守卫是唯一例外：它由**运行时状态**（better-auth 会话解析结果）驱动，判据不在路由
  // 上下文里，放不进 `beforeLoad`，因此必须留在组件副作用中（决策表见 `shell/session-guard.ts`）。
  const NAVIGATION_EXEMPT = new Set(["__root.tsx"]);

  const routeShells = (function collect(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return collect(path);
      return path.endsWith(".tsx") ? [path] : [];
    });
  })(join(import.meta.dirname, "..", "routes"));

  // 剥注释：`routes/index.tsx` 的说明文字里就写着被禁的写法，直接匹配会误报。
  const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  // 业务意图：组件里的导航就是 AOS-BUG-004 的病根（每次提交都可能再跳一次，停不下来）；壳里的跳转
  // 一律走 `beforeLoad`，只有根布局的会话守卫例外。放宽这条必须先想清楚循环从哪来。
  test("除根布局会话守卫外，路由壳不自己导航", () => {
    const offenders = routeShells
      .filter((path) => !NAVIGATION_EXEMPT.has(path.split("/").at(-1) ?? ""))
      .filter((path) => /useNavigate|navigate\s*\(/.test(stripComments(readFileSync(path, "utf8"))))
      .map((path) => path.slice(path.indexOf("/routes/") + 1));

    expect(offenders).toEqual([]);
  });

  // 业务意图：上面那条扫描不能空转——入口路由必须真的用 `beforeLoad` + `throw redirect` 表达跳转，
  // 否则「没有组件级导航」可以靠什么都不做来满足。
  test("入口路由用 beforeLoad 重定向", () => {
    const source = stripComments(readFileSync(join(import.meta.dirname, "..", "routes", "index.tsx"), "utf8"));

    expect(source).toContain("beforeLoad");
    expect(source).toContain("throw redirect");
  });
});
