# Feature: 20260517_F001 - team-layer

## 需求背景

当前 RCS 所有资源（Provider、Model、Agent、Skill、MCP、会话等）按 `userId` 隔离，用户之间无法共享任何配置或数据。系统缺少「团队」这一组织层级，导致：

1. **无法多人协作**：多个用户无法共享同一套 Agent 配置、Provider 密钥等
2. **无法工作区分组**：单用户无法按项目/团队维度组织资源
3. **无角色管理**：没有 owner/admin/member 概念，无法做权限区分

数据库 schema 已有 `team` 和 `team_member` 两张表（含迁移文件），设计文档（`docs/arch/15-team-permissions-design.md`）已完成，但零实现代码。

## 目标

- 为系统添加 Team 层级，使资源所有权从 `userId` 转移到 `teamId`
- 支持多用户协作：团队成员共享所有���源（配置、Agent、会话等）
- 支持工作区分组：同一用户可加入多个团队，按需切换
- 简化权限模型：所有角色共享读写资源，仅团队管理操作（成员/角色/删除）受限
- 前端 Sidebar 顶部添加团队切换器 + 独立一级团队管理页面

## 方案设计

### 1. 数据模型

#### 1.1 已有表（无需变更）

```sql
-- team 表（已存在于 src/db/schema.ts）
team (
  id UUID PK DEFAULT gen_random_uuid(),
  name VARCHAR NOT NULL,
  slug VARCHAR NOT NULL UNIQUE,
  description TEXT,
  created_by TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)

-- team_member 表（已存在于 src/db/schema.ts）
team_member (
  id UUID PK DEFAULT gen_random_uuid(),
  team_id UUID NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role VARCHAR(20) NOT NULL DEFAULT 'member',  -- owner | admin | member
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(team_id, user_id)
)
```

#### 1.2 资源表变更（13 张表加 teamId）

需要加 `teamId` 列的表：

| 表名 | teamId 类型 | 说明 |
|------|-------------|------|
| `provider` | NOT NULL | 直接关联 |
| `agentConfig` | NOT NULL | 直接关联 |
| `mcpServer` | NOT NULL | 直接关联 |
| `skill` | NOT NULL | 直接关联 |
| `userConfig` | NOT NULL | 直接关联 |
| `apiKey` | NOT NULL | 直接关联 |
| `scheduledTask` | NOT NULL | 直接关联 |
| `environment` | NOT NULL | 直接关联 |
| `model` | 不加列 | 通过 provider.teamId 间接关联 |

teamId 列定义（Drizzle schema）：
```typescript
teamId: uuid("team_id").notNull().references(() => team.id, { onDelete: "cascade" }),
```

#### 1.3 AuthContext 对象

贯穿服务层的统一认证上下文：

```typescript
interface AuthContext {
  teamId: string;                                    // 当前活跃团队 ID
  userId: string;                                    // 当前用户 ID
  role: "owner" | "admin" | "member";                // 当前团队角色
}
```

替代原有的散参数 `(userId, ...)`，所有服务层函数签名统一为 `(ctx: AuthContext, ...)`。

### 2. 权限模型

采用简化版权限：**资源读写全员开放，管理操作受限**。

| 操作 | owner | admin | member |
|------|-------|-------|--------|
| 查看团队资源 | ✅ | ✅ | ✅ |
| 创建/编辑/删除资源 | ✅ | ✅ | ✅ |
| 添加/移除成员 | ✅ | ✅ | ❌ |
| 修改角色 | ✅ | ❌ | ❌ |
| 删除团队 | ✅ | ❌ | ❌ |
| 修改团队信息 | ✅ | ✅ | ❌ |

### 3. 后端 API

#### 3.1 团队管理路由（新增 `src/routes/web/teams.ts`）

统一 POST + action 分发模式，与其他 web 路由一致：

