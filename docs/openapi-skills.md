# Skill OpenAPI 设计方案

## 背景

目前 Skill 的 CRUD 全部通过 `POST /config/skills`（控制台内部 API）的 `action` 字段分发。需要为这四个操作提供对外的 RESTful OpenAPI 接口，供外部系统通过 API Key 调用。

## 路由表

| 方法 | 路径 | 说明 | 后端编排层函数 |
|------|------|------|---------------|
| `GET` | `/api/skills` | 分页列表 | `listSkills(ctx)` → `SkillInfo[]` |
| `GET` | `/api/skills/{name}` | 详情（含 content） | `getSkill(ctx, name)` → `SkillDetail \| null` |
| `PUT` | `/api/skills/{name}` | 上传/替换（创建或覆盖） | `setSkill(ctx, name, data)` → `SkillInfo` |
| `DELETE` | `/api/skills/{name}` | 删除 | `deleteSkill(ctx, name)` → `boolean` |

**不暴露**：
- 批量上传（`importSkillDirectories`）—— 导入协议复杂（multipart + manifest），由控制台内部 API 承接
- 下载 zip 压缩包 —— 控制台内部专用接口

### 设计理由

- **`PUT` 替代 `POST`**：Skill 通过 `name` 天然可作为主键标识，`PUT /api/skills/{name}` 语义明确（幂等），既支持创建（name 不存在时 upsert）也支持替换更新。一套逻辑，两个场景。
- **不用 `POST /api/skills` 创建**：创建时 name 在路径上，与更新同一条路。省掉一个 `POST` 创建路由，避免“name 只能在 body 还是 path”的分歧。
- **主键用 name 而非 ID**：Skill 对外是配置资源，name 是唯一稳定标识（`idx_skill_org_name` 唯一约束），外部系统基于名称引用更自然。Agent 的 OpenAPI 用 ID 是因为 Agent name 允许修改，而 Skill name 不可变。

## 认证

沿用项目现有 OpenAPI 认证策略：`sessionAuth: true`。

```
请求 → authGuardPlugin
         ├─ Cookie Session（浏览器场景）→ 加载用户 + 组织上下文
         └─ API Key（rcs_xxx）→ 加载关联用户 + 组织上下文
```

外部调用方通过 `Authorization: Bearer rcs_xxx` header 传递 API Key。

与前端 `/web/*` 接口的区别：路径前缀 `/api/*` 会使路由落入 `EXTERNAL_OPENAPI_TAGS`，在 Scalar 上展示在 External API 而非 Web API 文档中。

## 新增文件

```
src/schemas/api-skill.schema.ts    — Zod 请求/响应 schema
src/routes/api/skills.ts           — Elysia 路由
```

## Schema 定义（`src/schemas/api-skill.schema.ts`）

### ApiSkillListQuery

```typescript
z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
```

### ApiSkillNameParams

```typescript
z.object({
  name: z.string().min(1).max(64),
})
```

### ApiSkillUpsertBody

```typescript
z.object({
  description: z.string().nullable().optional(),
  content: z.string().min(1),
  metadata: z.record(z.string(), z.string()).optional(),
  publicReadable: z.boolean().optional(),
})
```

### ApiSkillListItem

```typescript
z.object({
  name: z.string(),
  description: z.string(),
  resourceAccess: AgentResourceAccessSchema.optional(),
})
```

### ApiSkillDetail

```typescript
z.object({
  name: z.string(),
  description: z.string(),
  content: z.string(),
  metadata: z.record(z.string(), z.string()),
  resourceAccess: AgentResourceAccessSchema.optional(),
})
```

### ApiSkillListResponse

```typescript
z.object({
  items: z.array(ApiSkillListItem),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
})
```

### ApiSkillDeleteResponse

```typescript
z.object({
  name: z.string(),
  deleted: z.literal(true),
})
```

## 路由实现（`src/routes/api/skills.ts`）

### 结构模板

```typescript
import Elysia from "elysia";
import { authGuardPlugin } from "../../plugins/auth";
import {
  ApiSkillListQuerySchema,
  ApiSkillNameParamsSchema,
  ApiSkillUpsertBodySchema,
  ApiSkillListResponseSchema,
  ApiSkillDetailSchema,
  ApiSkillDeleteResponseSchema,
} from "../../schemas/api-skill.schema";
import { listSkills, getSkill, setSkill, deleteSkill } from "../../services/skill";

const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

const app = new Elysia({ name: "api-skills", prefix: "/api/skills" })
  .use(authGuardPlugin)
  .model({
    "api-skill-list-query": ApiSkillListQuerySchema,
    "api-skill-name-params": ApiSkillNameParamsSchema,
    "api-skill-upsert-body": ApiSkillUpsertBodySchema,
    "api-skill-list-response": ApiSkillListResponseSchema,
    "api-skill-detail": ApiSkillDetailSchema,
    "api-skill-delete-response": ApiSkillDeleteResponseSchema,
  });

// GET /api/skills
app.get("/", ...)

// GET /api/skills/:name
app.get("/:name", ...)

// PUT /api/skills/:name
app.put("/:name", ...)

// DELETE /api/skills/:name
app.delete("/:name", ...)

export default app;
```

