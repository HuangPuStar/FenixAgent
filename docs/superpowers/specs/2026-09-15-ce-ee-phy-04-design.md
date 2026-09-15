# CE-EE 阶段 1 PHY-04：Provider/Model 与模型网关迁移设计

## 目标

将 Provider、Model 与模型网关的完整现有业务闭包物理迁移至
`@fenix/model-management`。迁移保持现有 `/web`、`/api` 合同、权限、预算、
凭证隔离、用量归属和启动顺序，不引入功能、DDL、数据迁移或兼容层。

## 范围

包是该领域的唯一 owner，包含：

- 后端 Provider/Model 配置服务、模型网关 runtime、预算、凭证、用量、subject
  与 adapter registry；
- 模型网关凭证和 subject repository、关联 schema、`/api/models`、
  `/api/system-model-gateway`、`/web/config/models`、`/web/config/providers`
  与 `/web/model-gateway` 路由；
- 前端模型与 Provider API、模型列表/配置页、模型网关管理与用量页、直属组件、
  工具模块和测试。

`@fenix/model-gateway-sdk` 与 `@fenix/model-gateway-litellm` 保持独立基础包，
由新业务包依赖，不复制其中实现。

不迁移 AgentConfig、Knowledge/RAG、Machine/Sandbox、Workflow/Scheduler 等其他
PHY 闭包。它们只将已有导入更新至新包的公开接口。

## 包边界

```text
packages/model-management/
  src/
    server/
      config/
      model-gateway/
      repositories/
      routes/{api,web}/
      schemas/
      index.ts
    web/
      api/
      pages/
      components/
      lib/
      index.ts
```

`@fenix/model-management/server` 是后端公开入口；默认
`@fenix/model-management` 是浏览器安全入口，不能导出 server 模块或其依赖。
不保留根目录 re-export、deprecated shim 或重复实现。

宿主保留：

- `apps/server/src/main.ts` 的 runtime 创建、凭证 resolver 注入和路由注册；
- `apps/server/src/config.ts` 的环境变量映射；
- 其他业务闭包自身的领域逻辑与页面，仅改为消费新包公开接口。

## 运行与数据流

服务启动时，宿主按既有环境配置创建模型网关 runtime。包内 Provider service
确保系统 Gateway Provider 投影存在，随后宿主将 runtime credential resolver 注入
既有 Agent 启动链。未配置网关管理凭证时，仍建立只读 Provider 投影供管理端显示。

前端继续请求既有 `/web` 路径，外部模型查询继续使用 `/api/models`。路由负责
认证、组织上下文、校验和既有响应映射；服务负责 Provider 权限、模型可见性、预算、
凭证与用量逻辑。

凭证映射继续按 `gatewayProviderId + organizationId + userId + agentConfigId`
隔离；Gateway Provider 内预算继续按用户共享。用量查询只聚合可归属当前 Gateway
Provider 的凭证，避免混入同一 LiteLLM 实例上的其他 Key。加密凭证、管理 Key 和
上游内部细节不得出现在外部响应或日志中。

关联 schema 仅物理移动，不产生 Drizzle DDL、SQL/meta 变更或数据迁移。

## 迁移步骤

1. 创建 package 元数据、server/browser 入口和 TypeScript/Vite 解析配置。
2. 移动后端领域实现、repository、schema、路由和直属测试；更新宿主及后端消费者。
3. 移动前端 API、页面、组件、工具和直属测试；路由保留为薄适配，其他闭包只更新引用。
4. 删除旧路径实现与引用，确保没有双 owner 或兼容层。

## 验证

先运行迁移后的 Provider/Model、模型网关后端与前端专项测试，再运行 server/web
typecheck、`bun run build:web`、依赖巡检和 `bun run precheck`。关键回归覆盖：

- Provider 权限决定的模型访问；
- 组织间凭证隔离和预算耗尽；
- 网关模型同步、凭证轮换和用量归属；
- 系统管理页面，以及原 `/web`、`/api` 请求响应合同；
- 浏览器入口不经值导入加载 server 模块。
