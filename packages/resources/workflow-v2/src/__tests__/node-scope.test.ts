/**
 * `node-scope` 的口径测试（2C，按 2C-fix 的 fail-closed 许可集重写）。
 *
 * 样本来源：2026-09-29 对本地上游实例（`http://127.0.0.1:18080`，`fefb05f`）的真实响应
 * （形状与关键字段见 `docs/design/2026-09-29-workflow-v2-upstream-contract-snapshot.md`），
 * 逐项与 IDL `idl/workflow/workflow.thrift` 的 `WorkflowNodeTypeData` / `NodeTemplateListData` /
 * `NodePanelSearchData` 对齐；`node_panel_search` 在本实例恒为 `data: null`（空间内无 workflow/plugin
 * 资源），非空用例按 IDL 结构构造并在用例内注明。
 *
 * 覆盖三类端点的过滤、许可集的放行与滤除（含 `Api='4'` 插件家族与未列出的未知类型）、配置覆盖的宽窄
 * 两个方向、配置非法时的默认集回退、畸形输入不抛异常、入参不被修改。
 */

import { beforeEach, expect, test } from "bun:test";
import { filterNodePayload, isNodeAllowed } from "../server/services/node-scope";
import { initializeWorkflowV2ModuleConfig } from "../server/testing";

/** 冻结 §5 的默认许可集（数字字符串）：声明侧写在 `fenix.module.ts`，测试按数字形式注入。 */
const PERMISSION_TYPES = ["1", "2", "3", "5", "8", "11", "13", "15", "18", "20", "30", "31", "45", "58"];

/** 注入 fixture 的许可集串（逗号分隔，与部署面同形）。 */
const PERMISSION_SET = PERMISSION_TYPES.join(",");

/** 被裁剪的三个端点（`node-scope.ts` 的已知集合，测试按裸端点名调用）。 */
const ENDPOINTS = ["node_type", "node_template_list", "node_panel_search"];

/** 模板行的字段集合与实测一致（`id`/`type`/`node_type` 三元组一一对应）；值就近取自实测，缩短以省行宽。 */
function template(type: number, name: string) {
  return {
    id: String(type),
    type,
    name,
    desc: `${name} node`,
    icon_url: "http://127.0.0.1:9000/opencoze/default_icon/icon.png",
    support_batch: 0,
    node_type: String(type),
    color: "#3E8BFF",
  };
}

/** 节点属性行（IDL `NodeProps`）：`type` 是数字字符串，实测 start/end 两行同形。 */
function nodeProps(id: string, type: string) {
  return { id, type, is_enable_chat_history: false, is_enable_user_query: false, is_ref_global_variable: false };
}

/** node_type 端点样本：形状与实测一致（`data.node_types` + `data.nodes_properties`），值域扩到含非许可项。 */
const NODE_TYPE_PAYLOAD = {
  data: {
    node_types: ["1", "2", "6", "9", "21", "57"],
    sub_workflow_node_types: ["2", "9"],
    nodes_properties: [nodeProps("100001", "1"), nodeProps("900001", "21"), nodeProps("570001", "57")],
    sub_workflow_nodes_properties: [{ ...nodeProps("2", "2"), is_enable_chat_history: true }],
  },
  code: 0,
  msg: "",
  BaseResp: null,
};

/** node_template_list 样本：摘录实测模板行（保留真实 id/type/name 组合），含插件、未知与非许可行。 */
const TEMPLATE_ITEMS = [
  template(1000, "Comment"),
  template(31, "Comment"),
  template(4, "Plugin"),
  template(3, "LLM"),
  template(9, "Workflow"),
  template(1, "Start"),
  template(45, "HTTP request"),
  template(59, "JSON deserialization"),
  template(58, "JSON serialization"),
  template(27, "Knowledge writing"),
  template(6, "Knowledge retrieval"),
  template(42, "Update Data"),
  template(57, "Delete message"),
  template(28, "Batch"),
];

/** 过滤结果里被保留的模板 id：只有许可集成员（`4` 插件、`9` 子工作流与 59/57/1000 一律滤除）。 */
const TEMPLATE_SURVIVORS = ["31", "3", "1", "45", "58"];