### 每个路由的 handler 要点

**GET /api/skills** — 分页列表
1. 从 query 取 `page`、`pageSize`
2. 调 `listSkills(ctx)` 获取该组织所有 skill
3. 按分页切片 `slice((page-1)*pageSize, page*pageSize)`
4. 返回 `{ items, total, page, pageSize }`
5. 数据映射：`SkillInfo` → `ApiSkillListItem`（取出 `name`, `description`, `resourceAccess`）

**GET /api/skills/:name** — 详情
1. 调 `getSkill(ctx, name)`
2. 不存在返回 404
3. 返回 `ApiSkillDetail`（含 `content` + `metadata`）

**PUT /api/skills/:name** — 上传/替换
1. body 必填：`content`；可选：`description`、`metadata`、`publicReadable`
2. 调 `setSkill(ctx, name, data)`，底层 upsert：
   - name 不存在 → 创建（PG + 文件系统同步写入）
   - name 存在 → 覆盖（备份旧版 → 写入新版）
3. 返回 `{ name, resourceAccess }`
4. 错误映射：`VALIDATION_ERROR` → 400

**DELETE /api/skills/:name** — 删除
1. 调 `deleteSkill(ctx, name)`
2. 返回 404 如果不存在
3. 返回 `{ name, deleted: true }`

## OpenAPI 文档

### 注册到 External OpenAPI

在 `src/index.ts` 中：

1. 导入 `apiSkillsRoutes`
2. `.use(apiSkillsRoutes)` 挂载（紧挨 `.use(apiAgentsRoutes)`）
3. 在 `EXTERNAL_OPENAPI_TAGS` 追加 tag：

```typescript
{
  name: "External Skill",
  description: "面向外部系统的 Skill 配置 CRUD 接口。",
}
```

### 路由 detail 元数据（中文描述）

```typescript
detail: {
  tags: ["External Skill"],
  summary: "获取 Skill 列表",
  description: "返回当前组织内的 Skill 配置列表，采用稳定分页结构。",
}
```

每个路由都要补全 `params`、`query`、`body`、`response` 模型声明和 `summary`/`description`。

## 错误码约定

| HTTP | code | 场景 |
|------|------|------|
| 400 | `VALIDATION_ERROR` | content 为空、name 不合法 |
| 404 | `NOT_FOUND` | skill 不存在（get / delete） |
| 401 | `UNAUTHORIZED` | API Key 无效或过期 |
| 500 | `INTERNAL_ERROR` | 后端异常 |

错误响应统一：

```json
{
  "error": {
    "code": "<ERROR_CODE>",
    "message": "错误描述"
  }
}
```

## 关键风险 & 注意事项

### 1. setSkill 的写入时序
`setSkill()` 内部逻辑：写文件 → 建 archive → 写 PG。文件写入成功后 PG 写入前如果崩溃，会出现文件系统有残留但 PG 无记录的情况。当前 `setSkill` 已有失败回滚（`cleanupWrittenSkills` + `restoreFromBackup`），OpenAPI 路由直接复用即可。

### 2. skill name 校验
`assertValidSkillName` 会阻止空名称、`.`、`..`、含 `/` 或 `\` 的名称。OpenAPI 路由在调用 service 前应额外校验 path param 合法性，提前返回 400。

### 3. API Key 认证 vs Session 认证
当前 `authGuardPlugin` 的 `sessionAuth: true` 同时支持 Cookie Session 和 API Key。外部 OpenAPI 调用方应优先使用 API Key，但这不需要在路由层区分，auth plugin 自动处理。

### 4. 没有分布式锁
`setSkill` 和 `deleteSkill` 写入无分布式锁。短期看这不是问题，因为 Skill 编辑频率低；未来如果多个外部系统同时操作同一个 skill，可能产生竞态。当前阶段不做额外处理，CLAUDE.md 已有记录。

## 实施步骤

1. 创建 `src/schemas/api-skill.schema.ts`（schema + 类型导出）
2. 创建 `src/routes/api/skills.ts`（路由 + handler）
3. 在 `src/index.ts` 中注册路由 + tag
4. 写后端集成测试（参考 `src/__tests__/agent-openapi.test.ts` 的模式）
5. 跑 `bun run precheck` 验证

估计改动量：约 250-300 行（schema ~80 行 + 路由 ~180 行 + index.ts ~8 行）。
