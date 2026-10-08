/**
 * ui-spec 校验与降级判定（纯函数层，§1.4 / §1.5）。
 *
 * 输入 renderer 收到的 code 字符串，输出确定性判定结果；不抛异常、不读全局状态、不写日志、不发请求。
 * 降级优先级自上而下：L0 限额 → L1 JSON → L1 结构 → L2 版本 → L2 限额 → L3 目录（`resolveElement`）。
 *
 * 实现边界（§1.5「图检查实现边界」）：
 * - 先限 code 长度，再做包络校验与**有界迭代遍历**（显式栈，不用递归，避免超深 JSON 爆栈）；
 * - 所有元素（含未知 type）都做结构与限额检查；
 * - 结构与限额分开：长度/数量/深度超限是 `limits`，形状与引用图错误是 `structure`，不互相误报；
 * - 树而不是 DAG：重复边、多父共享、active-path 环检测分开处理，不靠全局 visited 静默跳节点。
 */

import { getCatalogEntry, isCatalogType, isContainerType, type UISpecTypeName } from "./catalog";
import {
  type ElementResolution,
  UI_SPEC_LIMITS as L,
  UI_SPEC_VERSION,
  type UISpec,
  type UISpecElement,
  type UISpecParseResult,
} from "./spec";

/** 归一化后的元素：`props` / `children` 一定有值，且只保留白名单键。 */
interface NormalizedElement {
  type: string;
  props: Record<string, unknown>;
  children: string[];
}

/** 结构校验通过的中间形态：保留 Map 与 id 顺序，供限额遍历与最终归一化复用。 */
interface UISpecTree {
  version: number;
  root: string;
  ids: string[];
  elements: Map<string, NormalizedElement>;
}

const TOP_LEVEL_KEYS = new Set(["version", "root", "elements"]);
const ELEMENT_KEYS = new Set(["type", "props", "children"]);
/**
 * props 对象/数组嵌套深度上限：复用 `maxDepth`（不新增冻结限额值）。
 * §1.5 要求超深 props 在迭代扫描阶段就拒绝，避免把超深结构交给 zod（递归实现会爆栈）。
 */
const MAX_PROPS_NESTING = L.maxDepth;

/**
 * 解析并校验 ui-spec 正文。
 *
 * - `ok`：返回归一化后的 Spec（只含白名单键，props/children 缺省已按 `{}` / `[]` 补齐）；
 * - `degraded`：整块降级，`reason` 为稳定原因码，渲染层据此选择原文 / 版本占位等形态（本层不产出文案）。
 *
 * 重复 JSON 键（含 elements 中重复 id）按 `JSON.parse` 语义处理：最后一个同名键生效，校验该归一结果；
 * 本层**不声称**能检测已被 parse 覆盖的键（§1.5 L1 重名）。
 */
export function parseUISpec(code: string): UISpecParseResult {
  // L0 限额：先于 JSON.parse。非字符串按不可解析处理，超长正文（含尚未闭合的流式输入）不解析
  if (typeof code !== "string") return { status: "degraded", reason: "json" };
  if (code.length > L.maxCodeChars) return { status: "degraded", reason: "limits" };

  let raw: unknown;
  try {
    raw = JSON.parse(code);
  } catch {
    // L1 JSON：语法错误（半截 JSON、注释、尾逗号、单引号等）整块降级，不补括号、不猜内容
    return { status: "degraded", reason: "json" };
  }

  const tree = readTree(raw);
  if (tree === null) return { status: "degraded", reason: "structure" };

  // L2 版本：正整数且不等于当前版本；旧版本与过新版本同样整块降级，由渲染层据 version 区分文案
  if (tree.version !== UI_SPEC_VERSION) return { status: "degraded", reason: "version", version: tree.version };

  // L2 限额：元素数 / 树深度 / children 数 / id / type / 任意字符串 / props 嵌套深度
  if (exceedsLimits(tree)) return { status: "degraded", reason: "limits" };

  return { status: "ok", spec: materialize(tree) };
}

/**
 * L1 结构与引用图校验：整块通过或整块拒绝，不局部剪裁成残缺成功 UI。
 *
 * 只判形状与引用关系；长度、数量、深度等超限留给 `exceedsLimits`（L2），避免把超限误报成结构错误。
 */
function readTree(raw: unknown): UISpecTree | null {
  if (!isPlainObject(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) return null; // 顶层额外字段（含 __proto__）直接拒绝
  }

  const version = raw.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version <= 0) return null; // 非正整数

  const root = raw.root;
  if (typeof root !== "string" || root.length === 0) return null;

  const elementsRaw = raw.elements;
  if (!isPlainObject(elementsRaw)) return null;

  // Object.keys 取 own enumerable 键：JSON.parse 产生的 __proto__ 键同样是 own property
  const ids = Object.keys(elementsRaw);
  if (ids.length === 0) return null; // 空 elements 归 structure，不渲染空成功 UI

  const elements = new Map<string, NormalizedElement>();
  for (const id of ids) {
    if (id.length === 0) return null; // id 空串
    const element = readElement(elementsRaw[id]);
    if (element === null) return null;
    elements.set(id, element);
  }

  if (!elements.has(root)) return null; // root 不存在
  if (!isTreeGraph(root, elements)) return null; // 引用 / 重复边 / 多父 / 环 / 不可达

  return { version, root, ids, elements };
}

