# 工作区文件选择与整理实现计划

> 面向 AI 代理的工作者：使用 superpowers:executing-plans 在当前会话逐任务执行。遵循仓库要求，未经用户明确要求不创建 commit。

**目标：** 在现有文件树内提供常规单选、多选、拖动移动和菜单确认删除。

**规格：** [工作区文件选择与整理](./2026-11-16-workspace-file-operations.md)

**架构：** UI 包提供纯选择模型和可控选择的虚拟树。Machine 容器共享双分区状态，由独立交互/操作 hook 调用既有文件 API，并通知预览状态同步成功结果。

**技术栈：** React 19、react-arborist、原生 HTML5 DragEvent、ahooks、Bun test / happy-dom、现有 i18n。

## 文件与接口

- UI 的 file-tree-model.ts：选择状态、可见路径、父子去重纯函数。
- UI 的 file-tree-arborist.tsx / file-tree-view.tsx / file-tree-context-menu.tsx：受控选择、行拖动、落点高亮、多选菜单与删除确认。
- Machine 的 lib/workspace-file-operations.ts：移动计划与预览路径转换；WorkspaceFilesChange 为成功结果接口。
- Machine 的 hooks/use-file-tree-operations.ts：批量变更、单一在途锁、失败选择、生命周期保护。
- Machine 的 hooks/use-file-tree-interactions.ts：选择、菜单与内部拖动；外部上传继续消费原回调。
- Machine 的 hooks/use-file-tree-input-dialog.tsx：现有输入操作与校验，避免主容器超过 500 行。
- Machine 的 FileTreeTab / artifacts-files-workspace / use-artifacts-files：装配、生命周期和预览同步。
- 对应 web/__tests__：纯模型、真实 DOM 交互与 API 结果边界；双语文案归各自 owner。

## 任务 1：选择与操作模型

- [x] 先写 file-tree-selection.test.ts 与 workspace-file-operations.test.ts。
- [x] 运行局部测试并确认新行为失败。
- [x] 实现选择手势、可见行遍历、父子去重、移动冲突计划和预览路径映射。

```ts
expect(selectFileTreePaths({ paths: ["a"], anchor: "a" }, "c", ["a", "b", "c"], { range: true, toggle: false }).paths).toEqual(["a", "b", "c"]);
expect(getRootFileTreePaths(["docs", "docs/a.md"])).toEqual(["docs"]);
expect(remapWorkspaceFilePath("docs/a.md", { moved: [{ oldPath: "docs", newPath: "archive/docs" }], deleted: [] })).toBe("archive/docs/a.md");
```

- [x] 验证：bun test packages/ui-components/web/__tests__/file-tree-selection.test.ts packages/resources/machine/web/__tests__/workspace-file-operations.test.ts，预期全部通过。

## 任务 2：文件树真实交互

- [x] 先写/扩展 DOM 测试，触发 click / contextmenu / dragstart / dragover / drop，断言选择路径与回调；明确右键本身不删除。
- [x] 运行新测试确认失败；受影响 SSR 测试注入独立 i18n，消除已复现的共享全局污染。
- [x] 实现受控选择与 Arborist 同步，移除行内删除，支持跨树原生拖动；拖动路径用专用 MIME，只在本环境接收。
- [x] 多选菜单隐藏单项动作，确认框显示删除范围与不可撤销提示，提交中禁用关闭和重复操作。
- [x] 验证：运行 file-tree 相关 DOM、SSR、输入校验测试，预期全部通过，外部上传落点回归不变。

## 任务 3：文件变更与预览装配

- [x] 先写操作 hook 与预览同步回归，覆盖 deleted/failed、批次中断、环境切换、冲突继续和重复提交。
- [x] 运行新测试确认失败，再接入 rename / batchDelete；只把成功结果通知预览，失败项保留供重试。
- [x] 抽离输入弹窗编排，主容器按职责装配，补双语成功/失败/确认文案。
- [x] 验证：相关测试通过，单个业务代码文件不超过 500 行。

## 任务 4：交付验证

- [x] 更新 docs/arch/12-files.md 的浏览器交互契约。
- [x] 运行 bun run fastcheck；运行 bun run precheck；运行 bun run build:web，预期全部退出 0。
- [x] 依据 executing-plans 技能执行一次独立最终审查，修复实质问题并补回归。
- [x] 检查 git diff / 规格逐项验收，交付隔离工作区路径、测试结果，不创建 commit。

## Review Focus

- 两个 Arborist 的选择同步与 effect 循环；右键及拖动不得把整组选择意外缩为单项。
- MIME 载荷不可信、跨环境拖入、文件行落点、目录自身/后代、同名目标不覆盖。
- 外部上传与内部移动手势隔离；异步批次切换环境后不得污染当前视图。
- 部分失败后树、选择和预览三者一致；现有右键菜单与输入操作可访问。