/** node_template_list 样本：分类与模板同批返回（`cate_list` 实测值的摘录）。 */
const TEMPLATE_PAYLOAD = {
  data: {
    template_list: TEMPLATE_ITEMS,
    cate_list: [
      { name: "", node_type_list: ["1000", "31", "4", "3", "9"] },
      { name: "Logic", node_type_list: ["28", "29", "19", "32", "8", "5", "21", "20", "22"] },
      { name: "Input&Output", node_type_list: ["1", "2", "30", "13"] },
      { name: "Database", node_type_list: ["42", "43", "44", "46", "12"] },
      { name: "Utilities", node_type_list: ["45", "18", "15", "59", "58"] },
    ],
    plugin_api_list: null,
    plugin_category_list: null,
  },
  code: 0,
  msg: "",
  BaseResp: null,
};

/** node_panel_search 的实测空样本（`search_key` 为空或空间内无 workflow/plugin 资源时返回 `data: null`）。 */
const PANEL_SEARCH_EMPTY = { data: null, code: 0, msg: "", BaseResp: null };

/** node_panel_search 的非空样本：按 IDL `NodePanelSearchData` 构造（本实例无资源，取不到真实非空样本）。 */
const PANEL_SEARCH_FILLED = {
  data: {
    project_workflow: {
      workflow_list: [{ workflow_id: "7690910443052728320", name: "probe", desc: "", url: "", status: 0 }],
      next_page_or_cursor: "2",
      has_more: true,
    },
    resource_workflow: { workflow_list: [], next_page_or_cursor: "", has_more: false },
    favorite_plugin: {
      plugin_list: [{ plugin_id: "1", name: "plugin", desc: "", icon: "", tool_list: [], version: "1" }],
      next_page_or_cursor: "1",
      has_more: true,
    },
    store_plugin: { plugin_list: [], next_page_or_cursor: "", has_more: false },
  },
  code: 0,
  msg: "",
  BaseResp: null,
};

/** 读取对象字段；字段不存在即抛错，避免断言对着 undefined 静默通过。 */
function read(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || !(key in (value as Record<string, unknown>))) {
    throw new Error(`测试断言失败：过滤结果里不存在字段 ${key}`);
  }
  return (value as Record<string, unknown>)[key];
}

/** 取过滤结果的 `data.template_list`（模板过滤断言统一走它）。 */
function templateList(payload: unknown): unknown {
  return read(read(payload, "data"), "template_list");
}

/** 取 `data.template_list` 的 id 列表。 */
function templateIds(payload: unknown): string[] {
  return (templateList(payload) as Array<Record<string, unknown>>).map((item) => String(item.id));
}

/** 取 `data.cate_list` 的分类名与类型列表（分类过滤断言统一走它）。 */
function categories(payload: unknown): Array<{ name: unknown; list: unknown }> {
  const items = read(read(payload, "data"), "cate_list") as Array<Record<string, unknown>>;
  return items.map((item) => ({ name: item.name, list: item.node_type_list }));
}

beforeEach(() => {
  initializeWorkflowV2ModuleConfig({ nodeWhitelist: PERMISSION_SET });
});

// 许可集成员逐个放行：默认集的十四项覆盖首版允许的全部工作流基础节点，漏一项就会让画布少一个节点。
test("isNodeAllowed 放行许可集的全部成员", () => {
  for (const type of PERMISSION_TYPES) {
    expect(isNodeAllowed(type)).toBe(true);
  }
});

// 插件节点 Api='4' 已移出许可集：旧口径（把 4 当 HTTP 节点）等于整体放行插件家族，此处守住更正后的边界。
test("isNodeAllowed 滤除插件节点 Api='4'", () => {
  expect(isNodeAllowed("4")).toBe(false);
  expect(isNodeAllowed(4)).toBe(false);
  expect(isNodeAllowed(" 4 ")).toBe(false);
});

// 未列出的未知类型同样滤除（fail-closed）：上游新增节点类型不该自动出现在我们的画布上。
test("isNodeAllowed 滤除未列出的未知数字", () => {
  // 59 JsonParser / 57 Delete message / 1000 Comment(alt) 都不在冻结 §5 的许可集内。
  for (const type of ["59", "57", "1000", "999", "6", "9", "21", "12"]) {
    expect(isNodeAllowed(type)).toBe(false);
  }
});