/** 逐元素形状校验：只允许 type / props / children，未知键直接拒绝（不剥离后放行）。 */
function readElement(raw: unknown): NormalizedElement | null {
  if (!isPlainObject(raw)) return null;
  for (const key of Object.keys(raw)) {
    if (!ELEMENT_KEYS.has(key)) return null;
  }

  const type = raw.type;
  if (typeof type !== "string" || type.length === 0) return null;

  const rawProps = raw.props;
  if (rawProps !== undefined && !isPlainObject(rawProps)) return null; // props 非对象

  const rawChildren = raw.children;
  const children: string[] = [];
  if (rawChildren !== undefined) {
    if (!Array.isArray(rawChildren)) return null; // children 非数组
    for (const child of rawChildren) {
      if (typeof child !== "string" || child.length === 0) return null; // children 非字符串数组
      children.push(child);
    }
  }

  // 已知叶节点带非空 children 属结构错误；叶节点 children 缺省或 [] 允许
  if (children.length > 0 && isCatalogType(type) && !isContainerType(type)) return null;

  return { type, props: rawProps === undefined ? {} : rawProps, children };
}

/**
 * 引用图校验：结构是**树**而不是 DAG。
 * 入度统计同时覆盖「同一父节点内重复列同一 child」的重复边与「多父共享」；
 * 环检测用 active-path 着色（命中当前路径即环，含自环），不靠全局 visited 静默跳节点。
 * 遍历结束后已访问数少于元素总数，即存在不可达节点。
 */
function isTreeGraph(root: string, elements: Map<string, NormalizedElement>): boolean {
  const inDegree = new Map<string, number>();
  for (const element of elements.values()) {
    const seen = new Set<string>();
    for (const child of element.children) {
      if (!elements.has(child)) return false; // 引用不存在
      if (seen.has(child)) return false; // 重复边：同一 children 数组内重复引用
      seen.add(child);
      inDegree.set(child, (inDegree.get(child) ?? 0) + 1);
    }
  }
  for (const count of inDegree.values()) {
    if (count > 1) return false; // 多父共享：同一元素被多处引用
  }

  const color = new Map<string, "active" | "done">();
  const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
  color.set(root, "active");
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    const children = elements.get(frame.id)?.children ?? [];
    if (frame.next >= children.length) {
      color.set(frame.id, "done");
      stack.pop();
      continue;
    }
    const child = children[frame.next];
    frame.next += 1;
    const state = color.get(child);
    if (state === "active") return false; // 回到当前路径：成环（含自环）
    if (state === "done") return false; // 入度 ≤1 时不会出现；出现即结构异常，不静默跳过
    color.set(child, "active");
    stack.push({ id: child, next: 0 });
  }

  return color.size === elements.size; // 数量不等 → 有不可达节点
}

/** L2 限额：元素数、树深度（root 从 1 计）、children 数、id / type 长度、任意字符串、props 嵌套深度。 */
function exceedsLimits(tree: UISpecTree): boolean {
  if (tree.ids.length > L.maxElements) return true;
  if (tree.root.length > L.maxIdChars) return true;

  for (const [id, element] of tree.elements) {
    if (id.length > L.maxIdChars) return true;
    if (element.type.length > L.maxTypeChars) return true;
    if (element.children.length > L.maxChildren) return true;
    if (scanProps(element.props) === "limits") return true;
  }

  return exceedsDepth(tree);
}

/** 树深度遍历：结构已保证是树，每个元素最多入栈一次（有界）。 */
function exceedsDepth(tree: UISpecTree): boolean {
  const rootElement = tree.elements.get(tree.root);
  if (rootElement === undefined) return true; // 结构校验已保证 root 存在，此处仅防御

  const stack: { element: NormalizedElement; depth: number }[] = [{ element: rootElement, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    if (frame.depth > L.maxDepth) return true;
    for (const child of frame.element.children) {
      const childElement = tree.elements.get(child);
      if (childElement === undefined) continue; // 结构校验已保证引用存在，此处仅防御
      stack.push({ element: childElement, depth: frame.depth + 1 });
    }
  }
  return false;
}

/**
 * 迭代扫描单个元素的 props：任意字符串（键或值）超 `maxString`、或对象/数组嵌套超上限即 `limits`。
 * 显式栈而非递归，超深结构不会爆栈；在交给 zod 之前完成。
 */
function scanProps(props: Record<string, unknown>): "ok" | "limits" {
  const stack: { value: unknown; depth: number }[] = [{ value: props, depth: 1 }];
  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) break;
    const value = frame.value;
    if (typeof value === "string") {
      if (value.length > L.maxString) return "limits";
      continue;
    }
    if (value === null || typeof value !== "object") continue;
    if (frame.depth > MAX_PROPS_NESTING) return "limits";
    if (Array.isArray(value)) {
      for (const item of value) stack.push({ value: item, depth: frame.depth + 1 });
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.length > L.maxString) return "limits";
      stack.push({ value: item, depth: frame.depth + 1 });
    }
  }
  return "ok";
}

