# Plan 11：Team 取代 User 成为资源所有者

## Context

当前 User 是所有资源的所有者，每条记录带 `userId`，用户之间完全隔离。需要将 Team 作为资源所有权单位，User 通过 Team 成员身份获得资源访问权。

## 现状分析

### 当前资源所有权模式

- 所有资源表使用 `userId` 列（`references user.id`）
- `config-pg.ts` 中 56+ 处 `WHERE user_id = ?` 查询
- 路由层从 `store.user.id` 获取 userId
- 用户之间完全隔离，无资源共享

### 已有设计文档

`docs/arch/15-team-permissions-design.md` 包含详细的三阶段实施计划。

### 涉及文件（改动量最大）

**数据库**：

| 文件 | 改动 |
|------|------|
| `src/db/schema.ts` | 新增 `team`、`team_member` 表；所有资源表新增 `teamId` |
| `src/db/migrations/` | 大量迁移文件 |

**后端服务**：

| 文件 | 改动 |
|------|------|
| `src/services/config-pg.ts` | 所有函数 `userId` → `teamId`（56+ 处） |
| `src/services/instance.ts` | spawn 时使用 teamId |
| `src/services/session.ts` | session 查询使用 teamId |
| `src/services/task.ts` | task 查询使用 teamId |
| `src/services/skill.ts` | skill 查询使用 teamId |
| `src/services/environment.ts` | environment 查询使用 teamId |
| `src/auth/better-auth.ts` | session 存储 activeTeamId |
| `src/auth/middleware.ts` | 验证 team 成员身份 |

**后端路由**：

| 文件 | 改动 |
|------|------|
| 所有 `src/routes/web/*.ts` | `store.user.id` → `store.teamId` |
| `src/routes/web/teams.ts` | 新增团队管理路由 |

**前端**：

| 文件 | 改动 |
|------|------|
| `web/src/pages/` | 所有页面 API 调用适配 teamId |
| `web/src/components/shell/Sidebar.tsx` | 新增团队切换器 |
| `web/src/pages/TeamsPage.tsx` | 新增团队管理页面 |
| `web/src/api/client.ts` | API client 适配 |

## 具体实施步骤

### Step 1：数据库 Schema

```sql
-- 新增 Team 表
CREATE TABLE team (
  id UUID PRIMARY KEY,
  name VARCHAR NOT NULL,
  slug VARCHAR NOT NULL UNIQUE,
  created_by UUID NOT NULL REFERENCES user(id),
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ
);

-- 新增 Team 成员表
CREATE TABLE team_member (
  id UUID PRIMARY KEY,
  team_id UUID NOT NULL REFERENCES team(id),
  user_id UUID NOT NULL REFERENCES user(id),
  role VARCHAR NOT NULL DEFAULT 'member', -- owner/admin/member
  joined_at TIMESTAMPTZ,
  UNIQUE(team_id, user_id)
);

-- 所有资源表新增 teamId
ALTER TABLE environment ADD COLUMN team_id UUID REFERENCES team(id);
-- ... 13 张表类似操作
```

### Step 2：数据迁移

- 为每个现有 User 自动创建"个人团队"
- 将所有资源的 `userId` 对应到个人团队的 `teamId`
- 过渡期两列并存

### Step 3：认证层

```typescript
// src/auth/better-auth.ts
// session 新增 activeTeamId 字段
// 登录后自动选择个人团队

// src/auth/middleware.ts
// sessionAuth 中间件从 session 读取 activeTeamId
// 验证用户是否为 activeTeam 成员
```

### Step 4：服务层迁移

```typescript
// src/services/config-pg.ts
// 所有函数签名：(userId, ...) → (teamId, ...)
// 所有查询：WHERE user_id = ? → WHERE team_id = ?
```

### Step 5：路由层迁移

```typescript
// 所有 web 路由
// const userId = store.user.id → const teamId = store.teamId
```

### Step 6：团队管理功能

- 新增 `/web/teams` 路由：CRUD + 成员管理
- 前端团队切换器（Sidebar）
- 团队管理页面（成员列表、角色管理、邀请链接）

### Step 7：权限控制

- owner：所有权限
- admin：读写资源、管理成员（不能移除 owner）
- member：读资源、写自己创建的资源

## 实施策略

### 分阶段（参考 `15-team-permissions-design.md`）

**Phase 1：Schema + 个人团队**（最小可行）
- 新增 team/team_member 表
- 所有资源表新增 teamId
- 迁移数据到个人团队
- 认证层支持 activeTeamId

**Phase 2：团队管理 UI**
- 团队切换器
- 团队创建/邀请
- 成员管理

**Phase 3：权限控制**
- 角色权限检查
- 资源写权限控制
- API Key 团队级管理

## 验证方式

```bash
# 单元测试
bun test src/__tests__/

# 集成验证
bun run dev
# 1. 注册新用户，自动创建个人团队
# 2. 资源列表按团队过滤
# 3. 创建团队、邀请成员
# 4. 切换团队，资源列表变化
# 5. 成员角色权限验证
```

## 依赖关系

- **改动量最大**，建议最后实施
- 可以在 Plan 02-10 完成后统一迁移
- 或者先完成 Phase 1（Schema + 个人团队），Phase 2-3 在后续迭代中实施
- 如果其他 Plan 已经在做 userId → teamId 迁移，可以合并
