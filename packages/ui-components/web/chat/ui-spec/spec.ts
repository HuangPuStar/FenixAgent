/**
 * 声明式 UI Spec 的纯数据契约：版本、限额、结构类型与判定结果。
 *
 * 权威：`.peri/plans/ui-spec-slice1-plan.md` §1.4（冻结接口）/ §1.5（降级矩阵）/ §1.7（安全边界）；
 * 设计选型：`docs/arch/27-agent-output-visualization.md`。
 *
 * 本文件与 `catalog.ts` / `parse.ts` 构成纯逻辑层：**不得** import React、UI 组件或图标。
 * 运行时依赖方向为 `catalog → spec`、`parse → catalog → spec`；本文件对 `./catalog` 只有类型导入
 * （`UISpecTypeName`），在 `verbatimModuleSyntax` 下被完全擦除，不产生运行时循环依赖。
 */

import type { UISpecTypeName } from "./catalog";

/** 当前支持的 Spec 版本。正整数 `version` 不等于它时整块降级（reason=`version`）。 */
export const UI_SPEC_VERSION = 1;

/**
 * 冻结限额（§1.4，数值不在此处改动）。
 *
 * 长度口径为 renderer 收到的 JS 字符串 `.length`（UTF-16 code units）：
 * streamdown 对非空 code 常附一个换行，不假设与围栏正文逐字相等。
 */
export const UI_SPEC_LIMITS = {
  /** 整块正文长度上限：先于 JSON.parse 判定，超长不解析、不挂骨架，整块原文。 */
  maxCodeChars: 64_000,
  /** `elements` 条目数上限。 */
  maxElements: 200,
  /** 从 root 起算的树深度上限（root 深度按 1 计）；props 嵌套深度也复用它。 */
  maxDepth: 12,
  /** 单个元素的 children 数量上限。 */
  maxChildren: 40,
  /** props 中任意字符串（键或值）长度上限。 */
  maxString: 2_000,
  /** root id 与元素 id 长度上限。 */
  maxIdChars: 80,
  /** type 名长度上限。 */
  maxTypeChars: 80,
  /** Table 行数上限（目录级约束，校验在 `resolveElement`）。 */
  maxTableRows: 50,
  /** Table 列数上限（同时约束每行长度与 align 长度）。 */
  maxTableCols: 8,
} as const;

/** 校验通过后的元素：`props` / `children` 已归一（缺省分别按 `{}` / `[]`），且只保留白名单键。 */
export interface UISpecElement {
  type: string;
  props?: Record<string, unknown>;
  children?: string[];
}

/**
 * 校验通过的 Spec。
 *
 * `elements` 的键可能包含 `__proto__` / `constructor` / `toString` 等原型名：
 * 消费方必须用 own-property 查找（`Object.hasOwn` / `Map`），不得依赖原型链取值。
 */
export interface UISpec {
  version: number;
  root: string;
  elements: Record<string, UISpecElement>;
}

/** 整块降级原因码：json=语法错误；structure=结构/引用图；version=版本不支持；limits=超限。 */
export type UISpecDegradeReason = "json" | "structure" | "version" | "limits";

/**
 * 降级判定。渲染层只按 `status` / `reason` 分支即可，本层不产出任何 UI 文案。
 *
 * `version` 是对 §1.4 冻结联合类型的**向后兼容补充**（可选字段，仅 `reason === "version"` 时出现）：
 * §1.5 要求「新版本提示升级，旧版本不谎称来自更新版本」，仅凭 `reason` 无法区分二者。
 * 只按 `status` / `reason` 分支的消费方不受影响，忽略该字段不改变任何降级行为。
 */
export interface UISpecDegraded {
  status: "degraded";
  reason: UISpecDegradeReason;
  version?: number;
}

/** `parseUISpec` 的返回：成功给出归一化 Spec，失败给出稳定原因码（整块降级，不局部剪裁）。 */
export type UISpecParseResult = { status: "ok"; spec: UISpec } | UISpecDegraded;

/**
 * 单元素解析结果（渲染层逐元素遍历：占位该元素，兄弟继续）：
 * - `unsupported`：目录未收录的 type（含原型名），占位显示受限类型名，不渲染其子树；
 * - `invalid-props`：已收录 type 的严格校验或跨字段约束失败（含 Table 空表 / 非矩形 / align 错配）。
 */
export type ElementResolution =
  | { status: "ok"; type: UISpecTypeName; props: Record<string, unknown>; children: string[] }
  | { status: "unsupported"; type: string }
  | { status: "invalid-props"; type: string };
