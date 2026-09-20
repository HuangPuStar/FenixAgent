# @fenix/resource-sandbox

沙盒资源池、沙盒实例生命周期与远程 Sandbox Cluster 管理协议的唯一 owner。

## 职责

- **资源池与实例**：`sandbox_pool` / `sandbox_instance` 的领域规则与状态机。`SandboxManager` 负责复用、配置快照、重建、删除与重启恢复；`SandboxRemoteReconciler` 负责外部副作用与并发协调（Provider 查询/创建/恢复/销毁、行锁、machine 路由与心跳释放）。两者由 `SandboxManager` 组合，测试可单独驱动协调器。
- **Provider 抽象**：`SandboxProviderRegistry` 与 `@fenix/sandbox-provider` 的具体实现。装配期由 `registerConfiguredSandboxProviders()` 按模块配置注册，模块加载期不发网络请求。
- **执行入口**：`SandboxExecutionHandler` 把一次执行请求解析为可用的沙盒实例，等待 Machine 回连后返回 `machine_id` 作为寻址节点。
- **远程 Cluster 管理**：`createSandboxClusterClient()` 在服务端附加 Cluster 凭据，浏览器不接触该凭据。
- **HTTP 交付物**：`/api/system/sandbox-pools`（含 `/:poolId`）、`/api/system/sandbox-instances`（含 `/:instanceId` 与 `/rebuild`）、`/api/system/sandbox-cluster`、`/api/system/sandbox-server` 与 `/web/config/sandbox-pools`；浏览器出口 `@fenix/resource-sandbox/web`（控制台页面与 API client）。
- **模块组合根**：`src/module.ts` 的 `createSandboxModule()` 返回进程级单例（`providers` / `manager` / `executions`），`fenix.module.ts` 是它的惰性描述符。

## 依赖边界

本包属 `resources` 类别。依赖矩阵（`scripts/lib/architecture-boundary-rules.ts`）禁止 `resources → platform-impl`：

- **不得**导入 `@fenix/identity/*` 或 `@fenix/access-control/*`；需要的身份数据只能经 `@fenix/platform-sdk` 的 `IdentityDirectory` 窄契约取得；
- 其它资源包只经对方包根入口引用。本包使用 `@fenix/resource-machine/server` 的机器身份、回连状态与路由释放能力，不引用其 `src/**`；
- `apps/server` 是唯一合法装配者（装配 provider、初始化默认池、挂载路由）。

## 守卫由宿主注入

`authGuardPlugin` / `systemApiGuardPlugin` **不是**本包的导出。Elysia 的 `macro` / `state` 是实例作用域的，父实例无法向已构造的子实例回填；而守卫必须与宿主的认证解析（含 `setTestAuth` 测试 seam 与组织上下文）是同一份实例——两份同名实例会被 Elysia 按 plugin `name` 去重，导致先构造的一方静默生效。

因此所有路由以**工厂**形式导出，由宿主注入守卫：

```ts
import {
  createApiSandboxRoutes,
  createApiSandboxClusterRoutes,
  createApiSandboxServerRoutes,
  createWebSandboxPoolsRoutes,
} from "@fenix/resource-sandbox/server";

const apiSandbox = createApiSandboxRoutes({ systemApiGuardPlugin: systemApiAuthPlugin });
const webSandboxPools = createWebSandboxPoolsRoutes({ authGuardPlugin });
```

包内用例注入 `src/__tests__/guard-stubs.ts` 的替身（只提供工厂注册路由所必需的 `error` 装饰器与同名宏）；「路由 + 真实守卫 + `RCS_SYSTEM_API_KEYS`」这条已发布合同的覆盖归 §1.5 的宿主用例，本包不重复断言（替身放行不等于合同已验）。

## 配置与 DB

本包不读 `process.env`、不读 `.env`，也不导入 `apps/server`：

- DB 经 `getSandboxDatabase()`（`@fenix/platform-sdk/server` 的 `getDatabase()`），类型是 `NodePgDatabase<Record<string, never>>`——不耦合宿主的 schema 聚合，表定义迁出时只改这一个文件；
- 部署配置经 `getSandboxConfig()`（`getModuleConfig("sandbox")`），值由宿主从 `apps/server/src/env.ts` 已校验的 env 构造；
- **读取必须发生在调用时**：模块加载期宿主可能尚未完成基础设施初始化，因此在函数内取句柄，不在模块作用域取；
- `src/server/repositories/**` 是唯一数据访问点：`src/routes/**` 与 `src/server/services/**` 不得直接取 DB 句柄或表对象。

`envDefinitions` 与 preflight 收敛在任务 1.7 处理。

## 边界外的已知项

- **表定义仍在宿主**：`@server/db/schema` 的导入是本包唯一的宿主内部依赖（repository 与类型标注），迁出归 §1.7；`sandbox-instance-snapshot.ts` 只从快照 JSON 重建配置，不感知表结构。
- **`dependsOn: ["machine"]` 与 machine 侧的反向边**：本包生产代码静态导入 `@fenix/resource-machine/server` 的公开入口（创建沙盒机器、机器在线判定、释放机器 runtime、机器归属查询），两者必须成套启用，方向与 §2.3 固定的 `sandbox → machine` 一致，workspace 依赖已在 `package.json`。machine 侧的反向边（`machine → sandbox`）已由架构台账登记为 `special-dependency`（owner 1.4，removeWhen：machine 不再依赖 sandbox），属于必须消除的越界边，因此 machine 不声明本模块：把这条边写进 `dependsOn` 会被生成器以「已由架构台账登记为越界边，不能编码成装配依赖」拒绝，两个模块同时启用时装配顺序也会因循环失败。
- **未声明 `contributions` 与 `web`**：消费方是 §1.5 的宿主挂载与 §1.6 的 WebShell 装配，形状需与消费端同时定型；当前宿主按显式调用装配，不形成第二套装配路径。
- **`restart` 不持有行锁**：它只复用已存在的 Provider 资源、不创建新资源，与 `recover`（锁内重建）的并发边界不同；若将来 `restart` 需要创建资源，必须一并纳入锁内。
