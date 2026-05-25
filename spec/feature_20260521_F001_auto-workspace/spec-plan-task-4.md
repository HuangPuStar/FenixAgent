### Task 4: 前端适配 + i18n

**背景:**
用户创建/编辑环境时不再需要手动填写 workspace 路径，后端已改为根据 orgId + userId 自动计算。

**涉及文件:**
- 修改: `web/src/pages/EnvironmentsPage.tsx`
- 修改: `web/src/i18n/locales/en/environments.json`
- 修改: `web/src/i18n/locales/zh/environments.json`

**执行步骤:**

- [x] 移除 `formWorkspacePath` state 声明
- [x] 清理 `openCreateDialog` 中的 workspace 重置
- [x] 清理 `openEditDialog` 中的 workspace 赋值
- [x] 移除 `handleFormSubmit` 中的 workspace 路径校验
- [x] 移除编辑/创建 API 调用中的 `workspacePath` 字段
- [x] 从 `handleFormSubmit` 的 deps 数组中移除 `formWorkspacePath`
- [x] 移除 `navigateToSession` 中的 cwd 参数传递
- [x] 移除 `handleEnterAgent`、`handleEnterInstance`、`handleSpawnNewInstance` 中的 cwd 参数
- [x] 移除表格视图中的 workspace_path 显示块
- [x] 修改卡片视图中的 fallback 显示
- [x] 移除创建/编辑表单中的 workspace 输入字段
- [x] 删除英文 i18n key（form.workspacePath、validation.pathAbsolute）
- [x] 删除中文 i18n key（form.workspacePath、validation.pathAbsolute）
- [x] 更新 empty.createHint 提示文本（EN/ZH）

**检查步骤:**

- [x] 验证 EnvironmentsPage.tsx 中不含 formWorkspacePath 相关代码
- [x] 验证 EnvironmentsPage.tsx 中不含 workspace_path 的 UI 展示
- [x] 验证 EnvironmentsPage.tsx 中不含 cwd 参数传递
- [x] 验证 i18n 文件不含已删除 key
- [x] 验证 createHint 文本已更新
- [x] 验证前端构建无错误 (built in 2.50s)

---