| action | 说明 | 权限 |
|--------|------|------|
| `list` | 列出我加入的团队 | 任何已登录用户 |
| `get` | 获取团队详情（含成员列表） | 团队成员 |
| `create` | 创建团队，创建者为 owner | 任何已登录用户 |
| `update` | 更新团队名称/描述 | owner/admin |
| `delete` | 删除团队 | owner only |
| `switch` | 切换当前活跃团队 | 团队成员 |
| `list-members` | 列出团队成员（含角色） | 团队成员 |
| `add-member` | 添加成员（by userId/email） | owner/admin |
| `remove-member` | 移除成员 | owner/admin |
| `update-role` | 修改成员角色 | owner only |
| `get-current` | 获取当前活跃团队 + 角色 | 任何已登录用户 |

请求/响应格式遵循现有 config API 规范：
```jsonc
// 请求
{ "action": "create", "name": "前端团队", "slug": "frontend" }

// 响应
{ "success": true, "data": { "id": "...", "name": "前端团队", "role": "owner" } }
```

#### 3.2 现有路由改动

所有 `src/routes/web/*.ts` 的 handler 统一改动模式：

```typescript
// Before
const userId = store.user!.id;
const result = await someService(userId, ...args);

// After
const ctx = store.authContext!;
const result = await someService(ctx, ...args);
```

涉及路由文件：`config.ts`、`environments.ts`、`sessions.ts`、`files.ts`、`tasks.ts`、`channels.ts`、`apikeys.ts`、`knowledge.ts` 等。

#### 3.3 服务层改动

**新增 `src/services/team.ts`**：
- `createTeam(ctx, name, slug, description)` — 创建团队
- `ensurePersonalTeam(userId)` — 注册时自动创建个人团队
- `switchTeam(userId, teamId)` — 更新 session 的 activeTeamId
- `addMember(ctx, targetUserId, role)` — 添加成员
- `removeMember(ctx, targetUserId)` — 移除成员
- `updateRole(ctx, targetUserId, newRole)` — 修改角色（仅 owner）
- `getAuthContext(userId, sessionId)` — 从 session 读取 activeTeamId + 查角色
- `listMyTeams(userId)` — 列出我加入的所有团队

**改动 `src/services/config-pg.ts`**（最大改动点，56 处）：
- 函数签名：`(userId: string, ...)` → `(ctx: AuthContext, ...)`
- 查询条件：`WHERE user_id = ?` → `WHERE team_id = ?`
- 创建资源时：自动填 `teamId = ctx.teamId`

**其他服务文件**：`instance.ts`、`session.ts`、`task.ts`、`skill.ts`、`environment.ts` — 同样适配 AuthContext。

#### 3.4 认证层改动

**`src/plugins/auth.ts`**：
- 认证成功后，从 session 读取 `activeTeamId`
- 查询 `team_member` 获取角色
- 组装 `AuthContext` 存入 `store.authContext`
- 若 `activeTeamId` 不存在，自动创建个人团队并设置为活跃

**`src/auth/better-auth.ts`**：
- Session schema 扩展 `activeTeamId` 字段（使用 better-auth 的 session 扩展机制）

### 4. 前端设计

#### 4.1 Sidebar 团队切换器

改造 `Sidebar.tsx` 顶部品牌区域：

```
┌──────────────────────────────────┐
│ [👥 个人团队 ▾]         [≡]     │  ← 左：团队切换器  右：收起按钮
│ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─  │
│ 控制台                           │
│ ├ 概览                          │
│ ├ 团队            ← 新增一级    │
│ ├ 智能体                        │
│ ├ ...                           │
└──────────────────────────────────┘
```

点击切换器 → 下拉菜单：
- 已加入团队列表（当前团队带 ✓）
- 「+ 创建团队」按钮
- 菜单底部：「管理团队 →」跳转到团队管理页

切换团队后：
1. 调用 `POST /web/teams action=switch`
2. 刷新页面，所有数据重新加载（新团队上下文）

#### 4.2 团队管理页面（新增 `web/src/pages/TeamsPage.tsx`）

独立一级页面，Sidebar 导航新增「团队」条目。

**布局**：左右分栏

左侧 — 团队列表：
- 我加入的团队（显示角色 badge）
- 「+ 创建团队」按钮
- 选中团队高亮