// 数字入参（模板项的 type 字段就是数字）与带空白字符串必须按同一口径判定，读不出类型的形态一律未命中。
test("isNodeAllowed 接受数字并按同一口径判定", () => {
  expect(isNodeAllowed(45)).toBe(true);
  expect(isNodeAllowed(21)).toBe(false);
  expect(isNodeAllowed(" 45 ")).toBe(true);
  expect(isNodeAllowed(" 21 ")).toBe(false);
  // NaN / 空串读不出类型：fail-closed 下按未命中处理（旧口径的「保留」会让畸形输入成为绕过口）。
  expect(isNodeAllowed(Number.NaN)).toBe(false);
  expect(isNodeAllowed("")).toBe(false);
});

// node_type 端点的四个列表字段都要裁剪；信封字段（code/msg/BaseResp）必须原样保留。
test("node_type 响应按许可集裁剪四个列表且信封不变", () => {
  const filtered = filterNodePayload(NODE_TYPE_PAYLOAD, "node_type");
  const data = read(filtered, "data");

  expect(read(data, "node_types")).toEqual(["1", "2"]);
  expect(read(data, "sub_workflow_node_types")).toEqual(["2"]);
  expect((read(data, "nodes_properties") as Array<Record<string, unknown>>).map((item) => item.type)).toEqual(["1"]);
  expect(read(data, "sub_workflow_nodes_properties")).toEqual([
    { ...nodeProps("2", "2"), is_enable_chat_history: true },
  ]);
  expect(read(filtered, "code")).toBe(0);
  expect(read(filtered, "BaseResp")).toBeNull();
});

// 模板项以 node_type（字符串）为准；`node_type` 缺失时回退数字字段 `type`，两者都读不到则按未命中滤除。
test("node_template_list 按 node_type 过滤模板项并在缺失时回退 type", () => {
  const payload = {
    data: {
      template_list: [
        ...TEMPLATE_ITEMS,
        { id: "legacy", type: 21, name: "Loop(legacy)", node_type: "" },
        { id: "typeless", type: "45", name: "HTTP(typeless)" },
        { id: "opaque", name: "Unknown shape" },
      ],
    },
    code: 0,
    msg: "",
    BaseResp: null,
  };

  const filtered = filterNodePayload(payload, "node_template_list");
  // `typeless` 只有数字 `type=45`（许可集内）→ 保留；`legacy` 回退到 21、`opaque` 无类型 → 全部滤除。
  expect(templateIds(filtered)).toEqual([...TEMPLATE_SURVIVORS, "typeless"]);
  expect(read(filtered, "code")).toBe(0);
});

// 分类的 node_type_list 逐项过滤：整类被滤空时分类对象保留为空数组，不删键、不改分类名。
test("node_template_list 过滤分类的 node_type_list 且滤空后保留空数组", () => {
  const filtered = filterNodePayload(TEMPLATE_PAYLOAD, "node_template_list");

  expect(categories(filtered)).toEqual([
    { name: "", list: ["31", "3"] },
    { name: "Logic", list: ["8", "5", "20"] },
    { name: "Input&Output", list: ["1", "2", "30", "13"] },
    { name: "Database", list: [] },
    { name: "Utilities", list: ["45", "18", "15", "58"] },
  ]);
  expect(read(read(filtered, "data"), "plugin_api_list")).toBeNull();
  expect(read(read(filtered, "data"), "plugin_category_list")).toBeNull();
  expect(read(filtered, "msg")).toBe("");
});

// 插件条目（plugin_api_list / plugin_category_list）同样带 node_type 字段，`4` 已出许可集，两组条目整批滤除。
test("node_template_list 滤除插件条目列表", () => {
  const payload = {
    data: {
      plugin_api_list: [
        { plugin_id: "1", api_id: "1", api_name: "run", name: "run", desc: "", icon_url: "", node_type: "4" },
        { plugin_id: "2", api_id: "2", api_name: "sync", name: "sync", desc: "", icon_url: "", node_type: "27" },
      ],
      plugin_category_list: [
        { plugin_category_id: "1", only_official: false, name: "official", icon_url: "", node_type: "4" },
        { plugin_category_id: "2", only_official: true, name: "retired", icon_url: "", node_type: "9" },
      ],
    },
    code: 0,
    msg: "",
    BaseResp: null,
  };

  const filtered = filterNodePayload(payload, "node_template_list");
  const kept = (key: string) => (read(read(filtered, "data"), key) as Array<Record<string, unknown>>).length;

  expect(kept("plugin_api_list")).toBe(0);
  expect(kept("plugin_category_list")).toBe(0);
});

