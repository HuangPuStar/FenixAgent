# 28. 先修共享交互 Primitive，再清页面级可访问性债务

| 属性 | 结论 |
| --- | --- |
| 优先级 | P1 |
| 置信度 | 高 |
| 影响 | 键盘用户无法使用主导航/文件树/版本与触发操作，ARIA 产生虚假可用性 |

## 对抗判决

共享 Tree 的外层声明 `role=treeitem` 和 `tabIndex=0`，实际 click handler 在内层 div；没有 keydown、roving focus、方向键、aria-selected/level。键盘能把焦点放上去，却无法 Enter/Space/Arrow 操作。错误 retry icon button 也没有可访问名称。这个浅 Primitive 将缺陷放大到所有复用树。

## 已核验证据

- `web/components/ui/tree.tsx:431-455`：可聚焦 treeitem 与点击目标分离，无键盘 handler/selected/level；retry 无 label。
- `web/src/pages/agent-panel/AgentSidebarTree.tsx:602-625`：实例项使用仅鼠标 div。
- `VersionPanel.tsx:127-144,219-225`、`TriggerPanel.tsx:124-141,225-239`、`RunListPanel.tsx:108-119`、`WorkflowVersions.tsx:179-182`：icon-only 无名称或可点击非按钮元素。
- 仓库没有 axe/Playwright 可访问性门禁；现有源码字符串测试无法验证键盘行为。

## 架构诊断

ARIA 属性是 interface 承诺；implementation 没实现对应交互协议，比完全不声明更容易制造虚假信心。Tree Primitive 应封装 selection、expansion、focus、keyboard 和 disabled 复杂度，而不是只提供样式容器。

## 目标不变量

- 按 WAI-ARIA Tree pattern 明确单选/多选、roving tabindex、Up/Down/Left/Right/Home/End、Enter/Space 行为。
- 焦点元素就是可操作元素；selected、expanded、level、setsize/posinset 按实际树状态表达。
- 所有 icon-only button 有上下文名称；非原生可交互 div 改为 button/link，除非完整实现键盘语义。
- loading/error/retry 有 aria-live/busy 与焦点保持策略。
- shared Primitive 行为测试一次覆盖，页面只测试业务映射。

## 分阶段整改

1. 修 Tree Primitive 和 AgentSidebar 实例项，加入 keyboard/focus tests。
2. 建立 Button/IconButton 使用规则，清版本、触发、运行列表。
3. 加入 axe 作为辅助门禁，并保留真实键盘用户流测试。
4. 把可访问性状态纳入 frontend guide 和组件 story/example。

## 验收

- 只用键盘可完成展开、折叠、移动、选择、进入实例和重试。
- Screen reader 宣告名称、层级、选中、展开和错误状态准确。
- 焦点在数据刷新/虚拟化/删除后落到可预测目标，不丢到 body。

## 非目标

axe 全绿不能证明行为可用；此整改以键盘交互和状态公告测试为主，静态扫描为辅。
