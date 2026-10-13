# @fenix/identity

身份、组织、成员、认证与 API Key 的唯一 owner。

## 职责

- **身份表**：`user` / `session` / `account` / `verification` / `organization` / `member` / `invitation` / `apikey` / `user_config` 的 schema 真相来源（`db/schema.ts`）。其余模块只导入这里的表对象表达外键，不复制定义。
- **认证**：better-auth 实例（惰性单例）、可信来源推导、请求认证解析（session cookie → Environment Secret → API Key）与系统管理员启动引导。
- **组织与成员**：`/web/organizations`、`/web/api-keys` 控制台接口，以及 `/api/system/*` 系统管理接口。
- **身份目录**：`IdentityDirectory` 的实现，供模块间只读读取身份数据。

## 依赖边界

本包属 `platform-impl`。依赖矩阵（`scripts/lib/architecture-boundary-rules.ts`）禁止 **任何** 其它类别依赖 `platform-impl`：

- 资源模块与 `agent-runtime` **不得**导入 `@fenix/identity/server`；
- 它们需要的身份数据只能经 `@fenix/platform-sdk` 的 `IdentityDirectory` 窄契约取得，实现由宿主 `apps/server` 在装配时用 `registerIdentityDirectory()` 注入；
- `apps/server` 是唯一的合法消费者（`apps-server → platform-impl` 未受限）。

`access-control` 也属 `platform-impl`，因此它可以依赖本包；反向依赖（`identity → access-control`）在设计上被禁止——类别矩阵只覆盖跨类别方向，同类别内部的方向由 `scripts/lib/architecture-boundary-rules.ts` 的 `FORBIDDEN_PACKAGE_DEPENDENCIES` 逐条列出，`["@fenix/identity", "@fenix/access-control"]` 自任务 1.2 起在列。新增平台包之间的方向必须同时改这里，不能依赖人工约定。

## 不导出认证守卫

`/web/*` 的 `authGuardPlugin` **不是**本包的导出。Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；而守卫必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与 ALS 增强）是同一份实例——两份同名实例会被 Elysia 按 plugin `name` 去重，导致先构造的一方静默生效。

因此 `/web/*` 与 `/api/system/*` 路由以**工厂**形式导出，由宿主注入守卫：

```ts
import { createWebOrganizationsRoutes } from "@fenix/identity/server";

const webOrganizations = createWebOrganizationsRoutes({ authGuardPlugin, systemApiGuardPlugin });
```

## 配置与 DB

本包不读 `process.env`、不读 `.env`，也不导入 `apps/server`：

- DB 经 `getIdentityDatabase()`（`@fenix/platform-sdk/server` 的 `getDatabase()`）；
- 部署配置经 `getIdentityConfig()`（`getModuleConfig("identity")`），值由宿主从 `apps/server/src/env.ts` 已校验的 env 构造。

`envDefinitions` 与 preflight 收敛在任务 1.7 处理。

## 边界外的已知项

- `user_config` 表放在本包（它外键 `user`），但它描述的是组织级 Agent/模型偏好，不是身份数据。消费者（`apps/server/src/services/config/user-config.ts`）在宿主内，未越过包边界。是否迁到独立 owner 由后续任务评估。
