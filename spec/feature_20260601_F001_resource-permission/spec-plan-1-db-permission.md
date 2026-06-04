# resource-permission 执行计划 1：DB 和权限服务

**目标:** 补齐 `resource_permission` 的内部 service 能力，为 provider / skill / mcp_server 的跨 team 只读共享提供统一判断入口。

**技术栈:** Bun + Elysia + Drizzle ORM + PostgreSQL + Zod v4 + Bun test

**设计文档:** `spec/feature_20260601_F001_resource-permission/spec-design.md`

## 改动总览

本计划覆盖数据库迁移校验、`src/repositories/resource-permission.ts`、新增 `src/services/resource-permission.ts`、测试 stub 与导出入口。
经代码分析确认 `src/db/schema.ts` 已定义 `resourcePermission` 表，`drizzle/0002_resource_permission.sql` 已存在；本计划要求验证并补齐内部权限 service，而不是重复创建表。
Task 1 验证 schema / repo / 测试注入基础，Task 2 新增服务层统一返回 `resourceAccess`，后续三份计划依赖 Task 2 的 service API。
权限 service 只返回资源引用和访问元信息，不返回完整 Provider / Skill / MCP 业务对象。

---

### Task 0: 环境准备

**背景:**
确保当前仓库的 Bun、Drizzle 迁移文件和测试工具可用，避免后续 Task 因基础环境问题阻塞。

**执行步骤:**
- [x] 验证 Bun 运行时可用
  - 位置: 仓库根目录
  - 执行 `bun --version`，记录版本号用于排查环境差异
  - 原因: 本项目所有构建、测试和迁移生成命令均通过 Bun 执行
- [x] 验证现有测试框架可用
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/services/config-mcp-server.test.ts`
  - 原因: 使用已有轻量测试确认 `bunfig.toml` preload 与 mock 注册链路正常

**检查步骤:**
- [x] 检查 Bun 可执行
  - `bun --version`
  - 预期: 输出 Bun 版本号，无 command not found
- [x] 检查后端测试可执行
  - `bun test src/__tests__/services/config-mcp-server.test.ts`
  - 预期: 测试通过，无 preload 或模块解析错误

---

### Task 1: 校验资源权限表和仓储

**背景:**
跨 team 共享需要稳定的授权记录存储和查询能力。当前 `src/db/schema.ts`、`drizzle/0002_resource_permission.sql`、`src/repositories/resource-permission.ts` 已存在，本 Task 负责补齐测试导出和仓储行为验证，供服务层可靠复用。

**涉及文件:**
- 修改: `src/db/schema.ts`
- 新建: `drizzle/0003_resource_permission_nulls_not_distinct.sql`
- 新建: `drizzle/meta/0003_snapshot.json`
- 修改: `drizzle/meta/_journal.json`
- 修改: `src/repositories/index.ts`
- 修改: `src/test-utils/setup-mocks.ts`
- 修改: `src/test-utils/stubs/config-pg-stub.ts`
- 修改: `src/test-utils/helpers.ts`
- 新建: `src/__tests__/resource-permission-repo.test.ts`

**执行步骤:**
- [x] 校验并补齐 repository 类型导出
  - 位置: `src/repositories/index.ts` 的 `resource-permission` export 块
  - 确保导出 `ResourcePermissionType`、`ResourcePermissionPrincipalType`、`ResourcePermissionAction`、`ResourcePermissionAccessibleRow`、`CreateResourcePermissionGrantInput`、`DeleteResourcePermissionGrantInput`
  - 原因: 后续 service 和测试需要复用精确类型，避免重复定义字符串联合类型
- [x] 修正 `resource_permission` 唯一约束的 NULL 语义
  - 位置: `src/db/schema.ts` 的 `resourcePermission` 表 `uniqueGrantIdx`
  - 将唯一索引改为 `uniqueIndex("idx_resource_permission_unique").on(...).nullsNotDistinct()`，覆盖 `principalId = null` 的 `all:read` 场景
  - 重新执行 `bunx drizzle-kit generate --name resource_permission_nulls_not_distinct`，生成 `drizzle/0003_resource_permission_nulls_not_distinct.sql`、`drizzle/meta/0003_snapshot.json` 并更新 `drizzle/meta/_journal.json`
  - 原因: PostgreSQL 普通 unique index 允许多个 NULL，必须使用 NULLS NOT DISTINCT 才能保证同一资源只有一条 `all:read`
- [x] 在测试 mock 白名单中注册权限服务依赖
  - 位置: `src/test-utils/setup-mocks.ts` 的 config-pg mock 注册附近
  - 新增 `../repositories/resource-permission` 的 mock 注册，导出可替换的 `resourcePermissionRepo`
  - 关键逻辑:
    ```ts
    mock.module("../repositories/resource-permission", () => ({
      resourcePermissionRepo: resourcePermissionRepoStub,
    }));
    ```
  - 原因: service 单元测试禁止直连数据库，需要通过集中 mock 注册表替换仓储
- [x] 新增 resource-permission 仓储 stub
  - 位置: 新建 `src/test-utils/stubs/resource-permission-repo-stub.ts`，并在 `src/test-utils/helpers.ts` 导出 `stubResourcePermissionRepo`
  - 实现 `IResourcePermissionRepo` 的所有方法，默认未配置方法抛出明确错误；`resetAllStubs()` 调用时恢复默认抛错实现
  - 原因: 后续每个资源接入测试都要稳定控制授权记录返回
- [x] 为仓储 SQL 结构编写单元测试
  - 测试文件: `src/__tests__/resource-permission-repo.test.ts`
  - 测试场景:
    - `drizzle/0002_resource_permission.sql` 和新增迁移包含三种 enum、`resource_permission` 表、四个索引、`NULLS NOT DISTINCT` 唯一语义 → 迁移文件与 schema 已对齐
    - `src/db/schema.ts` 导出 `resourcePermissionTypeEnum`、`resourcePermissionPrincipalEnum`、`resourcePermissionActionEnum`、`resourcePermission` → schema 出口完整
    - `src/repositories/index.ts` 导出 `resourcePermissionRepo` 和全部权限类型 → service 可从统一 repository barrel 引用
  - 运行命令: `bun test src/__tests__/resource-permission-repo.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查迁移包含资源权限表
  - `rg -n 'CREATE TABLE "resource_permission"|idx_resource_permission_unique|NULLS NOT DISTINCT|resource_permission_type' drizzle`
  - 预期: 输出表、唯一索引、NULLS NOT DISTINCT 和 enum 定义
