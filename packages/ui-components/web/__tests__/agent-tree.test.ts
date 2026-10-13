/**
 * 侧栏智能体树的模型行为与视图布局守卫。
 *
 * 2026-09-28 视图与纯派生从宿主 `apps/web/src/shell/` 迁入本包时并合了两份宿主用例
 * （`agent-sidebar-instance-order.test.ts` 的排序段与 `agent-sidebar-agent-card-layout.test.ts`），
 * 因此这里的断言分三类：
 * - **行为**：`orderInstancesByRunningStatus` / `getRunningInstances` / `getInstanceStatusTone` 的纯函数契约；
 * - **源码字符串**：本组件是给宿主**蓝色侧栏**画的，两处约束无法由运行时断言表达——
 *   卡片必须保持一行左右布局（列向 flex 会把「左名称 / 右副信息」改成上下两行），
 *   以及配色只能走 `white/*` 蒙层（主题令牌是浅色值，蓝底上会渲染成灰字与近白亮块）。
 *   旧实现靠宿主 `agent-panel.css` 里未分层的 `.agent-sidebar-tree .text-text-dim` 一类规则压回白色，
 *   那批规则随视图迁走已删除：令牌再被写回来时没有任何报错，只会「颜色看着不对」，故在此钉住。
 * - **伴随表**：`agent-tree.css` 只留工具类表达不了的部分（伪元素指示条与三处投影）；几何刻度
 *   （内边距 / 外边距 / 卡片盒模型 / 图标 15×15）走 `@theme` 的 px 档令牌落在 `className`，
 *   被搬回伴随表时同样不会报错、只会让同一属性两边各写一份而改一处不生效。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  type AgentTreeInstanceItem,
  getInstanceStatusTone,
  getRunningInstances,
  orderInstancesByRunningStatus,
} from "../agent-tree/agent-tree-model";

const viewSource = readFileSync(resolve(import.meta.dir, "../agent-tree/agent-tree.tsx"), "utf8");

/** 伴随表（`agent-tree.css`）：调色板、选中态修饰类与三处投影的落点。 */
const companionCss = readFileSync(resolve(import.meta.dir, "../agent-tree/agent-tree.css"), "utf8");

/**
 * 去掉注释后的伴随表：文件头的说明会**引用**已撤回的写法（如 `padding: 9px 12px`，用来交代那批判定
 * 为什么被推翻），逐声明扫描必须先把注释剥掉，否则守卫会被自己的说明文字绊倒。
 */
