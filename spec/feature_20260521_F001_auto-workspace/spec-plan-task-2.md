### Task 2: 后端服务层 + 路由适配

**背景:**
当前后端服务层（launch-spec-builder、instance、environment-web、environment-core）和路由层直接传递 `workspacePath` 字符串，从用户请求一路透传到 `AgentLaunchSpec.workspace`。本 Task 将这些模块统一改为使用 `organizationId` + `userId`，workspace 路径的解析推迟到 `plugin-opencode` 运行时完成。本 Task 依赖 Task 1 输出的 `resolveWorkspacePath()` 函数和 SDK 类型变更，下游 Task 3（前端移除 workspacePath）依赖本 Task 的 API 变更。

**涉及文件:**
- 修改: `src/services/launch-spec-builder.ts`
- 修改: `src/services/instance.ts`
- 修改: `src/services/environment-web.ts`
- 修改: `src/services/environment-core.ts`
- 修改: `src/schemas/environment.schema.ts`
- 修改: `src/routes/web/environments.ts`
- 修改: `src/index.ts`
- 修改: `src/services/meta-agent.ts`

**执行步骤:**

- [x] 修改 `BuildLaunchSpecInput` 接口：移除 `workspacePath`，新增 `organizationId` + `userId`
- [x] 修改 `buildLaunchSpec()` 函数：解构和返回值适配新字段
- [x] 修改 `spawnInstanceFromEnvironment()` 中的 cwd 校验和 buildLaunchSpec 调用
- [x] 修改 `CreateWebEnvironmentParams` 接口：`workspacePath` 改为可选
- [x] 修改 `UpdateWebEnvironmentParams` 接口：删除 `workspacePath` 字段
- [x] 修改 `createWebEnvironment()` 函数：移除 workspacePath 相关校验和目录操作
- [x] 修改 `updateWebEnvironment()` 函数：移除 workspacePath 更新逻辑
- [x] 修改 `CreateEnvironmentRequestSchema`：移除 `workspacePath` 必填约束
- [x] 修改 `UpdateEnvironmentRequestSchema`：移除 `workspacePath` 可选字段
- [x] 修改 POST `/web/environments` 路由：body 类型和 createWebEnvironment 调用适配
- [x] 修改 PUT `/web/environments/:id` 路由：body 类型和 updateWebEnvironment 调用适配
- [x] 修改 `index.ts` auto-start 逻辑：workspace 路径改为自动计算
- [x] 修改 `meta-agent.ts` 的 `ensureMetaEnvironment()`：移除 workspacePath 传参
- [x] 更新已有测试文件中 `BuildLaunchSpecInput` 的 `workspacePath` 引用

**检查步骤:**

- [x] 验证 `BuildLaunchSpecInput` 接口不再包含 `workspacePath` 字段
- [x] 验证 `instance.ts` 不再读取 `env.workspacePath`
- [x] 验证 `environment-core.ts` 的 `UpdateWebEnvironmentParams` 不包含 `workspacePath`
- [x] 验证 `CreateEnvironmentRequestSchema` 和 `UpdateEnvironmentRequestSchema` 不包含 `workspacePath`
- [x] 验证路由层 body 类型不包含 `workspacePath`
- [x] 验证 `meta-agent.ts` 不传递 `workspacePath`
- [x] 验证 `index.ts` auto-start 使用 `resolveWorkspacePath`
- [x] 运行已有 launch-spec 测试（disabled skills 过滤失败是已有问题，非本次引入）

---
