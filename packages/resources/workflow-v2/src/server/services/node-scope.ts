/**
 * 节点范围裁剪（首版**节点许可集**的权威实现）。
 *
 * 客户端不可信：画布侧即便隐藏了入口，只要服务端把完整节点面板交给它，就能构造被裁剪节点的 workflow。
 * 因此过滤落在服务端——对 `node_type`、`node_template_list`、`node_panel_search` 三类响应做裁剪，
 * 保持响应其余结构不变（设计 §4.8）。
 *
 * 判定口径（冻结 §5，一律数字字符串，**fail-closed**）：
 * - `isNodeAllowed(type)` 当且仅当 `type` 命中许可集时返回 true，其余（含上游未来新增的未知类型）一律
 *   滤除——首版范围是「只要工作流部分」，上游新增一个节点类型不该自动出现在我们的画布上；
 * - 默认许可集见 `DEFAULT_NODE_PERMISSION_SET`；
 * - `WORKFLOW_V2_NODE_WHITELIST`（逗号分隔数字串）**整体替换**许可集，可宽可窄，语义与「配置即许可集」
 *   一致。旧实现的黑名单层已删除：它被许可集完全涵盖，留着只会与「配置即许可集」的覆盖语义打架；
 * - 解析只收数字项（忽略空白与 `start` / `text-process` 一类名称形式），解析结果为空时**回退默认集**：
 *   空许可集会静默关闭全部节点，比「配置写错」危险得多，不能让它成为一个可被偶然触发的默认值。
 *
 * `4` 与 `45` 的分工是首版边界所在：`Api='4'` 是**插件节点**（上游模板名 `Plugin`，画布 `formatPlugin`
 * 也用它构造插件节点），`Http='45'` 才是 HTTP request 节点。冻结 §5 的更正说明推翻了设计 §9.1.1 第 6 条
 * 的旧口径（把 `4` 记作 HTTP 节点）：按旧口径放行 `4` 等于整体放行插件模板与插件搜索组，故 `4` 不在默认
 * 许可集内，被排除的插件家族与 `PANEL_SEARCH_GROUPS` 的四个 plugin 组随之整组清空。
 *
 * 字段路径来自实测样本与上游 IDL（`idl/workflow/workflow.thrift`；样本与形状见
 * `docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md`，2026-09-29 经本地实例复核）：
 * - `node_type`（`WorkflowNodeTypeData`）：`data.node_types[]` / `data.sub_workflow_node_types[]` 是数字
 *   字符串；`data.nodes_properties[].type` / `data.sub_workflow_nodes_properties[].type` 是数字字符串；
 * - `node_template_list`（`NodeTemplateListData`）：`data.template_list[].node_type`（画布按它建模板表，
 *   同项另有数字字段 `type` 作为回退）、`data.cate_list[].node_type_list[]`、
 *   `data.plugin_api_list[].node_type`、`data.plugin_category_list[].node_type`；
 * - `node_panel_search`（`NodePanelSearchData`）：组内条目是 workflow / plugin **资源**、不带节点类型，
 *   家族由组键决定（两个 workflow 组产出 SubWorkflow=`9`，四个 plugin 组产出 `Api`=`4`）。
 *
 * 形状不认识时（非对象载荷、`data` 缺失、列表字段不是数组、条目不是对象）**原样返回**：不臆造字段、
 * 不抛异常、不修改入参；未发生任何过滤时返回原引用，调用方与测试据此判断「未被裁剪」。
 */

import { getWorkflowV2Config } from "../config";

/** 被裁剪的端点集合；`endpoint` 可以是裸端点名，也可以是 `/api/workflow_api/node_type` 这类完整路径。 */
const NODE_SCOPE_ENDPOINTS: ReadonlySet<string> = new Set(["node_type", "node_template_list", "node_panel_search"]);

/**
 * 默认许可集（冻结 §5）：Start=`1`、End=`2`、LLM=`3`、Code=`5`、If=`8`、Variable=`11`、Output=`13`、
 * Text=`15`、Question=`18`、SetVariable=`20`、Input=`30`、Comment=`31`、Http=`45`、JsonStringify=`58`。
 *
 * 刻意排除项各自都带外部依赖或越出首版范围：`4` 插件、`6`/`12`/`27`/`42`/`43`/`44`/`46` 数据集与数据库、
 * `9` 子工作流、`19`/`21`/`28`/`29` 循环与批处理、`7`/`10`/`26` 长期记忆与预留编号、`14`/`16`/`17`/`23`
 * 图像家族、`33`–`36` 触发器。放行其中任何一个都要改 `WORKFLOW_V2_NODE_WHITELIST`（显式的一次配置变更）。
 */
const DEFAULT_NODE_PERMISSION_SET: readonly string[] = [
  "1",
  "2",
  "3",
  "5",
  "8",
  "11",
  "13",
  "15",
  "18",
  "20",
  "30",
  "31",
  "45",
  "58",
];

