### Task 1: SDK 类型变更 + 环境变量 + 路径解析工具

**背景:**
[业务语境] 将 Agent 创建时手动指定 workspace 路径改为通过 orgId + userId 自动计算，降低使用复杂度并支持多租户隔离
[修改原因] 当前 `AgentLaunchSpec.workspace` 要求上游传入绝对路径，耦合了文件系统管理；需替换为 `organizationId` + `userId` 两个语义字段，由共享工具函数计算实际路径
[上下游影响] 本 Task 的 `AgentLaunchSpec` 类型变更是所有后续 Task 的前置依赖：`launch-spec-builder.ts`、`opencode-runtime.ts`、`instance.ts` 等消费方将在后续 Task 中适配新类型；`resolveWorkspacePath()` 函数将被 `opencode-runtime.ts`、`environment-web.ts`、`index.ts` 调用

**涉及文件:**
- 修改: `packages/plugin-sdk/src/agent-launch-spec.ts`
- 修改: `src/env.ts`
- 新建: `src/services/workspace-resolver.ts`

**执行步骤:**

- [x] 修改 AgentLaunchSpec 接口，替换 workspace 字段为 organizationId + userId
  - 位置: `packages/plugin-sdk/src/agent-launch-spec.ts:86-93`
  - 将 `workspace: string;` 替换为 `organizationId: string;` 和 `userId: string;`
  - 更新文件顶部 L5 的 JSDoc 注释：将"完成 workspace"改为"完成环境准备"
  - 完整接口变更：
    ```typescript
    export interface AgentLaunchSpec {
      organizationId: string;
      userId: string;
      env?: Record<string, string>;
      agent: AgentConfig;
      model: ModelConfig;
      skills: SkillConfig[];
      mcpServers: McpServerConfig[];
    }
    ```

- [x] 在 envSchema 中注册 WORKSPACE_ROOT 环境变量
  - 位置: `src/env.ts:60`（Redis 缓存可选字段块的最后一个 `RCS_REDIS_CLUSTER` 之后，`});` 闭合之前）
  - 在 `RCS_REDIS_CLUSTER: z.string().optional(),` 之后添加新行：
    ```typescript
    // ── 可选：Workspace 路径 ──
    WORKSPACE_ROOT: z.string().optional(),
    ```

- [x] 创建共享路径解析工具函数
  - 位置: 新建 `src/services/workspace-resolver.ts`
  - 实现函数 `resolveWorkspacePath(organizationId: string, userId: string): string`
  - 逻辑：`path.join(process.env.WORKSPACE_ROOT ?? path.join(process.cwd(), "workspaces"), organizationId, userId)`
  - 文件完整内容：
    ```typescript
    import { join } from "node:path";

    /**
     * 根据 organizationId + userId 计算用户隔离的 workspace 路径。
     *
     * 路径公式: {WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}
     */
    export function resolveWorkspacePath(organizationId: string, userId: string): string {
      const root = process.env.WORKSPACE_ROOT ?? join(process.cwd(), "workspaces");
      return join(root, organizationId, userId);
    }
    ```

- [x] 为 resolveWorkspacePath 编写单元测试
  - 测试文件: `src/__tests__/workspace-resolver.test.ts`
  - 测试场景:
    - WORKSPACE_ROOT 未设置时，路径为 `cwd/workspaces/{orgId}/{userId}`
    - WORKSPACE_ROOT 已设置时，路径为 `{WORKSPACE_ROOT}/{orgId}/{userId}`
    - 不同 orgId + userId 组合产生不同路径
  - 运行命令: `bun test src/__tests__/workspace-resolver.test.ts`
  - 预期: 所有测试通过

**检查步骤:**

- [x] 验证 AgentLaunchSpec 不再包含 workspace 字段
  - `grep -n "workspace" packages/plugin-sdk/src/agent-launch-spec.ts`
  - 预期: 无匹配（workspace 字段已完全移除）

- [x] 验证 AgentLaunchSpec 包含 organizationId 和 userId 字段
  - `grep -n "organizationId\|userId" packages/plugin-sdk/src/agent-launch-spec.ts`
  - 预期: 在 AgentLaunchSpec 接口块内各匹配一行

- [x] 验证 env.ts 包含 WORKSPACE_ROOT
  - `grep -n "WORKSPACE_ROOT" src/env.ts`
  - 预期: 匹配一行

- [x] 验证 workspace-resolver.ts 文件存在且导出 resolveWorkspacePath
  - `grep -n "export function resolveWorkspacePath" src/services/workspace-resolver.ts`
  - 预期: 匹配一行

- [x] 验证 workspace-resolver 单元测试通过
  - `bun test src/__tests__/workspace-resolver.test.ts`
  - 预期: 所有测试通过，无报错

- [x] 验证 env-validation 测试未被破坏（WORKSPACE_ROOT 是 optional，不影响现有测试）
  - `bun test src/__tests__/env-validation.test.ts`
  - 预期: 所有测试通过

**认知变更:**
- [x] [CLAUDE.md] Workspace 路径计算公式为 `{WORKSPACE_ROOT ?? cwd/workspaces}/{organizationId}/{userId}`，由 `src/services/workspace-resolver.ts` 的 `resolveWorkspacePath()` 统一提供，所有需要 workspace 路径的位置必须调用此函数

---
