// web/__tests__/file-tree-layout.test.ts
// 文件树布局的判定规则（浮动 / 固定）：不碰 DOM，直接断言 `resolveFileTreeLayout` 与浮层宽度夹取。
//
// 为什么单独测这一层：默认值是「未手动选择时按屏宽取」的二段规则，容器（`artifacts-files-workspace`）
// 只消费结果；把规则钉在纯函数上，「小屏浮动 / 大屏固定」与「显式选择优先」就不会随组件重构悄悄变化。

import { describe, expect, test } from "bun:test";

import {
  clampFileTreeOverlayWidth,
  FILE_TREE_MIN_WIDTH,
  FILE_TREE_OVERLAY_MAX_WIDTH,
  resolveFileTreeLayout,
} from "../lib/file-tree-layout";

describe("文件树布局判定", () => {
  // 业务意图：用户没手动选过时，大屏保持「固定」占位（历史行为），版式不变。
  test("未手动选择：大屏取固定", () => {
    expect(resolveFileTreeLayout(null, true)).toBe("docked");
  });

  // 业务意图：小屏默认浮动——文件树改以浮层呈现，不再从主内容里切走一段宽度。
  test("未手动选择：小屏取浮动", () => {
    expect(resolveFileTreeLayout(null, false)).toBe("floating");
  });

  // 业务意图：用户已明确要求记住选择——显式选过的模式不随屏宽变化，含「小屏选固定」这种反默认组合。
  test("显式选择优先于屏宽", () => {
    expect(resolveFileTreeLayout("floating", true)).toBe("floating");
    expect(resolveFileTreeLayout("docked", false)).toBe("docked");
  });

  // 业务意图：浮层盖在预览之上，宽度必须夹在「可用的最小宽度」与「不吞掉预览」的上限之间。
  test("浮层宽度夹在最小宽度与浮层上限之间", () => {
    expect(clampFileTreeOverlayWidth(120)).toBe(FILE_TREE_MIN_WIDTH);
    expect(clampFileTreeOverlayWidth(600)).toBe(FILE_TREE_OVERLAY_MAX_WIDTH);
    expect(clampFileTreeOverlayWidth(240)).toBe(240);
  });

  // 业务意图：宽度偏好被外部写坏（读到 NaN）时按最小宽度兜底，而不是产出 NaN 宽度让浮层整个消失。
  test("非有限宽度按最小宽度兜底", () => {
    expect(clampFileTreeOverlayWidth(Number.NaN)).toBe(FILE_TREE_MIN_WIDTH);
  });
});