/** 数字节点类型：十进制整数串。接口只认数字字符串，名称形式（`start`）不构成合法配置项。 */
const NUMERIC_NODE_TYPE = /^[0-9]+$/;

/**
 * `node_panel_search` 的资源组 → 组内条目产出的节点家族（IDL `NodePanelSearchData`）。
 * 组内条目（workflow / plugin 资源）不带节点类型，只能按组键映射；映射进同一份许可集判定后，
 * 「某家族是否放行」与其余两类端点由同一份配置决定，不再有第二处口径。
 *
 * 映射保留而非删除：许可集可由配置放宽（例如显式加回 `4`/`9`），届时对应组要能原样透出。
 */
const PANEL_SEARCH_GROUPS: Readonly<Record<string, { listKey: string; nodeType: string }>> = {
  // 子工作流（SubWorkflow='9'，默认集外）：搜索结果会产出一个子工作流节点。
  resource_workflow: { listKey: "workflow_list", nodeType: "9" },
  project_workflow: { listKey: "workflow_list", nodeType: "9" },
  // 插件（Api='4'，默认集外）：画布用 `4` 构造插件节点，四组默认整组清空。
  favorite_plugin: { listKey: "plugin_list", nodeType: "4" },
  resource_plugin: { listKey: "plugin_list", nodeType: "4" },
  project_plugin: { listKey: "plugin_list", nodeType: "4" },
  store_plugin: { listKey: "plugin_list", nodeType: "4" },
};

/** 当前生效的许可集；由模块配置解析而来（本文件不再写第二份默认值）。 */
interface NodeScope {
  readonly allowed: ReadonlySet<string>;
}

/** 惰性作用域读取：只有真正遇到节点类型时才读配置，形状畸变的载荷不会被配置错误牵连。 */
type ScopeProvider = () => NodeScope;

/** 构造一次性作用域读取器（同一次裁剪内只解析配置一次）。 */
function createScopeProvider(): ScopeProvider {
  let cached: NodeScope | undefined;
  return () => {
    cached ??= resolveNodeScope();
    return cached;
  };
}

/**
 * 由模块配置解析许可集：只收数字项，解析结果为空时回退 `DEFAULT_NODE_PERMISSION_SET`（见文件头）。
 * 配置未就绪或非法时按仓库口径抛错（不可用「全放行」掩盖配置故障，也不该静默换成「全滤除」）。
 */
function resolveNodeScope(): NodeScope {
  const allowed = new Set<string>();
  for (const entry of getWorkflowV2Config().nodeWhitelist) {
    const normalized = normalizeNodeType(entry);
    if (normalized !== null && NUMERIC_NODE_TYPE.test(normalized)) allowed.add(normalized);
  }
  if (allowed.size === 0) {
    for (const type of DEFAULT_NODE_PERMISSION_SET) allowed.add(type);
  }
  return { allowed };
}

