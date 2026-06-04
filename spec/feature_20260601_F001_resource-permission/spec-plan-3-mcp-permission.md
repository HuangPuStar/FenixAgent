# resource-permission 执行计划 3：MCP 前后端接入权限改造

**目标:** 让 MCP 原有配置 API 和 Agent LaunchSpec 看到一致的内部 + 外部可读 MCP 集合，并对外部 MCP 强制只读。

**技术栈:** Bun + Elysia + Drizzle ORM + React 19 + Vite + i18next + Bun test

**设计文档:** `spec/feature_20260601_F001_resource-permission/spec-design.md`

## 改动总览

本计划改造 `src/services/config/mcp-server.ts`、`src/routes/web/config/mcp.ts`、`src/services/config/aggregate.ts`、MCP 前端页面、SDK 类型和测试。
本计划依赖 `spec-plan-1-db-permission.md` 的内部权限 service，MCP service 负责读取外部业务配置并补齐 `resourceAccess`。
LaunchSpec、配置页和 Agent 引用均复用原 MCP service 的可读集合，不新增权限 API。
第一版不做 MCP 配置脱敏，前端补充受信任内部协作提示文案。

---

### Task 0: 环境准备

**背景:**
MCP 接入依赖计划 1 的权限 service，且会触碰 MCP 配置校验和 route 行为。先验证基础权限 service 与 MCP 现有测试可用。

**执行步骤:**
- [x] 验证权限 service 已可用
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/resource-permission-service.test.ts`
  - 原因: MCP service 将直接使用 `listReadableResourceRefs`、`decorateResourceAccess`、`assertInternalWritable`
- [x] 验证 MCP 现有测试可运行
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/services/config-mcp-server.test.ts src/__tests__/mcp-server-info.test.ts`
  - 原因: 本计划会改动 MCP service 输出结构和 route 行为

**检查步骤:**
- [x] 检查权限 service 测试
  - `bun test src/__tests__/resource-permission-service.test.ts`
  - 预期: 测试通过
- [x] 检查 MCP 基线测试
  - `bun test src/__tests__/services/config-mcp-server.test.ts src/__tests__/mcp-server-info.test.ts`
  - 预期: 测试通过

---

### Task 1: MCP 配置 service 接入可读集合和写保护

**背景:**
当前 `src/services/config/mcp-server.ts` 只读取当前 organization 的 MCP server。需要在原 service 中追加外部授权 MCP、补齐来源字段，并在 update/delete/enable/disable/test/inspect/list_tools 等改变状态或依赖归属的动作中拒绝外部资源。

**涉及文件:**
- 修改: `src/services/config/mcp-server.ts`
- 修改: `src/services/config/types.ts`
- 修改: `src/services/config/index.ts`
- 新建: `src/__tests__/config-mcp-resource-access.test.ts`

**执行步骤:**
- [x] 在类型文件中扩展 MCP 返回类型
  - 位置: `src/services/config/types.ts` 的 MCP Server section
  - 给 `McpServerInfoOutput` 增加 `resourceAccess?: ResourceAccess` 和 `resourceKey?: string`
  - 新增 `export interface McpServerSetOptions { publicReadable?: boolean }`
  - 原因: route 和前端需要统一来源字段，set 接口需要承载公开开关
- [x] 新增外部 MCP 批量读取 helper
  - 位置: `src/services/config/mcp-server.ts`，在 `listMcpServers()` 前
  - 新增 `async function listExternalMcpServers(ctx)`：调用 `listReadableResourceRefs(ctx, "mcp_server")`，按 `mcpServer.id` 查询外部 rows，过滤不存在的引用
  - 原因: 权限 service 不组装 MCP 业务字段
- [x] 改造 `listMcpServers(ctx)`
  - 位置: `src/services/config/mcp-server.ts:listMcpServers()`
  - 查询内部 rows 和外部 rows；不按 name 去重；调用 `decorateResourceAccess(ctx, "mcp_server", combinedRows)`
  - 原因: 配置页、Agent 引用和 LaunchSpec 需要一致可见集合
