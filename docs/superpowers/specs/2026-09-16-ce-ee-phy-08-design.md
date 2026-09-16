# CE-EE 阶段 1 PHY-08：Workflow、任务与 Channel 物理迁移设计

## 目标与范围

PHY-08 以一个可回滚的功能闭包提交，将根 `src/`、`web/` 中仍归属 Workflow、任务和 Channel 管理的现有实现迁入最终资源 owner。改动仅限源文件重定位及必要的 import、workspace exports/依赖、测试/构建接线和宿主装配调整；既有协议、权限、数据、控制流和页面体验保持不变。

本任务覆盖 Workflow definitions/versions/runs、YAML/FS、节点执行编排、运行事件/SSE、Webhook trigger、Scheduler、task-v2、HTTP/Agent executor、执行日志，以及 Channel binding/provider 的管理闭包和直属页面、API client、i18n、测试。交互式 Chat/YJS 已归 `@fenix/agent-runtime` 和 `@fenix/chat-channel`，PHY-08 不迁移、不复制这些实现，只更新它们与本闭包之间确有必要的调用引用。

## 已确认的包边界

新建三个独立资源包，且不预造 facade、DTO、module manifest 或迁移机制：

- `@fenix/resource-workflow` 是 Workflow、Webhook、运行事件、SSE 与其浏览器页面/API/i18n 的唯一 owner。
- `@fenix/resource-task` 是 task-v2、Scheduler、HTTP/Agent executor、执行日志与其浏览器页面/API/i18n 的唯一 owner。
- `@fenix/resource-channel` 是 Channel binding/provider 及其浏览器页面/API/i18n 的唯一 owner。

`apps/server` 继续持有 Elysia 的原路由挂载、认证/DB/配置插件、启动顺序与进程生命周期；它只将原 `schedulerService.start/stop`、custom tool 初始化、Workflow API/Web route 和静态 proxy 的 import 改为资源包公开的 server 出口。`hermes-client` 直接依赖 Channel binding 并仅服务于 Channel 路由与宿主生命周期，因此随 `@fenix/resource-channel` 迁移；Agent runtime 和 Chat/YJS 仍由各自真实 owner 持有，资源包只使用已有接口，不复制源码。

后端 server 出口与浏览器入口必须分开。`@fenix/resource-*/server` 可导出 route contribution 和宿主所需的服务；浏览器入口只暴露浏览器安全的页面、API client、类型和 i18n contribution，不能经值导入携带 Node、Elysia、Drizzle 或服务端密钥能力。

## 数据流与不变量

```text
apps/server（认证、原路径挂载、启动/停止、DB 宿主）
  -> resource-workflow/server（definition/version -> YAML -> engine -> agent transport -> lease -> SSE/存储）
  -> resource-task/server（CRUD -> schedule/reschedule -> 防重入 -> executor -> execution log/status）
  -> resource-channel/server（组织上下文 -> binding/provider -> Hermes）
apps/web 路由薄适配
  -> 各资源包的浏览器专属页面、API client 与 i18n
```

Workflow 保持当前 session selection、instance lease、运行取消/清理和事件持久化顺序。Webhook 仍通过无认证的 `/hooks/:publicHash` 接收，按当前请求大小限制解析负载，异步触发 workflow 并立即返回当前响应。Task 保持 cron 时区、启动恢复、重排程、单 task 运行集去重、禁用/缺失任务处理、超时和 execution log/status 更新语义。Channel 保持既有认证和组织上下文后的 binding CRUD 与 provider 查询行为。

所有既有 `/web/*`、`/api/workflows/*`、`/hooks/*` 路径、method、headers、body/query、响应字段、错误码、i18n key、加载/空态/错误/重试和可访问性状态原样保留。数据库 schema、Drizzle SQL/meta/journal 与 data migration 不变。现有超 500 行文件原样搬迁；PHY-08 不以拆分或重构改变已存在的控制流。

## 迁移与验证

先为 Workflow/Webhook、Scheduler/任务、Channel 及受影响前端页面记录最小专项测试基线。随后用移动而非复制的方式将各闭包的 route、service、repository、schema、测试和浏览器文件迁入对应包；只更新实际调用方、包依赖/exports、前端 alias/路由适配与宿主组装。源路径的删除条件是新 owner 已完整承接，并且全仓旧路径 import、测试扫描和运行入口搜索为零；不保留 re-export、shim、双写或第二套实现。

每个资源包迁完后，运行其最小后端/前端专项测试、包 typecheck 和受影响前端构建；本 PHY-08 闭包收口时执行 `bun run build:web` 与 `bun run precheck`。如基线或收口检查失败，记录命令与定位所需摘要，先诊断并恢复原行为，不能用兼容代码规避。未提交的 PHY-08 review 记录应包含文件映射、必做/不做、旧接口样例、删除条件、验证证据和仅供后续治理的发现。

## 非目标

不改变数据库结构、DDL、data migration、认证/授权、组织隔离、公开 API、Webhook 合同、Workflow/Task 并发与失败取消语义、Chat/YJS 生命周期、Docker/CI/部署流程；不清理尚未属于 PHY-08 的根目录业务。若物理迁移必须改变任一公共契约、职责或数据流，停止实施并先报告受影响引用和替代落点。
