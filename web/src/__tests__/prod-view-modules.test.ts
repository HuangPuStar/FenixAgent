import { describe, expect, test } from "bun:test";

import type { ProdViewModulesConfig } from "../api/prod-views";
import {
  ALL_MODULE_KEYS,
  buildEnabledMap,
  buildModulesConfig,
  CHAT_MODULE_KEYS,
  defaultEnabledMap,
  PANEL_MODULE_KEYS,
} from "../lib/prod-view-modules";

describe("ProdView 模块配置纯逻辑", () => {
  // Chat 模块集合应保持产品视图中各主要聊天能力的稳定顺序。
  test("CHAT_MODULE_KEYS 包含全部聊天主体模块", () => {
    expect(CHAT_MODULE_KEYS).toEqual([
      "chatHeader",
      "sessionSidebar",
      "chatView",
      "chatComposer",
      "permissionPanel",
      "todoPanel",
      "contextPanel",
      "toolCallRow",
    ]);
  });

  // 附加面板集合只包含右侧可选的业务面板。
  test("PANEL_MODULE_KEYS 包含全部右侧附加面板", () => {
    expect(PANEL_MODULE_KEYS).toEqual(["filesPanel", "sitesPanel", "tasksPanel", "viewsPanel"]);
  });

  // 全量集合应合并聊天主体与附加面板，供配置转换遍历使用。
  test("ALL_MODULE_KEYS 按聊天模块后附加面板的顺序合并", () => {
    expect(ALL_MODULE_KEYS).toEqual([...CHAT_MODULE_KEYS, ...PANEL_MODULE_KEYS]);
  });

  // 默认配置中 chatHeader 必须启用，保证发布视图具备标题区域。
  test("默认启用 chatHeader", () => {
    expect(defaultEnabledMap().chatHeader).toBe(true);
  });

  // 默认配置中 sessionSidebar 必须启用，保证用户能够切换会话。
  test("默认启用 sessionSidebar", () => {
    expect(defaultEnabledMap().sessionSidebar).toBe(true);
  });

  // 默认配置中 chatView 必须启用，保证发布视图能展示消息内容。
  test("默认启用 chatView", () => {
    expect(defaultEnabledMap().chatView).toBe(true);
  });

  // 默认配置中 chatComposer 必须启用，保证用户可以输入消息。
  test("默认启用 chatComposer", () => {
    expect(defaultEnabledMap().chatComposer).toBe(true);
  });

  // 默认配置中 permissionPanel 必须启用，保证权限请求可见。
  test("默认启用 permissionPanel", () => {
    expect(defaultEnabledMap().permissionPanel).toBe(true);
  });

  // 默认配置中 todoPanel 必须启用，保证任务状态可见。
  test("默认启用 todoPanel", () => {
    expect(defaultEnabledMap().todoPanel).toBe(true);
  });

  // 默认配置中 contextPanel 必须启用，保证上下文信息可见。
  test("默认启用 contextPanel", () => {
    expect(defaultEnabledMap().contextPanel).toBe(true);
  });

  // 默认配置中 toolCallRow 必须启用，保证工具调用过程可见。
  test("默认启用 toolCallRow", () => {
    expect(defaultEnabledMap().toolCallRow).toBe(true);
  });

  // 文件面板默认关闭，避免发布视图无意暴露文件入口。
  test("默认关闭 filesPanel", () => {
    expect(defaultEnabledMap().filesPanel).toBe(false);
  });

  // 站点面板默认关闭，保持附加能力按需开启。
  test("默认关闭 sitesPanel", () => {
    expect(defaultEnabledMap().sitesPanel).toBe(false);
  });

  // 任务面板默认关闭，保持页面布局简洁。
  test("默认关闭 tasksPanel", () => {
    expect(defaultEnabledMap().tasksPanel).toBe(false);
  });

  // 视图面板默认关闭，避免默认展示额外导航入口。
  test("默认关闭 viewsPanel", () => {
    expect(defaultEnabledMap().viewsPanel).toBe(false);
  });

  // 每次创建默认配置必须返回独立对象，避免表单编辑污染后续默认值。
  test("默认配置调用之间不共享可变对象", () => {
    const first = defaultEnabledMap();
    first.chatView = false;

    expect(defaultEnabledMap().chatView).toBe(true);
  });

  // 空配置回填时应恢复 chatHeader 的安全默认启用状态。
  test("空配置回填 chatHeader 默认值", () => {
    expect(buildEnabledMap({}).chatHeader).toBe(true);
  });

  // 空配置回填时应恢复 filesPanel 的安全默认关闭状态。
  test("空配置回填 filesPanel 默认值", () => {
    expect(buildEnabledMap({}).filesPanel).toBe(false);
  });

  // 显式 false 是唯一的关闭信号，必须覆盖聊天模块默认值。
  test("显式 false 关闭聊天模块", () => {
    expect(buildEnabledMap({ chatView: { enabled: false } }).chatView).toBe(false);
  });

  // 显式 true 必须开启原本默认关闭的附加面板。
  test("显式 true 开启附加面板", () => {
    expect(buildEnabledMap({ filesPanel: { enabled: true } }).filesPanel).toBe(true);
  });

  // 缺失 enabled 表示沿用该模块的默认启用状态。
  test("缺失 enabled 时聊天模块保持默认启用", () => {
    expect(buildEnabledMap({ chatComposer: {} }).chatComposer).toBe(true);
  });

  // 只要模块配置已存在且未显式关闭，就应启用该附加面板。
  test("缺失 enabled 时附加面板视为启用", () => {
    expect(buildEnabledMap({ sitesPanel: {} }).sitesPanel).toBe(true);
  });

  // 单个模块配置不能影响未声明模块的默认状态。
  test("局部配置不影响其他模块默认值", () => {
    const enabled = buildEnabledMap({ tasksPanel: { enabled: true } });

    expect(enabled).toMatchObject({ tasksPanel: true, chatView: true, filesPanel: false });
  });

  // 回填只读取已支持模块，防止未知后端字段进入表单状态。
  test("回填忽略未知模块配置", () => {
    const config: ProdViewModulesConfig = {
      chatView: { enabled: false },
    };

    expect(buildEnabledMap(config)).not.toHaveProperty("experimentalPanel");
  });

  // 编辑配置为空时仍应为每个模块生成明确 enabled 字段。
  test("null 旧配置生成完整模块配置", () => {
    const result = buildModulesConfig(null, defaultEnabledMap());

    expect(Object.keys(result)).toEqual([...ALL_MODULE_KEYS]);
  });

  // undefined 旧配置与 null 一样应安全生成完整可提交配置。
  test("undefined 旧配置生成完整模块配置", () => {
    const result = buildModulesConfig(undefined, defaultEnabledMap());

    expect(result.viewsPanel).toEqual({ enabled: false });
  });

  // 表单值必须覆盖旧配置中的 enabled，反映用户本次编辑。
  test("表单值覆盖旧配置的 enabled", () => {
    const result = buildModulesConfig({ chatView: { enabled: false } }, { chatView: true });

    expect(result.chatView).toEqual({ enabled: true });
  });

  // 旧模块配置中的业务扩展字段必须原样保留，避免编辑开关时丢失服务端元数据。
  test("构建配置保留旧模块的扩展字段", () => {
    const result = buildModulesConfig({ filesPanel: { enabled: false, layout: "wide" } }, { filesPanel: true });

    expect(result.filesPanel).toEqual({ enabled: true, layout: "wide" });
  });

  // 未提供表单值时 enabled 应保留为 undefined，而不是擅自回退默认值。
  test("缺失表单值保留 undefined enabled", () => {
    const result = buildModulesConfig({ chatHeader: { layout: "compact" } }, {});

    expect(result.chatHeader).toEqual({ layout: "compact", enabled: undefined });
  });

  // 表单中的 false 必须精确保留，不能被对象合并时的真值判断吞掉。
  test("构建配置保留表单 false", () => {
    const result = buildModulesConfig({ filesPanel: { layout: "wide" } }, { filesPanel: false });

    expect(result.filesPanel).toEqual({ layout: "wide", enabled: false });
  });

  // 构建结果应包含所有受支持模块，保证后端获得完整的开关快照。
  test("构建配置覆盖全部受支持模块", () => {
    const result = buildModulesConfig(undefined, {});

    expect(Object.keys(result).sort()).toEqual([...ALL_MODULE_KEYS].sort());
  });

  // 输入对象不应被构建过程修改，避免 React 表单状态发生隐式变化。
  test("构建配置不修改旧配置输入", () => {
    const existing: ProdViewModulesConfig = { chatHeader: { enabled: false, layout: "compact" } };

    buildModulesConfig(existing, { chatHeader: true });

    expect(existing).toEqual({ chatHeader: { enabled: false, layout: "compact" } });
  });
});
