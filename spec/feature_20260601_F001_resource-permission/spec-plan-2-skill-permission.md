# resource-permission 执行计划 2：Skill 前后端接入权限改造

**目标:** 让 Skill 原有 API 返回内部和外部可读资源，并通过原 set/delete/upload 入口完成公开开关和只读保护。

**技术栈:** Bun + Elysia + Drizzle ORM + React 19 + Vite + TanStack Router + i18next + Bun test

**设计文档:** `spec/feature_20260601_F001_resource-permission/spec-design.md`

## 改动总览

本计划改造 `src/services/config/skill.ts`、`src/services/skill.ts`、`src/routes/web/config/skills.ts`、Skill 前端页面、Agent 配置弹窗和 SDK 类型。
本计划依赖 `spec-plan-1-db-permission.md` 的 `src/services/resource-permission.ts`，Skill service 通过它获取外部可读引用并补齐 `resourceAccess`。
Skill 运行时下载仍使用现有 token 机制，外部 Skill 不复制到当前 team 目录，读取源 skill 当前 `contentPath` 和 archive。
前端只消费原 Skill API 返回的 `resourceAccess`，不新增权限 API。

---

### Task 0: 环境准备

**背景:**
本计划依赖计划 1 的内部权限 service。执行前先验证计划 1 的测试通过，再进入 Skill API 和 UI 改造。

**执行步骤:**
- [x] 验证计划 1 已完成
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/resource-permission-service.test.ts`
  - 原因: Skill 接入直接调用 `decorateResourceAccess`、`listReadableResourceRefs`、`setPublicRead`、`assertInternalWritable`
- [x] 验证 Skill 现有测试可运行
  - 位置: 仓库根目录
  - 执行 `bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-import-name-overwrite.test.ts`
  - 原因: 本计划会改动 Skill 编排层和文件生命周期逻辑

**检查步骤:**
- [x] 检查计划 1 权限 service 测试
  - `bun test src/__tests__/resource-permission-service.test.ts`
  - 预期: 测试通过
- [x] 检查 Skill 基线测试
  - `bun test src/__tests__/skill-archive-lifecycle.test.ts src/__tests__/skill-import-name-overwrite.test.ts`
  - 预期: 测试通过

---

### Task 1: Skill 配置 service 返回可读资源集合

**背景:**
当前 `src/services/config/skill.ts` 只按 `ctx.organizationId` 查询内部 skill。需要在 service 层追加外部授权 skill，并补齐来源字段，供 route、Agent 配置和运行时统一使用。

**涉及文件:**
- 修改: `src/services/config/skill.ts`
- 修改: `src/services/config/types.ts`
- 修改: `src/services/config/index.ts`
- 新建: `src/__tests__/config-skill-resource-access.test.ts`

**执行步骤:**
- [x] 在类型文件中新增 Skill 返回类型
  - 位置: `src/services/config/types.ts` 的 Skill section
  - 新增:
    ```ts
    export interface SkillConfigRowWithAccess {
      id: string;
      userId: string;
      organizationId: string;
      name: string;
      description: string | null;
      contentPath: string | null;
      metadata: unknown;
      createdAt: Date;
      updatedAt: Date;
      resourceAccess: ResourceAccess;
    }
    export interface SkillSetOptions {
      publicReadable?: boolean;
    }
    ```
  - 原因: `listSkills`、`getSkill` 和上层 `src/services/skill.ts` 需要稳定类型承载 `resourceAccess`
- [x] 实现外部 skill 批量读取 helper
  - 位置: `src/services/config/skill.ts`，在 `listSkills()` 之前
  - 新增 `async function listExternalSkills(ctx: AuthContext)`，调用 `listReadableResourceRefs(ctx, "skill")`，用 `inArray(skill.id, ids)` 查询外部 rows，并按 id 过滤为引用中存在的记录
  - 原因: 权限 service 只返回引用，业务字段必须由 Skill service 读取
- [x] 改造 `listSkills(ctx)`
  - 位置: `src/services/config/skill.ts:listSkills()`
  - 逻辑: 查询内部 rows；查询外部 rows；合并时不按 name 去重；调用 `decorateResourceAccess(ctx, "skill", [...internal, ...external])`
  - 原因: 列表必须同时展示内部和外部同名 skill，并使用 `resourceAccess.resourceKey` 区分
- [x] 新增 `getSkillByResourceKey(ctx, resourceKey)`
  - 位置: `src/services/config/skill.ts`，放在 `getSkill()` 之后
  - 解析 `sourceOrganizationId/resourceUid`，按 `skill.id` 查询 row；调用 `canReadResource(ctx, "skill", row.id, row.organizationId)`；不可读返回 null；可读时用 `decorateResourceAccess` 包装单行
  - 原因: 前端和 Agent 配置需要稳定身份读取同名外部 skill
- [x] 改造 `getSkill(ctx, name)`
  - 位置: `src/services/config/skill.ts:getSkill()`
  - 逻辑: 先查内部 `organizationId + name`；查不到时读取 `listExternalSkills(ctx)` 并寻找 `name` 相等的第一条；命中后调用 `canReadResource` 并返回带 `resourceAccess` 的 row
  - 原因: 保留旧 name 入参兼容现有调用，同时支持外部资源详情
- [x] 改造 `upsertSkill(ctx, name, data, options)`
  - 位置: `src/services/config/skill.ts:upsertSkill()`
  - 签名改为 `upsertSkill(ctx, name, data, options: SkillSetOptions = {})`
  - 更新已有内部 skill 前调用 `assertInternalWritable(ctx, "skill", existing[0].id, ctx.organizationId)`；写入后当 `options.publicReadable !== undefined` 调用 `setPublicRead(ctx, "skill", ctx.organizationId, id, options.publicReadable)`
  - 原因: 公开开关通过原 set 入口更新，写操作只允许内部资源
- [x] 改造 `deleteSkill(ctx, name)`
  - 位置: `src/services/config/skill.ts:deleteSkill()`
  - 先通过改造后的 `getSkill(ctx, name)` 获取 row；未找到返回 false；调用 `assertInternalWritable(ctx, "skill", row.id, row.organizationId)`；再按 `skill.id` 删除
  - 原因: 对外部同名 skill 的删除请求必须拒绝，而不是误删内部同名资源
- [x] 从 `src/services/config/index.ts` 导出新增类型和函数
  - 位置: type export 和 function export 块
  - 导出 `SkillConfigRowWithAccess`、`SkillSetOptions`、`getSkillByResourceKey`
  - 原因: `src/services/config-pg.ts` 和上层 Skill 编排层需要兼容导出
- [x] 为 Skill 配置 service 编写单元测试
  - 测试文件: `src/__tests__/config-skill-resource-access.test.ts`
  - 测试场景:
    - 内部和外部同名 skill 同时出现在 `listSkills`，且 `resourceAccess.resourceKey` 不同
    - `getSkill(ctx, name)` 在无内部同名时返回外部授权 skill，`writable=false`
    - `upsertSkill(..., { publicReadable: true })` 调用 `setPublicRead` 创建公开授权
    - `deleteSkill` 遇到外部 row 抛 403，不删除任何 DB 行
  - 运行命令: `bun test src/__tests__/config-skill-resource-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Skill service 权限调用
  - `rg -n 'listReadableResourceRefs|decorateResourceAccess|setPublicRead|assertInternalWritable|getSkillByResourceKey' src/services/config/skill.ts`
  - 预期: 五类调用均存在
