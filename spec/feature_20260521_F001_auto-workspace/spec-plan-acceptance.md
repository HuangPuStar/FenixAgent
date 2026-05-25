### Acceptance Task: 去除 Workspace 路径 验收

**前置条件:**
- 启动命令: `bun run dev`
- 测试账号: `admin@test.com` / `admin123456`
- 数据库已同步: `bun run db:push`

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `bun test src/__tests__/ && bun test packages/plugin-opencode/src/__tests__/`
   - 预期: 全部测试通过
   - 失败排查: 检查各 Task 的测试步骤

2. TypeScript 类型检查通过
   - `bun run typecheck`
   - 预期: 无类型错误
   - 失败排查: 检查 AgentLaunchSpec 类型变更是否在所有消费端正确适配

3. 前端构建通过
   - `bun run build:web`
   - 预期: 构建成功，无 error
   - 失败排查: 检查 Task 4 的 EnvironmentsPage 改动

4. SDK 类型导出正确
   - `grep -n "organizationId\|userId" packages/plugin-sdk/src/agent-launch-spec.ts`
   - 预期: `AgentLaunchSpec` 接口包含 `organizationId: string` 和 `userId: string`，无 `workspace` 字段
   - 失败排查: 检查 Task 1

5. 路径解析工具存在
   - `grep -n "resolveWorkspacePath" src/services/workspace-resolver.ts`
   - 预期: 导出 `resolveWorkspacePath(organizationId, userId)` 函数
   - 失败排查: 检查 Task 1

6. 后端环境创建不再要求 workspacePath
   - `grep -n "workspacePath" src/schemas/environment.schema.ts`
   - 预期: CreateEnvironmentRequestSchema 和 UpdateEnvironmentRequestSchema 中无 workspacePath 字段
   - 失败排查: 检查 Task 2

7. 前端无 workspace 输入残留
   - `grep -n "formWorkspacePath\|setFormWorkspacePath\|validation\.pathAbsolute" web/src/pages/EnvironmentsPage.tsx`
   - 预期: 无匹配结果
   - 失败排查: 检查 Task 4

8. opencode-runtime 使用 orgId+userId 计算路径
   - `grep -n "launchSpec\.workspace\|launchSpec\.organizationId" packages/plugin-opencode/src/runtime/opencode-runtime.ts`
   - 预期: 无 `launchSpec.workspace` 引用，有 `launchSpec.organizationId` 和 `launchSpec.userId` 引用
   - 失败排查: 检查 Task 3

9. Biome lint 通过
   - `bun run lint 2>&1 | tail -5`
   - 预期: 无 lint 错误
   - 失败排查: 运行 `bun run format` 自动修复格式问题

---