- [x] 新增 `getMcpServerByResourceKey(ctx, resourceKey)`
  - 位置: `src/services/config/mcp-server.ts`，在 `getMcpServer()` 之后
  - 解析 `sourceOrganizationId/resourceUid`，按 id 查询 row，调用 `canReadResource(ctx, "mcp_server", row.id, row.organizationId)`，不可读返回 null，可读返回带 `resourceAccess`
  - 原因: 前端稳定读取同名外部 MCP
- [x] 改造 `getMcpServer(ctx, name)`
  - 位置: `src/services/config/mcp-server.ts:getMcpServer()`
  - 先查内部 `organizationId + name`；未命中时从 `listExternalMcpServers(ctx)` 找 name 相等的第一条；返回前补齐 `resourceAccess`
  - 原因: 保留旧 name 兼容，同时支持外部详情
- [x] 改造 `createMcpServer(ctx, name, type, config, options)`
  - 位置: `src/services/config/mcp-server.ts:createMcpServer()`
  - 签名增加 `options: McpServerSetOptions = {}`；创建或更新内部 row 后，当 `options.publicReadable !== undefined` 调用 `setPublicRead(ctx, "mcp_server", ctx.organizationId, row.id, options.publicReadable)`
  - 原因: 原 create/set 入口承载公开开关
- [x] 改造 `updateMcpServer(ctx, name, config, options)`
  - 位置: `src/services/config/mcp-server.ts:updateMcpServer()`
  - 先调用改造后的 `getMcpServer(ctx, name)`；不存在返回 false；调用 `assertInternalWritable(ctx, "mcp_server", existing.id, existing.organizationId)`；更新按 `mcpServer.id` 执行；处理 `options.publicReadable`
  - 原因: 外部 MCP 不允许编辑或修改公开状态
- [x] 改造 `deleteMcpServer` 和 `setMcpServerEnabled`
  - 位置: `src/services/config/mcp-server.ts`
  - 两个方法均先 `getMcpServer(ctx, name)`，再 `assertInternalWritable`，随后按 `mcpServer.id` update/delete
  - 原因: 外部 MCP 不允许删除、启停
- [x] 新增 `assertMcpServerInternalWritable(ctx, name)`
  - 位置: `src/services/config/mcp-server.ts` 的写操作 helper 区
  - 读取 MCP row 并调用 `assertInternalWritable`；返回 row；导出该函数
  - 原因: route 的 inspect/list_tools/test 需要明确拒绝外部资源
- [x] 改造 tool cache helper 支持源组织
  - 位置: `countToolsByServer`、`deleteToolsByServer`、`replaceToolsForServer`、`listToolsByServer`
  - 保持参数名为 `organizationId, serverName`，route 调用时传 `server.organizationId` 而不是固定 `ctx.organizationId`
  - 原因: 外部 MCP 的工具缓存属于源 organization，读取详情必须与源资源一致
- [x] 从 config barrel 导出新增函数和类型
  - 位置: `src/services/config/index.ts`
  - 导出 `getMcpServerByResourceKey`、`assertMcpServerInternalWritable`、`McpServerSetOptions`
  - 原因: route 和 config-pg barrel 需要访问