/** 归一节点类型：数字转十进制字符串，字符串去空白；空串与非标量形态返回 null（判定时按未命中处理）。 */
function normalizeNodeType(value: unknown): string | null {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 判定单节点类型：读不出类型或不在许可集内一律 false（fail-closed，冻结 §5）。 */
function isAllowedByScope(scope: NodeScope, value: unknown): boolean {
  const type = normalizeNodeType(value);
  return type !== null && scope.allowed.has(type);
}

/** 单节点类型判定：命中许可集返回 true，其余（含未知类型与读不出类型的形态）一律 false（冻结 §5）。 */
export function isNodeAllowed(type: string | number): boolean {
  return isAllowedByScope(resolveNodeScope(), type);
}

/**
 * 过滤节点面板响应中的所有节点列表字段；保持响应其余结构不变。
 *
 * `endpoint` 不在已知集合内、或载荷/`data` 形状不认识时原样返回；未发生过滤时返回原引用。
 */
export function filterNodePayload(payload: unknown, endpoint: string): unknown {
  const target = resolveEndpoint(endpoint);
  if (target === null) return payload;

  const root = asRecord(payload);
  const data = root === null ? null : asRecord(root.data);
  if (root === null || data === null) return payload;

  const getScope = createScopeProvider();
  const filtered =
    target === "node_type"
      ? filterNodeTypeData(data, getScope)
      : target === "node_template_list"
        ? filterTemplateData(data, getScope)
        : filterPanelSearchData(data, getScope);

  return filtered === data ? payload : { ...root, data: filtered };
}

/** `node_type` 响应：两个类型列表与两组节点属性，各自按节点类型过滤。 */
function filterNodeTypeData(data: Record<string, unknown>, getScope: ScopeProvider): Record<string, unknown> {
  let next = data;
  next = withFilteredField(next, "node_types", (value) => filterTypeList(value, getScope));
  next = withFilteredField(next, "sub_workflow_node_types", (value) => filterTypeList(value, getScope));
  next = withFilteredField(next, "nodes_properties", (value) => filterTypedItems(value, getScope));
  next = withFilteredField(next, "sub_workflow_nodes_properties", (value) => filterTypedItems(value, getScope));
  return next;
}

/**
 * `node_template_list` 响应：模板项与两组插件条目按自身类型过滤，分类的 `node_type_list` 逐项过滤。
 * 分类里还有 `plugin_api_id_list` / `plugin_category_id_list`（插件 ID，不是节点类型）——本文件不解释它们，
 * 收窄插件入口由 `plugin_api_list` / `plugin_category_list` 的条目过滤与面板组清空负责。
 */
function filterTemplateData(data: Record<string, unknown>, getScope: ScopeProvider): Record<string, unknown> {
  let next = data;
  next = withFilteredField(next, "template_list", (value) => filterTypedItems(value, getScope));
  next = withFilteredField(next, "cate_list", (value) =>
    mapItems(value, (item) => {
      const record = asRecord(item);
      return record === null
        ? item
        : withFilteredField(record, "node_type_list", (list) => filterTypeList(list, getScope));
    }),
  );
  next = withFilteredField(next, "plugin_api_list", (value) => filterTypedItems(value, getScope));
  next = withFilteredField(next, "plugin_category_list", (value) => filterTypedItems(value, getScope));
  return next;
}

/**
 * `node_panel_search` 响应：被排除的家族整组清空，组对象保留（结构不变，画布按列表长度决定是否渲染
 * 该分类），并把 `has_more` 撤销为 false——整组都是被排除家族，对客户端而言「没有更多可见结果」。
 * 组结构不认识（非对象、列表字段不是数组）时不臆造字段，原样保留。
 */
function filterPanelSearchData(data: Record<string, unknown>, getScope: ScopeProvider): Record<string, unknown> {
  let next = data;
  for (const [key, spec] of Object.entries(PANEL_SEARCH_GROUPS)) {
    if (!(key in next)) continue;
    const group = asRecord(next[key]);
    const list = group === null ? undefined : group[spec.listKey];
    if (group === null || !Array.isArray(list)) continue;
    if (isAllowedByScope(getScope(), spec.nodeType)) continue;
    next = {
      ...next,
      [key]: { ...group, [spec.listKey]: [], ...(group.has_more === true ? { has_more: false } : {}) },
    };
  }
  return next;
}

/** 端点归一：取最后一段非空路径段（兼容查询串与尾斜杠），不在已知集合内返回 null。 */
function resolveEndpoint(endpoint: string): string | null {
  if (typeof endpoint !== "string") return null;
  const [path] = endpoint.split(/[?#]/);
  const segment = path
    .split("/")
    .filter((part) => part.length > 0)
    .pop();
  return segment !== undefined && NODE_SCOPE_ENDPOINTS.has(segment) ? segment : null;
}

/** 对象视图；数组与 null 不算（列表与信封字段都有固定形态，误判会掩盖畸形）。 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** 读取对象字段；非对象返回 undefined，不抛错（读不到即未命中许可集，由判定层滤除）。 */
function readField(value: unknown, key: string): unknown {
  const record = asRecord(value);
  return record === null ? undefined : record[key];
}

/** 条目类型口径：优先 `node_type`（字符串），无法识别时回退 `type`（数字）；都读不到即未命中，滤除。 */
function readDeclaredType(item: unknown): unknown {
  const nodeType = readField(item, "node_type");
  return normalizeNodeType(nodeType) === null ? readField(item, "type") : nodeType;
}

/** 按条目自身类型过滤列表（模板项、节点属性、插件条目）。 */
function filterTypedItems(value: unknown, getScope: ScopeProvider): unknown {
  return filterItems(value, (item) => isAllowedByScope(getScope(), readDeclaredType(item)));
}

/** 过滤数字字符串列表（`node_types` / `node_type_list`）。 */
function filterTypeList(value: unknown, getScope: ScopeProvider): unknown {
  return filterItems(value, (item) => isAllowedByScope(getScope(), item));
}

/** 列表过滤：非数组原样返回；全部保留时返回原数组（引用不变即「未裁剪」）。 */
function filterItems(value: unknown, isAllowed: (item: unknown) => boolean): unknown {
  if (!Array.isArray(value)) return value;
  const kept = value.filter(isAllowed);
  return kept.length === value.length ? value : kept;
}

/** 逐项映射：非数组原样返回；全部项引用未变时返回原数组。 */
function mapItems(value: unknown, map: (item: unknown) => unknown): unknown {
  if (!Array.isArray(value)) return value;
  const mapped = value.map(map);
  return mapped.every((item, index) => item === value[index]) ? value : mapped;
}

/** 替换对象的一个字段：字段缺失或过滤后值未变时返回原对象（保持未裁剪子树的引用）。 */
function withFilteredField(
  record: Record<string, unknown>,
  key: string,
  filter: (value: unknown) => unknown,
): Record<string, unknown> {
  if (!(key in record)) return record;
  const filtered = filter(record[key]);
  return filtered === record[key] ? record : { ...record, [key]: filtered };
}
