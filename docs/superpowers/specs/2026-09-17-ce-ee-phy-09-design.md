# CE / EE 阶段 1 PHY-09 设计：身份管理、观察与 ProdView 闭包迁移

## 目标与范围

PHY-09 是 CE 阶段 1 的一次物理迁移提交。它将根 `src/`、`web/` 中由下列三个完整业务闭包拥有的既有实现迁到对应 workspace 包：

- 身份与系统管理：组织、API Key、系统管理、`/api/system*` 和 branding。
- 观察运维：Observer、系统日志、人员树及其管理页面。
- ProdView：ProdView 服务、路由、页面与国际化资源。

目标是让这些闭包由最终 owner 唯一持有，同时逐项保持既有业务行为。此任务不迁移已属于 PHY-03 至 PHY-08 的 Environment、运行时、模型、Machine、Sandbox、Workflow、Scheduler、Channel 等遗留代码；也不承担 PHY-10 的全仓路径和交付收口。

## 物理归属与公开出口

新建以下三个浏览器与服务端分离的 workspace 包：

| 包 | 承接内容 |
| --- | --- |
| `@fenix/resource-identity-admin` | 组织与成员 repository/schema/service/route、控制台 API Key route、系统 API 与系统管理员初始化、branding 服务和 `/web/branding` route，以及专有前端页面、API client、i18n 与测试。 |
| `@fenix/resource-observer` | Observer provider、关系树、服务、schema、系统日志和人员树服务及 `/api/system-logs`、`/api/system-observer`、`/api/system-people-tree` routes，以及管理页面、专有组件、API client、i18n 与测试。 |
| `@fenix/resource-prod-view` | ProdView repository/schema/service、`/web/prod-views` 与既有配置 route，以及页面、API client、i18n 与测试。 |

每个包以 `src/server.ts` 导出服务端路由和被其他包实际消费的类型或服务；含前端实现的包使用独立 `web/` 入口。根入口不得 re-export 服务端模块，确保 `apps/web` 只能解析浏览器安全模块。

`apps/server/src/main.ts` 继续作为唯一 HTTP/WS 宿主，按现有顺序挂载迁移后的路由，并保持启动阶段的 `ensureSystemAdmin()` 调用。`apps/web` 继续持有路由与全局壳，只改为从包的浏览器路径导入。

## 合同与数据流

迁移使用源文件移动，允许的改动仅限 import、package export/dependency、测试路径、构建解析和宿主接线。不得改变数据库 schema、Drizzle SQL/meta、认证插件、权限判断、控制流或业务断言。

组织/API Key/系统 API 继续执行原有组织上下文、成员权限、错误映射与响应序列化。`model-management` 等已迁移调用方改从 `identity-admin` 的稳定服务端出口获取 `SystemApi*` 类型和 `ensureSystemAdmin()`，不得复制定义。

Observer 继续使用现有 provider 注册与关系树构造；三个系统观察接口保留 `systemApiKeyAuth`、原响应骨架和错误处理。ProdView 保持实例解析、授权及加载时序。branding 保持配置读取、logo 路径解析与缺失文件的 404 行为。

所有既有 `/web/*`、`/api/system*` 请求的 method、路径、header/query/body、鉴权顺序、状态码和 JSON 字段必须不变；前端 URL、文案、i18n key、loading/error/retry 状态保持不变。

## 失败处理、验证与交付

开始迁移前，为三个闭包分别运行现有最小专项测试并记录基线。迁移后复跑相同测试，运行受影响的 server typecheck 和前端生产构建；PHY-09 收口时执行 `bun run precheck`。若基线或收口检查失败，记录命令、失败证据和与本任务的关系，不以兼容层、fallback 或双写掩盖差异。

随源码移动现有测试，并仅更新 `apps/server` 测试 stub、已迁移包的导入与前端测试解析路径。仅在为迁移接线补足必需覆盖时新增测试，且不改变既有业务断言。

每轮规格和质量 review 写入未暂存的 PHY-09 review 记录。提交仅包含此三包的物理迁移、必要接线与测试路径；当每个被迁移源文件的旧位置 import 与运行入口均归零后删除该源文件。