- [x] 为 MCP service 编写单元测试
  - 测试文件: `src/__tests__/config-mcp-resource-access.test.ts`
  - 测试场景:
    - `listMcpServers` 返回内部和外部同名 MCP，`resourceKey` 不同
    - `getMcpServerByResourceKey` 能读取外部授权 MCP 配置
    - `updateMcpServer`、`deleteMcpServer`、`setMcpServerEnabled` 遇到外部资源抛 403
    - `updateMcpServer(..., { publicReadable: true })` 调用 `setPublicRead`
  - 运行命令: `bun test src/__tests__/config-mcp-resource-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 MCP service 权限调用完整
  - `rg -n 'listReadableResourceRefs|decorateResourceAccess|assertInternalWritable|setPublicRead|getMcpServerByResourceKey|assertMcpServerInternalWritable' src/services/config/mcp-server.ts`
  - 预期: 所有关键调用均存在
- [x] 运行 MCP service 权限测试
  - `bun test src/__tests__/config-mcp-resource-access.test.ts`
  - 预期: 测试通过

---

### Task 2: MCP route 和 LaunchSpec 使用统一可见集合

**背景:**
MCP route 当前按 name 调 service，并在 inspect/list_tools 中固定使用 `ctx.organizationId`。LaunchSpec 当前在 `aggregate.ts` 直接查内部 enabled MCP，必须改为 service 可读集合，避免运行时遗漏外部 MCP。

**涉及文件:**
- 修改: `src/routes/web/config/mcp.ts`
- 修改: `src/services/config/aggregate.ts`
- 修改: `src/services/launch-spec-builder.ts`
- 新建: `src/__tests__/mcp-route-resource-access.test.ts`
- 新建: `src/__tests__/launch-spec-mcp-resource-access.test.ts`

**执行步骤:**
- [x] 改造 `handleList(ctx)`
  - 位置: `src/routes/web/config/mcp.ts:handleList()`
  - 对每个 server 调 `toServerInfo(s.name, s)` 后合并 `resourceAccess: s.resourceAccess`、`resourceKey: s.resourceAccess.resourceKey`
  - `countToolsByServer` 入参改为 `s.organizationId, s.name`
  - 原因: 列表需要来源字段和源组织 tool 计数
- [x] 改造 `handleGet(ctx, name)`
  - 位置: `src/routes/web/config/mcp.ts:handleGet()`
  - 当 name 包含 `/` 时调用 `configPg.getMcpServerByResourceKey(ctx, name)`，否则调用 `configPg.getMcpServer(ctx, name)`；返回 `{ name, config, resourceAccess }`
  - 原因: 支持同名外部 MCP 的稳定详情读取
- [x] 改造 create/update 公开开关入参
  - 位置: `src/routes/web/config/mcp.ts:handleCreate()` 和 `handleUpdate()`
  - 从 `config` 中提取 `publicReadable` 或从 body `data.publicReadable` 读取，传给 config service options；写入业务 config 前删除 `publicReadable`
  - 原因: 原 MCP API 承载公开开关，避免把 UI 字段写入 MCP JSON 配置
- [x] 在 route 写动作中拒绝外部资源
  - 位置: `handleDelete`、`handleEnable`、`handleDisable`、`handleTest`、`handleInspect`、`handleListTools`
  - 读取 server 后调用 `configPg.assertMcpServerInternalWritable(ctx, name)`；`handleTest` 和 `handleListTools` 对外部资源返回 403，不执行 inspect 或 cache 读写
  - 原因: 设计要求外部资源不可启停、测试、inspect 或管理工具缓存
- [x] 修正 tool cache 源组织入参
  - 位置: `handleDelete`、`handleInspect`、`handleListTools`
  - 使用 `server.organizationId` 调 `deleteToolsByServer`、`replaceToolsForServer`、`listToolsByServer`
  - 原因: tool cache 与源 MCP 所属 team 一致
- [x] 改造 `getAgentFullConfig(ctx, agentConfigId)`
  - 位置: `src/services/config/aggregate.ts`
  - 用 `listMcpServers(ctx)` 替换直接 `db.select().from(mcpServer).where(...)`；过滤 `enabled === true`
  - 原因: LaunchSpec 和配置页必须看到一致 MCP 可见集合
- [x] 保持 LaunchSpec MCP 配置转换兼容
  - 位置: `src/services/launch-spec-builder.ts` 的 MCP 循环
  - 继续使用 `server.name` 作为 SDK MCP name；不读 `resourceAccess`；保留现有 JSON parse 和 `toSdkMcpConfig`
  - 原因: 运行时需要直接引用外部源配置，但 SDK 配置结构无需知道权限表
- [x] 为 MCP route 编写测试
  - 测试文件: `src/__tests__/mcp-route-resource-access.test.ts`
  - 测试场景:
    - list 返回 `resourceAccess` 和 `resourceKey`
    - get 支持 `org-b/mcp-id` resourceKey
    - 外部 MCP delete/enable/disable/inspect/list_tools 返回 403
    - update 携带 `publicReadable` 时传入 config service options 且不污染 config JSON
  - 运行命令: `bun test src/__tests__/mcp-route-resource-access.test.ts`
  - 预期: 所有测试通过
- [x] 为 LaunchSpec MCP 可见集合编写测试
  - 测试文件: `src/__tests__/launch-spec-mcp-resource-access.test.ts`
  - 测试场景:
    - `getAgentFullConfig` 包含外部 enabled MCP
    - `buildLaunchSpec` 将外部 MCP config 转为 SDK `mcpServers`
    - disabled 外部 MCP 不进入 LaunchSpec
  - 运行命令: `bun test src/__tests__/launch-spec-mcp-resource-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 aggregate 不再直接查内部 MCP
  - `rg -n 'listMcpServers\\(|from\\(mcpServer\\)' src/services/config/aggregate.ts`
  - 预期: 存在 `listMcpServers(ctx)`，不存在直接 `from(mcpServer)` 查询 enabled MCP 的逻辑
