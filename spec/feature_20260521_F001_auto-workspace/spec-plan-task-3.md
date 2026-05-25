### Task 3: plugin-opencode runtime 适配

**背景:**
opencode-runtime 是 plugin-opencode 的核心生命周期管理器。Task 1 已将 `AgentLaunchSpec.workspace` 替换为 `organizationId` + `userId`，需要在本 Task 中完成 runtime 层的适配。

**涉及文件:**
- 修改: `packages/plugin-opencode/src/runtime/opencode-runtime.ts`
- 修改: `packages/plugin-opencode/src/__tests__/opencode-runtime.test.ts`

**执行步骤:**

- [x] 在 createOpencodeRuntime 函数内部新增 resolveWorkspace 闭包函数
- [x] 在文件顶部 imports 中添加 join 导入
- [x] 在 prepareEnvironment() 方法开头调用 resolveWorkspace 并替换所有 input.launchSpec.workspace
- [x] 更新 opencode-runtime.test.ts 中的 createLaunchSpec 工厂函数和所有测试用例
- [x] 为 resolveWorkspace 路径计算逻辑编写专项测试

**检查步骤:**

- [x] 验证 opencode-runtime.ts 不再引用 launchSpec.workspace
- [x] 验证 resolveWorkspace 函数存在且使用 WORKSPACE_ROOT
- [x] 验证 import join 存在
- [x] 验证 opencode-runtime 单元测试全部通过 (8 pass, 0 fail)

---