// 实测形状是 data:null（无资源），必须原样返回；非空形状下子工作流（9）与插件（4）四个组整组清空，
// 并撤销 has_more，避免客户端对已被排除的家族继续翻页。
test("node_panel_search 处理 data:null 并清空被排除家族的组", () => {
  expect(filterNodePayload(PANEL_SEARCH_EMPTY, "node_panel_search")).toBe(PANEL_SEARCH_EMPTY);

  const filtered = filterNodePayload(PANEL_SEARCH_FILLED, "node_panel_search");
  const data = read(filtered, "data");

  expect(read(data, "project_workflow")).toEqual({ workflow_list: [], next_page_or_cursor: "2", has_more: false });
  expect(read(data, "resource_workflow")).toEqual({ workflow_list: [], next_page_or_cursor: "", has_more: false });
  expect(read(data, "favorite_plugin")).toEqual({ plugin_list: [], next_page_or_cursor: "1", has_more: false });
  expect(read(data, "store_plugin")).toEqual({ plugin_list: [], next_page_or_cursor: "", has_more: false });
});

// 端点白名单之外的路径不裁剪：BFF 只对三个节点面板端点动手，其余透传响应必须逐字节原样回去。
test("未知端点原样返回", () => {
  for (const endpoint of ["/api/workflow_api/canvas", "/api/playground_api/space/list", "", "node_types"]) {
    expect(filterNodePayload(TEMPLATE_PAYLOAD, endpoint)).toBe(TEMPLATE_PAYLOAD);
  }
});

// 端点识别要容得下完整路径、查询串与尾斜杠（调用方传上游 path 时不必自行裁剪）。
test("端点按末段识别，兼容完整路径与查询串", () => {
  const filtered = filterNodePayload(TEMPLATE_PAYLOAD, "/api/workflow_api/node_template_list?need_types=1");
  expect(filtered).not.toBe(TEMPLATE_PAYLOAD);
  expect(templateIds(filtered)).toEqual(TEMPLATE_SURVIVORS);

  expect(filterNodePayload(NODE_TYPE_PAYLOAD, "/api/workflow_api/node_type/")).not.toBe(NODE_TYPE_PAYLOAD);
});

// 形状不认识时零改写（返回原引用）且不抛异常：不臆造字段、不误伤下游结构，宁可多露也不改坏响应。
test("形状不认识的载荷原样返回", () => {
  const cases: unknown[] = [
    null,
    undefined,
    42,
    "not-a-payload",
    [],
    {},
    { data: null },
    { data: "oops" },
    { data: [] },
    { data: { template_list: "oops", cate_list: 7, plugin_api_list: {} } },
    { data: { node_types: null, nodes_properties: "x", sub_workflow_node_types: undefined } },
    { data: { cate_list: [null, "x", { name: "Logic" }, { name: "Logic", node_type_list: null }] } },
    { data: { project_workflow: null, store_plugin: [] } },
    { data: { project_workflow: { workflow_list: null, has_more: true } } },
  ];

  for (const payload of cases) {
    for (const endpoint of ENDPOINTS) {
      expect(() => filterNodePayload(payload, endpoint)).not.toThrow();
      expect(filterNodePayload(payload, endpoint)).toBe(payload);
    }
  }
});

// 列表里的畸形条目（非对象、读不出类型）按未命中滤除而不是保留：判定层对畸形输入同样 fail-closed。
test("读不出类型的条目按未命中滤除", () => {
  const payload = {
    data: { template_list: [null, 21, "x", { node_type: 4 }, { node_type: "21" }, { node_type: "1" }] },
    code: 0,
    msg: "",
    BaseResp: null,
  };

  expect(templateList(filterNodePayload(payload, "node_template_list"))).toEqual([{ node_type: "1" }]);
});