右侧 — 团队详情面板：
- 团队名称 + slug + 描述（可编辑，owner/admin）
- 成员列表（头像 + 名称 + 角色badge + 操作按钮）
  - owner/admin：可添加/移除成员
  - owner only：可修改角色
- 危险区域：删除团队（owner only，需二次确认）

创建团队弹窗：
- 名称（必填）
- Slug（自动从名称生成，可手动修改）
- 描��（��选）

#### 4.3 全局 AuthContext 状态

- App 启动时调用 `POST /web/teams?action=get-current` 获取当前团队信息
- 存入 React Context（`TeamContext`），全局可用
- 提供 `team`、`role`、`teams`（我加入的所有团队）、`switchTeam()` 等
- 切换团队后 context 更新 + 页面数据刷新

#### 4.4 其他页面适配

因为后端根据 session 中的 `activeTeamId` 自动过滤，前端大多数页面无需改动：
- 配置页（Models、Agents、Skills 等）自动显示当前团队的资源
- Dashboard、会话页、环境页自动按团队过滤
- API client 无需显式传 teamId

### 5. 新用户注册

注册流程追加一步：
1. better-auth 注册成功
2. 调用 `ensurePersonalTeam(userId)` 创建个人团队
3. session 中设置 `activeTeamId = 个人团队ID`

## 实现要点

### 关键技术决策

1. **AuthContext 封装**：用 `{ teamId, userId, role }` 对象替代散参数，避免传错，便于后续扩展
2. **model 表不加 teamId**：通过 JOIN provider 间接关联，减少冗余列
4. **better-auth session 扩展**：使用 better-auth 插件机制或自定义 session 列存储 activeTeamId
5. **团队切换原子性**：switch 操作更新 session + 返回新 AuthContext，前端一次性刷新

### 难点

1. **config-pg.ts 56 处改动**：最大改动量，需逐个函数审查并修改签名和查询
2. **前端状态同步**：切换团队后所有缓存数据失效，需统一刷新机制

### 涉及文件清单

**新增文件**：
- `src/services/team.ts` — 团队 CRUD + 成员管理
- `src/routes/web/teams.ts` — 团队 API 路由
- `web/src/pages/TeamsPage.tsx` — 团队管理页面
- `web/src/components/TeamSwitcher.tsx` — 团队切换器组件
- `web/src/contexts/TeamContext.tsx` — 团队状态 Context

**改动文件**：
- `src/db/schema.ts` — 13 张表加 teamId
- `src/db/index.ts` — 建表语句同步
- `src/plugins/auth.ts` — AuthContext 加载
- `src/auth/better-auth.ts` — session 扩展 activeTeamId
- `src/services/config-pg.ts` — 56 处函数签名 + 查询改动
- `src/services/instance.ts` — 适配 AuthContext
- `src/services/session.ts` — 适配 AuthContext
- `src/services/task.ts` — 适配 AuthContext
- `src/services/skill.ts` — 适配 AuthContext
- `src/services/environment.ts` — 适配 AuthContext
- `src/routes/web/*.ts` — 所有 web 路由 handler
- `web/src/components/shell/Sidebar.tsx` — 团队切换器 + 新增导航
- `web/src/App.tsx` — TeamContext provider + 路由
- `web/src/api/client.ts` — 团队 API 调用

## 约束一致性

（spec/global/ 目录不存在，此节省略）

## 验收标准

- [ ] 新注册用户自动创建个人团队，session 中有 activeTeamId
- [ ] Sidebar 顶部显示团队切换器，可切换团队
- [ ] 团队管理页面：创建/编辑/删除团队，管理成员和角色
- [ ] 切换团队后，所有配置页（Provider/Model/Agent/Skill/MCP 等）显示对应团队的资源
- [ ] 多用户加入同一团队后，能看到团队内所有资源
- [ ] owner/admin 可管理成员（添加/移除），owner 可修改角色
- [ ] member 不能管理成员/角色/删除团队
- [ ] 所有角色都能读写团队内的所有资源
- [ ] `bun test src/__tests__/` 所有测试通过
- [ ] `bun run typecheck` 类型检查通过
