/**
 * 侧边栏 agent item 布局守卫（源码字符串断言，与 `agent-sidebar-instance-order.test.ts` 同口径）。
 *
 * 锁的是 72b6506e 那次改造的两个承重点，它们是「样式跨文件分工」而不是可推导的运行时行为：
 * - 卡片是**一行左右布局**，高度只能用工具类 `min-h-10`；
 * - `agent-panel.css` **未分层**，它的 `.agent-sidebar-agent-card` 规则优先级高过 `@layer utilities`，
 *   一旦再写 `min-height`（54px 那条已删除）就会静默压过工具类，且没有任何运行时报错。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const treeSource = readFileSync(resolve(import.meta.dir, "../shell/AgentSidebarTree.tsx"), "utf8");
const panelCss = readFileSync(resolve(import.meta.dir, "../shell/agent-panel.css"), "utf8");

describe("侧边栏 agent 卡片布局", () => {
  test("卡片保持一行左右布局且高度用 min-h-10 工具类", () => {
    // 只取卡片那一条 className 字面量：同文件其他类名调整不应让本守卫失效。
    const cardClass = treeSource.match(/"agent-sidebar-agent-card[^"]*"/)?.[0] ?? "";

    expect(cardClass).toContain("flex items-center justify-between");
    expect(cardClass).toContain("min-h-10");
    // 两行堆叠布局的判据：列向 flex 会把「左名称 / 右副信息」改成上下结构。
    expect(cardClass).not.toContain("flex-col");
  });

  test("agent-panel.css 不得再为卡片写 min-height", () => {
    // 必须精确命中基础规则块；命中不到就说明规则被改名/删除，守卫应失败而不是空断言通过。
    const cardStyles = panelCss.match(/\.agent-sidebar-agent-card \{([^}]*)\}/)?.[1];

    expect(cardStyles).toBeDefined();
    expect(cardStyles).not.toContain("min-height");
    expect(cardStyles).not.toContain("height:");
  });

  test("副信息在卡片内、悬浮操作栏之前，并在操作栏出现时让位", () => {
    const cardIndex = treeSource.indexOf('"agent-sidebar-agent-card');
    const metaIndex = treeSource.indexOf("text-text-muted group-hover:invisible");
    // 带 `className=` 前缀：注释里提到「悬浮操作栏」的地方不应被当成渲染点。
    const actionsIndex = treeSource.indexOf('className="agent-sidebar-actions');

    expect(cardIndex).toBeGreaterThan(0);
    // 副信息是卡片内的同一行右端（`justify-between` 的第二个 flex 项目），操作栏是它的兄弟节点之后。
    expect(metaIndex).toBeGreaterThan(cardIndex);
    expect(actionsIndex).toBeGreaterThan(metaIndex);
  });
});