- [x] 检查 repository barrel 导出完整
  - `rg -n 'ResourcePermissionType|ResourcePermissionAccessibleRow|resourcePermissionRepo' src/repositories/index.ts`
  - 预期: 三类导出均存在
- [x] 运行仓储结构测试
  - `bun test src/__tests__/resource-permission-repo.test.ts`
  - 预期: 测试通过

---

### Task 2: 新增内部资源权限服务

**背景:**
原资源 service 需要统一判断内部 / 外部资源来源、公开状态、可写性和可管理性。当前没有 `src/services/resource-permission.ts`，后续 skill、mcp、provider/model 都依赖本 Task 的内部 service API。

**涉及文件:**
- 新建: `src/services/resource-permission.ts`
- 修改: `src/services/config/index.ts`
- 修改: `src/services/config/types.ts`
- 新建: `src/__tests__/resource-permission-service.test.ts`

**执行步骤:**
- [x] 在 config 类型中新增统一来源字段类型
  - 位置: `src/services/config/types.ts` 的顶部 Permission 类型之后
  - 新增导出:
    ```ts
    export interface ResourceAccess {
      ownership: "internal" | "external";
      sourceOrganizationId: string;
      sourceOrganizationName?: string;
      resourceUid: string;
      resourceKey: string;
      manageable: boolean;
      writable: boolean;
      publicReadable?: boolean;
    }
    export interface ResourceAccessInput {
      id: string;
      organizationId: string;
      name?: string | null;
    }
    ```
  - 原因: provider / skill / mcp / model 返回结构需要复用同一个字段语义
- [x] 新建权限 service 的依赖注入结构
  - 位置: `src/services/resource-permission.ts` 文件顶部
  - 导入 `AuthContext`、`resourcePermissionRepo`、`ResourcePermissionType`、`ResourceAccess`
  - 定义 `_deps = { repo: resourcePermissionRepo }` 和 `_resetDeps()`，提供 `setResourcePermissionRepoForTesting(repo)` 供测试替换
  - 原因: 项目 service 采用模块级依赖替换模式，测试不直连数据库
- [x] 实现 `isManageable(ctx)` 辅助函数
  - 位置: `src/services/resource-permission.ts` 的 service 方法之前
  - 逻辑: `ctx.role === "owner" || ctx.role === "admin"` 返回 true，其他角色返回 false
  - 原因: 第一版可见性管理权限仅本 team owner/admin 可用
- [x] 实现 `buildResourceAccess(ctx, resourceType, row, publicReadable)`
  - 位置: `src/services/resource-permission.ts`
  - 逻辑:
    ```ts
    const internal = row.organizationId === ctx.organizationId;
    return {
      ownership: internal ? "internal" : "external",
      sourceOrganizationId: row.organizationId,
      resourceUid: row.id,
      resourceKey: `${row.organizationId}/${row.id}`,
      manageable: internal && isManageable(ctx),
      writable: internal,
      publicReadable: internal ? publicReadable : undefined,
    };
    ```
  - 原因: 所有资源列表和详情必须用稳定 `(sourceOrganizationId, resourceUid)` 身份，不按 name 去重
- [x] 实现 `listReadableResourceRefs(ctx, resourceType)`
  - 位置: `src/services/resource-permission.ts`
  - 调用 `_deps.repo.listAccessibleForPrincipal(ctx.organizationId, resourceType)`，过滤掉 `organizationId === ctx.organizationId` 的记录，返回 `{ organizationId, resourceType, resourceId, hasPublicRead }[]`
  - 原因: 原资源 service 只需要外部可读引用，再自行读取业务对象