- [x] 运行 Skill 配置权限测试
  - `bun test src/__tests__/config-skill-resource-access.test.ts`
  - 预期: 测试通过

---

### Task 2: Skill 编排层和运行时读取接入来源字段

**背景:**
`src/services/skill.ts` 负责 PG 元数据与文件系统内容编排。当前它按 name 计算本地路径，外部 skill 必须读取源 row 的 `contentPath`，并在列表、详情、下载 token 中保留源组织。

**涉及文件:**
- 修改: `src/services/skill.ts`
- 修改: `src/routes/web/config/skills.ts`
- 修改: `src/services/launch-spec-builder.ts`
- 新建: `src/__tests__/skill-resource-access.test.ts`

**执行步骤:**
- [x] 扩展 `_deps.configPg` 使用的 Skill 方法
  - 位置: `src/services/skill.ts` 的 `_deps` 定义和 `_resetDeps()`
  - 确保 `_deps.configPg.getSkillByResourceKey` 可被测试注入和运行时调用
  - 原因: 上层详情读取需要支持稳定资源 key
- [x] 改造 `listSkills(ctx)`
  - 位置: `src/services/skill.ts:listSkills()`
  - 返回每个 row 的 `id`、`name`、`description`、`path`、`resourceAccess`；`path` 使用 `r.contentPath ?? skillContentPath(r.name)`，外部 row 保留源 `contentPath`
  - 原因: 前端需要 `resourceAccess` 判断只读和公开状态
- [x] 改造 `getSkill(ctx, nameOrResourceKey)`
  - 位置: `src/services/skill.ts:getSkill()`
  - 判断入参包含 `/` 时调用 `_deps.configPg.getSkillByResourceKey(ctx, nameOrResourceKey)`，否则调用 `_deps.configPg.getSkill(ctx, safeName)`
  - contentPath 使用 `meta.contentPath ?? skillContentPath(meta.name)`；返回对象中补齐 `resourceAccess`
  - 原因: 外部 skill 详情必须读取源路径，不复制到当前 team 目录