/**
 * 归一化输出：只保留白名单键，props / children 一定有值。
 * 用 `Object.fromEntries` 建表（CreateDataProperty 语义），`__proto__` 这类 id 不会被写成原型。
 */
function materialize(tree: UISpecTree): UISpec {
  const entries: [string, UISpecElement][] = [];
  for (const id of tree.ids) {
    const element = tree.elements.get(id);
    if (element === undefined) continue; // 结构校验已保证存在，此处仅防御
    entries.push([id, { type: element.type, props: { ...element.props }, children: [...element.children] }]);
  }
  return { version: tree.version, root: tree.root, elements: Object.fromEntries(entries) };
}

/**
 * 单元素解析（L3 目录）。
 *
 * - 未收录 type（含 `constructor` / `toString` / `__proto__` 等原型名）→ `unsupported`：占位并显示受限类型名；
 * - 已收录 type：未知字段 / 类型错误 / 空值 / 超限等严格校验失败，以及 Table 跨字段约束不满足 → `invalid-props`；
 * - 成功时 props 已完成默认值归一（省略 gap→md、tone→default、align→按列数全 left），children 缺省按 `[]`，
 *   消费方直接按 props 渲染，**不得**再用解析前的 raw props。
 *
 * 入参约定为 `parseUISpec` 成功产物中的元素；本函数不重复做全树校验（引用、叶节点 children 等）。
 */
export function resolveElement(element: UISpecElement): ElementResolution {
  const type = element.type;
  if (!isCatalogType(type)) return { status: "unsupported", type };

  const rawProps = element.props === undefined ? {} : element.props; // props 省略按 {}
  if (!isPlainObject(rawProps)) return { status: "invalid-props", type };
  // zod 4.4.3 实测：own `__proto__` 键既不校验也不报未知键（strictObject 会静默跳过），
  // 在交给 zod 之前先拒掉，保证「原型名不享受特殊待遇」与严格白名单一致。
  if (Object.hasOwn(rawProps, "__proto__")) return { status: "invalid-props", type };

  const parsed = getCatalogEntry(type).props.safeParse(rawProps);
  if (!parsed.success) return { status: "invalid-props", type };

  const props = parsed.data as Record<string, unknown>;
  // 严格模式不变式：通过校验的输入键必须原样出现在 schema 输出里；缺失即说明被静默剥离，仍判 invalid-props。
  for (const key of Object.keys(rawProps)) {
    if (!Object.hasOwn(props, key)) return { status: "invalid-props", type };
  }
  if (type === "Table" && !isRectangularTable(props)) return { status: "invalid-props", type };

  return { status: "ok", type, props: normalizeProps(type, props), children: normalizeChildren(element.children) };
}

/**
 * Table 跨字段约束：每行长度必须等于列数；align 缺省按全 left，存在时长度必须等于列数。
 * 空表（columns / rows 为空）已由 schema 的 `.min(1)` 拦下，这里不重复判定。
 */
function isRectangularTable(props: Record<string, unknown>): boolean {
  const columns = props.columns;
  const rows = props.rows;
  const align = props.align;
  if (!Array.isArray(columns) || !Array.isArray(rows)) return false;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return false;
  }
  if (align !== undefined && (!Array.isArray(align) || align.length !== columns.length)) return false;
  return true;
}

/** 只在校验通过后调用，因此可按类型安全取值并补齐目录默认值。 */
function normalizeProps(type: UISpecTypeName, props: Record<string, unknown>): Record<string, unknown> {
  switch (type) {
    case "Stack":
      return { gap: props.gap ?? "md" };
    case "Text":
      return { text: props.text, tone: props.tone ?? "default" };
    case "Table": {
      const columns = props.columns as string[];
      return {
        ...(props.caption === undefined ? {} : { caption: props.caption }),
        columns,
        rows: props.rows as string[][],
        align: (props.align as ("left" | "right")[] | undefined) ?? columns.map(() => "left" as const),
      };
    }
  }
}

/** children 缺省按 `[]`，并拷贝一份，避免渲染层持到解析结果内部的数组引用。 */
function normalizeChildren(children: UISpecElement["children"]): string[] {
  return Array.isArray(children) ? [...children] : [];
}

/** JSON.parse 的产物只会是普通对象 / 数组 / 原始值；数组与 null 不算普通对象。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 类型再导出：消费方可从 `parse` 入口一并拿到冻结契约类型（定义仍在 `spec.ts` / `catalog.ts`）。
 */
export type { ElementResolution, UISpec, UISpecElement, UISpecParseResult, UISpecTypeName };