- [x] 检查 route 返回来源字段
  - `rg -n 'resourceAccess|resourceKey|getMcpServerByResourceKey|assertMcpServerInternalWritable' src/routes/web/config/mcp.ts`
  - 预期: list/get/write route 均接入来源字段和只读保护
- [x] 运行 MCP route 和 LaunchSpec 测试
  - `bun test src/__tests__/mcp-route-resource-access.test.ts src/__tests__/launch-spec-mcp-resource-access.test.ts`
  - 预期: 测试通过

---

### Task 3: MCP 前端消费 resourceAccess

**背景:**
MCP 页面当前所有 server 都可编辑、删除、启停、inspect 和批量操作。需要基于 `resourceAccess` 展示来源、公开状态，并对外部资源隐藏写操作和批量选择。

**涉及文件:**
- 修改: `packages/sdk/src/types/schemas.ts`
- 修改: `web/src/types/config.ts`
- 修改: `web/src/pages/agent-panel/pages/AgentMcpPage.tsx`
- 修改: `web/src/i18n/locales/en/mcp.json`
- 修改: `web/src/i18n/locales/zh/mcp.json`
- 新建: `web/src/__tests__/mcp-resource-access-flow.test.ts`

**执行步骤:**
- [x] 扩展 SDK 和 web MCP 类型
  - 位置: `packages/sdk/src/types/schemas.ts` 的 `McpServerInfo` / `McpServerDetail`；`web/src/types/config.ts` 的 MCP types
  - 增加 `resourceAccess?: ResourceAccess`、`resourceKey?: string`
  - 原因: 页面判断来源和稳定 key
- [x] 改造 `AgentMcpPage` 的列表 key 和 selection
  - 位置: `web/src/pages/agent-panel/pages/AgentMcpPage.tsx` 的 `AgentCardList`
  - `cardKey` 使用 `server.resourceAccess?.resourceKey ?? server.name`
  - `selectable` 保持 true，但 checkbox 对 `server.resourceAccess?.writable === false` 禁用；`selected` 更新时过滤外部资源
  - 原因: 同名外部 MCP 不合并，批量写操作只作用于内部资源
- [x] 改造 MCP card 状态 badge
  - 位置: `AgentMcpPage` 的 `renderCard`
  - 增加来源 badge：内部 / 外部 / 公开；显示名使用 `sourceOrganizationId / server.name`
  - 原因: 用户需要区分外部来源，且第一版不做脱敏