- [x] 改造 `setSkill(ctx, name, data)`
  - 位置: `src/services/skill.ts:setSkill()`
  - 从 `data` 解构 `publicReadable?: boolean`，传给 `_deps.configPg.upsertSkill(ctx, safeName, ..., { publicReadable })`
  - 原因: 原 Skill set API 承载公开开关
- [x] 改造 `deleteSkill(ctx, name)`
  - 位置: `src/services/skill.ts:deleteSkill()`
  - 删除 PG 前先 `const meta = await _deps.configPg.getSkill(ctx, safeName)`；当 `meta?.resourceAccess.writable === false` 时抛 403；删除文件系统时使用 `meta.contentPath` 推导源目录只处理内部资源
  - 原因: 外部 skill 只读，且不能删除源 team 文件
- [x] 改造 Skill 配置 route 的 set 入参
  - 位置: `src/routes/web/config/skills.ts:handleSet()`
  - `body.data` 类型增加 `publicReadable?: boolean`，调用 `setSkill(ctx, body.name, body.data)`；返回 `{ name, resourceAccess }`
  - 原因: 前端公开开关通过原 set 接口传入
- [x] 改造 LaunchSpec skill archive 路径
  - 位置: `src/services/launch-spec-builder.ts` 的 skills 循环
  - 将 `const archivePath = getSkillArchivePath(skillRoot, s.name)` 改为优先使用 `s.contentPath` 推导 archive 路径；新增 helper `resolveSkillArchivePath(row)`，内部 row 无 `contentPath` 时保留旧逻辑
  - 原因: 外部 skill 运行时要下载源 skill 当前 archive，不复制到当前 team