const companionCode = companionCss.replace(/\/\*[\s\S]*?\*\//g, "");

/**
 * 去掉注释后的源码：本组件的注释会**引用**被禁的令牌名（解释「为什么不用 `text-text-dim`」），
 * 逐字符串扫描必须先把注释剥掉，否则守卫会被自己的说明文字绊倒。
 */
const viewCode = viewSource.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

function instance(instanceUid: string, status: string): AgentTreeInstanceItem {
  return { instanceUid, name: instanceUid, status };
}

describe("orderInstancesByRunningStatus", () => {
  // 运行中的绿色实例必须稳定排在非运行实例之前。
  test("绿色实例在前且组内保持原顺序", () => {
    const instances = [
      instance("stopped-a", "stopped"),
      instance("running-a", "running"),
      instance("unknown-a", "unknown"),
      instance("running-b", "running"),
      instance("starting-a", "starting"),
    ];

    expect(orderInstancesByRunningStatus(instances).map((item) => item.instanceUid)).toEqual([
      "running-a",
      "running-b",
      "stopped-a",
      "unknown-a",
      "starting-a",
    ]);
  });

  // 排序不得原地修改 API 返回数组，避免轮询缓存和其他消费者观察到隐式重排。
  test("不修改输入数组", () => {
    const instances = [instance("stopped-a", "stopped"), instance("running-a", "running")];

    orderInstancesByRunningStatus(instances);

    expect(instances.map((item) => item.instanceUid)).toEqual(["stopped-a", "running-a"]);
  });
});

describe("getRunningInstances", () => {
  // 判据与「弹不弹重启窗」同源：starting 与 running 同等对待，stopping / stopped 不是可重启目标。
  test("只挑 running 与 starting", () => {
    const instances = [
      instance("a", "running"),
      instance("b", "starting"),
      instance("c", "stopping"),
      instance("d", "stopped"),
      instance("e", "unknown"),
    ];

    expect(getRunningInstances(instances).map((item) => item.instanceUid)).toEqual(["a", "b"]);
  });

  // 领域侧（@fenix/agent-config）传的是 EnvironmentInstanceInfo，多出的 createdAt 等字段必须原样保留，
  // 否则调用方拿回的结果喂不回 instanceApi.restart 这类领域调用。
  test("保留元素上领域侧多出的字段", () => {
    const enriched = [{ instanceUid: "a", name: "a", status: "running", createdAt: "2026-09-01T00:00:00.000Z" }];

    expect(getRunningInstances(enriched)[0]?.createdAt).toBe("2026-09-01T00:00:00.000Z");
  });
});

describe("getInstanceStatusTone", () => {
  // 起不来（unknown）要报警色，过渡终态（stopping）不报警，避免侧栏整片红点。
  test("运行绿、启动黄、未知红、其余中性", () => {
    expect(getInstanceStatusTone(instance("a", "running"))).toBe("success");
    expect(getInstanceStatusTone(instance("a", "starting"))).toBe("warning");
    expect(getInstanceStatusTone(instance("a", "unknown"))).toBe("danger");
    expect(getInstanceStatusTone(instance("a", "stopping"))).toBe("neutral");
    expect(getInstanceStatusTone(instance("a", "stopped"))).toBe("neutral");
  });
});

describe("AgentTree 视图布局", () => {
  // 卡片是一行左右布局（列向 flex 会把「左名称 / 右副信息」改成上下结构）；高度走刻度类 `min-h-10`
  // ——`--spacing` 已在 `@theme` 按 px 落地，10 档即 40px 设计值，故不落在伴随表里。
  test("卡片保持一行左右布局且高度走刻度类", () => {
    const cardClass = viewSource.match(/"agent-tree-card relative flex items-center justify-between[^"]*"/)?.[0] ?? "";

    expect(cardClass).toContain("flex items-center justify-between");
    expect(cardClass).toContain("min-h-10");
    expect(companionCode).not.toContain("min-height");
    // 判据取整个 className 数组块：只查首行字面量会漏掉后续行里补上的 `flex-col`。
    const classBlock = viewSource.slice(
      viewSource.indexOf('"agent-tree-card relative flex items-center justify-between'),
      viewSource.indexOf(
        '].join(" ")',
        viewSource.indexOf('"agent-tree-card relative flex items-center justify-between'),
      ),
    );
    expect(classBlock).not.toContain("flex-col");
  });

  // 副信息（标识键 / 远程标记）在卡片内、悬浮操作栏之前，并在操作栏出现时让位（`group-hover:invisible`）。
  test("副信息在悬浮操作栏之前且操作栏出现时让位", () => {
    const cardIndex = viewSource.indexOf('"agent-tree-card relative flex items-center justify-between');
    const metaIndex = viewSource.indexOf("group-hover:invisible");
    const actionsIndex = viewSource.indexOf("absolute top-1.5 right-1.5");

    expect(cardIndex).toBeGreaterThan(0);
    expect(metaIndex).toBeGreaterThan(cardIndex);
    expect(actionsIndex).toBeGreaterThan(metaIndex);
  });

  // 蓝色侧栏只认白色蒙层：主题令牌（浅色主题值）写进来会渲染成蓝底灰字，且不会有任何报错。
  test("类名只用白色蒙层，不写主题色令牌", () => {
    const forbiddenTokens = [
      "text-text-dim",
      "text-text-muted",
      "text-text-primary",
      "text-text-secondary",
      "text-text-bright",
      "bg-surface-hover",
      "bg-surface-1",
      "bg-surface-2",
      "bg-brand-subtle",
      "border-border-subtle",
    ];

    expect(forbiddenTokens.filter((token) => viewCode.includes(token))).toEqual([]);
  });

  // `agent-tree.css` 的调色板挂在根容器的 `.agent-tree` 上，卡片里的 `var(--agent-tree-accent*)`
  // 全靠它级联下来；根类名一旦被删，颜色静默回落成无效值（透明描边 / 无指示条），不会报错。
  test("调色板根类与 var() 引用配套", () => {
    expect(viewSource).toContain('className="agent-tree flex-1');
    expect(viewCode).toContain("var(--agent-tree-accent-soft)");
    expect(viewCode).toContain("var(--agent-tree-accent-strong)");
    expect(viewCode).toContain("var(--agent-tree-accent-deep)");
    expect(viewCode).toContain("var(--agent-tree-accent-bright)");

    for (const name of [
      "--agent-tree-accent:",
      "--agent-tree-accent-soft:",
      "--agent-tree-accent-strong:",
      "--agent-tree-accent-deep:",
      "--agent-tree-accent-bright:",
    ]) {
      expect(companionCss).toContain(name);
    }
  });

  // 几何刻度（2026-09-28 复议）：`--spacing`（1 档 = 4px）与 `--radius-*` 已在 `@theme` 按 px 落地，
  // 工具类写的就是设计值，这批取值全部落在 `className`。被搬回伴随表时同样不会报错，只会让同一属性
  // 两边各写一份、改一处不生效；伴随表只留工具类表达不了的部分。
  test("几何刻度落在 className，伴随表不留刻度声明", () => {
    const migratedClasses = [
      "pt-2 pb-3", // 树容器（原 `.agent-sidebar-tree` 的 `padding: 8px 0 12px`）
      "px-4 pt-2.5 pb-1", // 分组标题（原 `.agent-sidebar-section-label, .agent-tree-section-title`）
      "mx-2 mb-2", // agent 行（原 `.agent-sidebar-agent` 的 `margin: 0 8px 8px`）
      "last:mb-0", // 末行不留白（原 `.agent-tree-agent:last-child`）
      "min-h-10", // 卡片高度 40px（原 `.agent-sidebar-agent-card` 的 `min-height: 40px`）
      "px-3 py-2.25", // 卡片内边距 9px 12px
      "rounded-md", // 卡片圆角 6px
      "size-3.75", // 图标 15×15（原 `.agent-sidebar-icon-btn svg, .agent-sidebar-actions button svg`）
    ];

    expect(migratedClasses.filter((token) => !viewCode.includes(token))).toEqual([]);

    for (const declaration of [
      "padding: 8px 0 12px",
      "padding: 10px 16px 4px",
      "margin: 0 8px 8px",
      "margin-bottom: 0",
      "min-height: 40px",
      "padding: 9px 12px",
      "border-radius: 6px",
      "width: 15px",
      "height: 15px",
    ]) {
      expect(companionCode).not.toContain(declaration);
    }

    // 留下的理由各钉一处：`content` / 60% 高等伪元素盒属性仍在表内，投影是带 alpha 的复合表达式；
    // 指示条的宽度与垂直居中已按第三批（2026-09-28）撤回 `className` 的标准变体（`before:w-0.75` /
    // `before:top-1/2`），表内不得回流 `width: 3px` / `top: 50%`。
    expect(companionCode).toContain("::before");
    expect(companionCode).toContain("box-shadow");
    expect(viewCode).toContain("before:w-0.75");
    expect(viewCode).toContain("before:top-1/2");
    expect(companionCode).not.toContain("width: 3px");
    expect(companionCode).not.toContain("top: 50%");
  });
});