- [x] 隐藏外部 MCP 写操作
  - 位置: `renderCard` 的按钮区域
  - 当 `server.resourceAccess?.writable === false` 时隐藏 enable/disable、edit、delete、inspect；保留展开已缓存工具的只读入口
  - 原因: 外部 MCP 只读，后端也会拒绝写动作
- [x] 新增 MCP 公开开关
  - 位置: `renderCard` 按钮区域
  - 当 `server.resourceAccess?.manageable === true` 时显示开关按钮；点击后先 `mcpApi.get(server.resourceAccess.resourceKey)` 获取 config，再 `mcpApi.set(server.name, { ...config, publicReadable: next })`
  - 原因: 公开开关通过原 set 接口修改 all:read 授权
- [x] 补充受信任内部协作提示
  - 位置: `AgentMcpPage` header subtitle 附近或列表顶部非卡片区域
  - 使用 i18n 文案说明公开 MCP 会暴露完整配置给受信任内部 team
  - 原因: 设计明确第一版 MCP 不脱敏
- [x] 补充 i18n 文案
  - 位置: `web/src/i18n/locales/en/mcp.json`、`zh/mcp.json`
  - 新增 `resource.internal`、`resource.external`、`resource.public`、`resource.makePublic`、`resource.makePrivate`、`resource.trustedNotice`
  - 原因: JSX 禁止硬编码用户可见字符串
- [x] 为 MCP 前端流程编写测试
  - 测试文件: `web/src/__tests__/mcp-resource-access-flow.test.ts`
  - 测试场景:
    - 内部和外部同名 MCP 同时渲染，key 使用 `resourceAccess.resourceKey`
    - 外部 MCP 不显示 edit/delete/enable/disable/inspect
    - 内部 MCP 公开开关调用原 set API 并携带 `publicReadable`
    - 批量操作不会选中外部 MCP
  - 运行命令: `bun test web/src/__tests__/mcp-resource-access-flow.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 MCP 页面使用来源字段
  - `rg -n 'resourceAccess|resourceKey|publicReadable|manageable|writable' web/src/pages/agent-panel/pages/AgentMcpPage.tsx`
  - 预期: key、按钮显示、批量选择和公开开关均使用 `resourceAccess`
- [x] 检查 MCP i18n 文案
  - `rg -n 'trustedNotice|makePublic|makePrivate|external|public' web/src/i18n/locales/en/mcp.json web/src/i18n/locales/zh/mcp.json`
  - 预期: 中英文文案均存在
- [x] 运行 MCP 前端测试
  - `bun test web/src/__tests__/mcp-resource-access-flow.test.ts`
  - 预期: 测试通过

---

### Task 4: MCP 权限接入验收

**前置条件:**
- 启动命令: 不需要启动服务；本计划通过 service、route、LaunchSpec 和前端测试验证
- 测试数据准备: 使用 stub 构造内部 / 外部 MCP 和 enabled/disabled 状态

**端到端验证:**

- [x] 运行完整测试套件确保无回归
   - `bun run precheck`
   - 预期: format、import 排序、tsc、biome check 全部通过
   - 失败排查: 检查 Task 1 类型导出、Task 3 SDK/web 类型同步

- [x] 验证 MCP service 和 route 权限链路
   - `bun test src/__tests__/config-mcp-resource-access.test.ts src/__tests__/mcp-route-resource-access.test.ts`
   - 预期: 外部可读、内部可写、外部写动作 403、公开开关映射均通过
   - 失败排查: 检查 Task 1 和 Task 2

- [x] 验证 LaunchSpec 可使用外部 MCP
   - `bun test src/__tests__/launch-spec-mcp-resource-access.test.ts`
   - 预期: 外部 enabled MCP 进入 `mcpServers`，disabled 不进入
   - 失败排查: 检查 Task 2 的 aggregate 改造

- [x] 验证 MCP 前端体验和构建
   - `bun test web/src/__tests__/mcp-resource-access-flow.test.ts && bun run build:web`
   - 预期: 前端测试和 Vite 构建均通过
   - 失败排查: 检查 Task 3