- [x] 为 Skill 编排层编写单元测试
  - 测试文件: `src/__tests__/skill-resource-access.test.ts`
  - 测试场景:
    - `listSkills` 透传内部 / 外部 `resourceAccess`
    - `getSkill(ctx, "org-b/skill-id")` 调用 `getSkillByResourceKey` 并读取源 `contentPath`
    - `setSkill` 携带 `publicReadable` 时传给 config service
    - `deleteSkill` 对 `resourceAccess.writable=false` 抛 403 且不调用文件删除
  - 运行命令: `bun test src/__tests__/skill-resource-access.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查 Skill 编排层透传来源字段
  - `rg -n 'resourceAccess|getSkillByResourceKey|publicReadable' src/services/skill.ts src/routes/web/config/skills.ts`
  - 预期: 列表、详情和 set route 均包含相关逻辑
- [x] 检查 LaunchSpec 使用 contentPath
  - `rg -n 'resolveSkillArchivePath|contentPath' src/services/launch-spec-builder.ts`
  - 预期: skills 循环中存在源路径解析
- [x] 运行 Skill 编排测试
  - `bun test src/__tests__/skill-resource-access.test.ts`
  - 预期: 测试通过

---

### Task 3: Skill 前端消费 resourceAccess

**背景:**
Skill 页面和 Agent 配置弹窗当前只按 `id/name` 渲染和操作。需要显示 Internal / External / Public 状态，外部资源隐藏写操作，并使用 `resourceAccess.resourceKey` 作为稳定 key。

**涉及文件:**
- 修改: `packages/sdk/src/types/schemas.ts`
- 修改: `web/src/types/config.ts`
- 修改: `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx`
- 修改: `web/src/pages/agent-panel/AgentFormDialog.tsx`
- 修改: `web/src/i18n/locales/en/skills.json`
- 修改: `web/src/i18n/locales/zh/skills.json`
- 修改: `web/src/i18n/locales/en/agents.json`
- 修改: `web/src/i18n/locales/zh/agents.json`
- 新建: `web/src/__tests__/skill-resource-access-flow.test.ts`

**执行步骤:**
- [x] 在 SDK 和前端类型中新增 `ResourceAccess`
  - 位置: `packages/sdk/src/types/schemas.ts` Config section；`web/src/types/config.ts` API 响应类型之前
  - 新增与后端一致的 `ResourceAccess` interface，并给 `SkillInfo`、`SkillDetail` 增加 `resourceAccess?: ResourceAccess`
  - 原因: UI 使用强类型判断来源和操作能力
- [x] 改造 `AgentSkillsPage` 的 `SkillInfo` 本地类型
  - 位置: `web/src/pages/agent-panel/pages/AgentSkillsPage.tsx` 文件顶部
  - 类型增加 `resourceAccess?: ResourceAccess`；新增 helper `getSkillKey(skill)` 返回 `skill.resourceAccess?.resourceKey ?? skill.id`
  - 原因: 同名内部 / 外部 skill 必须同时渲染
- [x] 改造 Skill 列表卡片操作
  - 位置: `AgentSkillsPage` 的 `AgentCardList`
  - `cardKey` 使用 `getSkillKey`；外部资源显示 `External` badge；内部公开显示 `Public` badge；内部未公开显示 `Internal` badge
  - 编辑、删除按钮仅在 `skill.resourceAccess?.writable !== false` 时显示；公开开关仅在 `skill.resourceAccess?.manageable === true` 时显示
  - 原因: 外部资源只读，member 不可管理公开状态
- [x] 实现 Skill 公开开关保存
  - 位置: `AgentSkillsPage` 的 renderCard 内部和 handler 区域
  - 新增 `handleTogglePublic(skill)`，调用 `skillConfigApi.set(skill.name, { description, content, metadata, publicReadable: !skill.resourceAccess?.publicReadable })`；先通过 `skillConfigApi.get(skill.resourceAccess?.resourceKey ?? skill.name)` 获取详情再提交
  - 原因: 原 set API 需要完整 content，公开开关通过原 Skill 接口实现
- [x] 改造 Skill 编辑详情读取
  - 位置: `AgentSkillsPage:handleOpenEdit()`
  - 调用 `skillConfigApi.get(skill.resourceAccess?.resourceKey ?? skill.name)`；外部资源不进入编辑弹窗
  - 原因: 支持同名资源稳定读取，保护外部资源
- [x] 改造 Agent 配置弹窗 Skill 选项
  - 位置: `web/src/pages/agent-panel/AgentFormDialog.tsx` 加载 `skillConfigApi.list()` 后的 map
  - skill option 类型增加 `resourceAccess`；展示 label 使用 `sourceOrganizationId/name`；选项 value 使用 `resourceAccess.resourceUid`
  - 原因: `agent_config_skill.skillId` 已存 skill uuid，外部 skill 可直接绑定源 skill id
- [x] 补充 i18n 文案
  - 位置: `web/src/i18n/locales/en/skills.json`、`zh/skills.json`、`en/agents.json`、`zh/agents.json`
  - 新增 `resource.internal`、`resource.external`、`resource.public`、`resource.makePublic`、`resource.makePrivate`、`resource.readOnly`
  - 原因: JSX 禁止硬编码用户可见字符串
- [x] 为 Skill 前端流程编写测试
  - 测试文件: `web/src/__tests__/skill-resource-access-flow.test.ts`
  - 测试场景:
    - 列表同时渲染内部和外部同名 skill，key 使用 `resourceAccess.resourceKey`
    - 外部 skill 不显示编辑 / 删除 / 公开开关
    - 内部 owner skill 显示公开开关，点击后调用 `/web/config/skills` 的 `set` action 并携带 `publicReadable`
    - AgentFormDialog skill 选项使用 skill uuid 作为提交值
  - 运行命令: `bun test web/src/__tests__/skill-resource-access-flow.test.ts`
  - 预期: 所有测试通过

**检查步骤:**
- [x] 检查前端无硬编码资源来源文案
  - `rg -n 'Internal|External|Public|Read-only|只读|公开' web/src/pages/agent-panel/pages/AgentSkillsPage.tsx web/src/pages/agent-panel/AgentFormDialog.tsx`
  - 预期: TSX 中无这些用户可见硬编码，均通过 `t()`
- [x] 检查 Skill 页面使用 resourceKey
  - `rg -n 'resourceKey|getSkillKey|publicReadable|manageable|writable' web/src/pages/agent-panel/pages/AgentSkillsPage.tsx`
  - 预期: 列表 key、按钮显示和公开开关均使用 `resourceAccess`
- [x] 运行 Skill 前端测试
  - `bun test web/src/__tests__/skill-resource-access-flow.test.ts`
  - 预期: 测试通过

---

### Task 4: Skill 权限接入验收

**前置条件:**
- 启动命令: 不需要启动服务；本计划通过 route/service/frontend 单元测试验证
- 测试数据准备: 使用 fetch mock 和 service stub 构造内部 / 外部 skill

**端到端验证:**

1. 运行完整测试套件确保无回归
   - `bun run precheck`
   - 预期: format、import 排序、tsc、biome check 全部通过
   - 失败排查: 检查 Task 1 类型导出、Task 3 i18n 和 TSX 类型

2. 验证 Skill 后端权限链路
   - `bun test src/__tests__/config-skill-resource-access.test.ts src/__tests__/skill-resource-access.test.ts`
   - 预期: 内部 / 外部列表、详情、公开开关、只读删除保护全部通过
   - 失败排查: 检查 Task 1 和 Task 2

3. 验证 Skill 前端体验
   - `bun test web/src/__tests__/skill-resource-access-flow.test.ts`
   - 预期: 来源 badge、按钮隐藏、公开开关和 Agent 选择器行为通过
   - 失败排查: 检查 Task 3

4. 验证前端生产构建
   - `bun run build:web`
   - 预期: Vite 构建成功，无 i18n / 类型 / 路由生成错误
   - 失败排查: 检查 Task 3 的 SDK 和 web 类型同步