// 过滤必须是纯函数：入参（含嵌套列表与条目）一个字节都不能被改写，调用方可能复用同一份响应。
test("过滤不修改入参", () => {
  const targets: Array<[unknown, string]> = [
    [NODE_TYPE_PAYLOAD, "node_type"],
    [TEMPLATE_PAYLOAD, "node_template_list"],
    [PANEL_SEARCH_FILLED, "node_panel_search"],
  ];
  for (const [payload, endpoint] of targets) {
    const snapshot = structuredClone(payload);
    filterNodePayload(payload, endpoint);
    expect(payload).toEqual(snapshot);
  }
});

// 未发生任何裁剪时返回原引用：透传面据此可以零拷贝回传，测试也用它区分「过滤过」与「没命中」。
test("无需裁剪时返回原引用", () => {
  const payload = {
    data: { node_types: ["1", "2", "45"], nodes_properties: [nodeProps("100001", "1")] },
    code: 0,
    msg: "",
    BaseResp: null,
  };
  expect(filterNodePayload(payload, "node_type")).toBe(payload);

  const onlyAllowed = { data: { cate_list: [{ name: "Input&Output", node_type_list: ["1", "2"] }] } };
  expect(filterNodePayload(onlyAllowed, "node_template_list")).toBe(onlyAllowed);
});

// 配置覆盖是**整体替换**且可以更宽：把插件（4）与子工作流（9）写进配置后必须放行（收窄同理，见下一例）。
test("配置覆盖为更宽集合后放行被排除的家族", () => {
  initializeWorkflowV2ModuleConfig({ nodeWhitelist: "1,4,9,45" });

  expect(isNodeAllowed("4")).toBe(true);
  expect(isNodeAllowed("9")).toBe(true);
  expect(isNodeAllowed("45")).toBe(true);
  // 未写进覆盖值的许可集成员立即不再放行：覆盖即许可集，没有隐藏的第二份白名单。
  expect(isNodeAllowed("3")).toBe(false);
  expect(isNodeAllowed("21")).toBe(false);

  const filtered = filterNodePayload(TEMPLATE_PAYLOAD, "node_template_list");
  expect(templateIds(filtered)).toEqual(["4", "9", "1", "45"]);

  // 面板搜索侧同理：插件组（4）放行后原样透出，子工作流组（9）一样不再被清空。
  const panel = read(filterNodePayload(PANEL_SEARCH_FILLED, "node_panel_search"), "data");
  expect(read(panel, "favorite_plugin")).toEqual(read(read(PANEL_SEARCH_FILLED, "data"), "favorite_plugin"));
  expect(read(panel, "project_workflow")).toEqual(read(read(PANEL_SEARCH_FILLED, "data"), "project_workflow"));
});

// 配置可以比默认更窄：只留 Start 时其余全部滤除，画布随之只剩一个节点类型。
test("配置收窄后立即收窄暴露面", () => {
  initializeWorkflowV2ModuleConfig({ nodeWhitelist: "1" });

  expect(isNodeAllowed("1")).toBe(true);
  expect(isNodeAllowed("45")).toBe(false);
  expect(templateIds(filterNodePayload(TEMPLATE_PAYLOAD, "node_template_list"))).toEqual(["1"]);
});

// 配置项全是名称形式（或干脆是空串）时解析结果为空，必须回退默认集：空许可集会静默关闭全部节点。
test("配置非法或为空时回退默认许可集", () => {
  for (const raw of ["", ",", "  ", "start, llm ,,http,", "START,end"]) {
    initializeWorkflowV2ModuleConfig({ nodeWhitelist: raw });
    for (const type of PERMISSION_TYPES) {
      expect(isNodeAllowed(type)).toBe(true);
    }
    expect(isNodeAllowed("4")).toBe(false);
    expect(isNodeAllowed("9")).toBe(false);
    expect(isNodeAllowed("999")).toBe(false);
  }
});

// 混合串里只收数字项：名称项被忽略而不是让整串失效，避免一次手误打掉整个许可集。
test("配置混合名称项时只收数字项", () => {
  initializeWorkflowV2ModuleConfig({ nodeWhitelist: "1, llm ,4,45, text-process" });

  expect(isNodeAllowed("1")).toBe(true);
  expect(isNodeAllowed("4")).toBe(true);
  expect(isNodeAllowed("45")).toBe(true);
  expect(isNodeAllowed("3")).toBe(false);
});
