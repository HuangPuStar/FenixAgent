/**
 * 类型目录：类型名 → `zod/v4` props schema（§5.3）。
 *
 * 切片 1 只收录 Stack / Text / Table，全部 `strictObject`：未知字段**直接失败**，
 * 不做剥离后放行（原稿 `z.object` 会静默剥离，已被审计否掉）。
 *
 * 依赖方向：本文件 → `spec.ts`（限额）。不得 import React / UI 组件 / 图标；
 * 类型只增不改，破坏性变更必须换新类型名。
 */

import { z } from "zod/v4";
import { UI_SPEC_LIMITS as L } from "./spec";

/** 目录内的字面量上限（§5.3 冻结值）：仅本目录使用，不进 `UI_SPEC_LIMITS` 的全局口径。 */
const MAX_CAPTION_CHARS = 200;
const MAX_COLUMN_CHARS = 80;
const MAX_CELL_CHARS = 500;

/** 目录条目形状：`props` 是严格 schema；`container` 只标在可带 children 的类型上。 */
export interface UISpecCatalogEntry {
  props: z.ZodType;
  container?: boolean;
}

export const uiSpecCatalog = {
  Stack: {
    props: z.strictObject({ gap: z.enum(["sm", "md", "lg"]).optional() }),
    /** 容器：唯一允许非空 children 的类型（children 由 registry 消费）。 */
    container: true,
  },
  Text: {
    /** 叶节点：空文本判 invalid-props（占位），不静默丢内容。 */
    props: z.strictObject({
      text: z.string().min(1).max(L.maxString),
      tone: z.enum(["default", "muted", "danger"]).optional(),
    }),
  },
  Table: {
    /**
     * 叶节点：行列等长、align 与列数一致属于**跨字段**约束，schema 无法表达，
     * 由 `resolveElement` 在 schema 通过后补检（§5.3）。
     */
    props: z.strictObject({
      caption: z.string().max(MAX_CAPTION_CHARS).optional(),
      columns: z.array(z.string().min(1).max(MAX_COLUMN_CHARS)).min(1).max(L.maxTableCols),
      rows: z
        .array(z.array(z.string().max(MAX_CELL_CHARS)).min(1).max(L.maxTableCols))
        .min(1)
        .max(L.maxTableRows),
      align: z
        .array(z.enum(["left", "right"]))
        .min(1)
        .max(L.maxTableCols)
        .optional(),
    }),
  },
} as const satisfies Record<string, UISpecCatalogEntry>;

/** 目录内的类型名。`keyof` 派生，避免类型名与目录各写一份。 */
export type UISpecTypeName = keyof typeof uiSpecCatalog;

/**
 * own-property 判定类型是否收录：`constructor` / `toString` / `__proto__` 等原型名一律视为未收录
 * （不能靠原型链查找，否则这些名字会被误判为「已知类型」）。
 */
export function isCatalogType(type: string): type is UISpecTypeName {
  return Object.hasOwn(uiSpecCatalog, type);
}

/** 取目录条目；调用方先用 `isCatalogType` 收窄。 */
export function getCatalogEntry(type: UISpecTypeName): UISpecCatalogEntry {
  return uiSpecCatalog[type];
}

/** 是否容器类型（可带非空 children）；未标 `container` 的类型按叶节点校验。 */
export function isContainerType(type: string): boolean {
  if (!isCatalogType(type)) return false;
  return getCatalogEntry(type).container === true;
}