- [x] 实现 `getPublicReadMap(ctx, resourceType, resourceIds)`
  - 位置: `src/services/resource-permission.ts`
  - 调用 `_deps.repo.listOwnedByOrganization(ctx.organizationId, resourceType)`，按 `resourceId` 生成 `Map<string, boolean>`，只保留入参中的 id
  - 原因: 原资源列表需要给内部资源补齐公开开关初始值
- [x] 实现 `decorateResourceAccess(ctx, resourceType, rows)`
  - 位置: `src/services/resource-permission.ts`
  - 入参 rows 类型使用 `ResourceAccessInput[]`；对内部资源读取 `getPublicReadMap`，对外部资源 `publicReadable` 置为 undefined；返回每行扩展 `{ ...row, resourceAccess }`
  - 原因: 原资源 service 读取完业务对象后统一补充来源字段
- [x] 实现 `setPublicRead(ctx, resourceType, ownerOrganizationId, resourceId, enabled)`
  - 位置: `src/services/resource-permission.ts`
  - 先调用 `assertInternalWritable(ctx, resourceType, resourceId, ownerOrganizationId)`，再根据 enabled 调用 `createGrant` 或 `deleteGrant`
  - `createGrant` 固定写入 `{ principalType: "all", principalId: null, action: "read", createdBy: ctx.userId }`
  - 原因: 前端公开开关通过原资源 update/set 请求触发，后端映射为 all:read 授权
- [x] 实现 `canReadResource(ctx, resourceType, resourceId, ownerOrganizationId)`
  - 位置: `src/services/resource-permission.ts`
  - 内部资源直接 true；外部资源调用 `_deps.repo.canReadExternalResource(ownerOrganizationId, resourceType, resourceId, ctx.organizationId)`
  - 原因: get/detail/runtime 读取需要统一可读性判断
- [x] 实现 `assertInternalWritable(ctx, resourceType, resourceId, ownerOrganizationId)`
  - 位置: `src/services/resource-permission.ts`
  - 当 `ownerOrganizationId !== ctx.organizationId` 时抛出 `new AppError("External resource is read-only", "FORBIDDEN", 403)`；内部资源直接返回
  - 原因: 外部资源所有编辑、删除、启停、公开状态修改均必须后端拒绝
- [x] 从 config barrel 导出来源类型
  - 位置: `src/services/config/index.ts` 的 type export 块
  - 导出 `ResourceAccess`、`ResourceAccessInput`
  - 原因: 保持 `src/services/config-pg.ts` barrel 兼容现有 import 路径
- [x] 为 `resource-permission` service 编写单元测试
  - 测试文件: `src/__tests__/resource-permission-service.test.ts`
  - 测试场景:
    - owner 组织内部资源 → `ownership=internal`、`writable=true`、`manageable=true`、`publicReadable=true`
    - member 组织内部资源 → `manageable=false`、`writable=true`
    - 外部授权资源 → `ownership=external`、`writable=false`、`manageable=false`、`resourceKey=ownerOrg/resourceId`
    - `setPublicRead(..., true)` 创建 `all:read` grant；`setPublicRead(..., false)` 删除 `all:read` grant
    - `assertInternalWritable` 遇到外部 ownerOrganizationId 抛 403 AppError
  - 运行命令: `bun test src/__tests__/resource-permission-service.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查权限 service 导出
  - `rg -n 'listReadableResourceRefs|decorateResourceAccess|setPublicRead|assertInternalWritable|canReadResource' src/services/resource-permission.ts`
  - 预期: 五个公开函数均存在
- [x] 检查来源类型导出
  - `rg -n 'ResourceAccess|ResourceAccessInput' src/services/config/types.ts src/services/config/index.ts`
  - 预期: 类型定义和 barrel export 均存在
- [x] 运行权限 service 测试
  - `bun test src/__tests__/resource-permission-service.test.ts`
  - 预期: 测试通过

---

### Task 3: DB 和权限服务验收

**前置条件:**
- 启动命令: 不需要启动服务，本计划只验证 schema、repository 和 service 单元能力
- 测试数据准备: 使用测试 stub，不连接真实数据库

**端到端验证:**

1. 运行完整质量检查确保无回归
   - `bun run precheck`
   - 预期: format、import 排序、tsc、biome check 全部通过
   - 失败排查: 检查 Task 1 的 barrel export 和 Task 2 的类型导出

2. 验证资源权限迁移文件已纳入 drizzle journal
   - `rg -n '"tag": "0002_resource_permission"|resource_permission|NULLS NOT DISTINCT' drizzle/meta/_journal.json drizzle`
   - 预期: journal 中包含资源权限迁移，SQL 中包含 `resource_permission` 和 `NULLS NOT DISTINCT`
   - 失败排查: 检查 Task 1 迁移文件校验

3. 验证仓储结构和 service 行为
   - `bun test src/__tests__/resource-permission-repo.test.ts src/__tests__/resource-permission-service.test.ts`
   - 预期: 全部测试通过
   - 失败排查: 检查 Task 1 repository stub 和 Task 2 service 逻辑
