# CE-EE PHY-03：Agent Runtime 完整闭包物理迁移设计

## 目标与范围

PHY-03 只做现有 Agent Runtime 闭包的物理迁移，不改变任何业务行为、协议、权限、并发规则或资源释放时序。`packages/agent-runtime` 成为 Environment、持久 Instance、Agent runtime 协调与进程、ACP relay、YJS Chat 宿主组合，以及浏览器 Environment/Chat/YJS 客户端的唯一 owner。

`@fenix/chat-channel` 已是独立 workspace 包，保持其现有根入口和 `/server` 子路径边界；PHY-03 只迁移服务端对它的 bootstrap 装配，不复制其 YJS 状态、协议或控制面实现。

## 物理归属与接线

后端的 Environment repository、Environment Web service、Instance service、runtime coordinator/projection/ID、API instance 选择、ACP relay 及其直接依赖，以及 Chat Channel bootstrap 迁入 `packages/agent-runtime`。浏览器的 Environment API、Agent Panel、Chat 组件、YJS hooks/client 及其专项测试迁入该包的浏览器子路径。

`apps/server` 保留 `main`、bootstrap 和既有 `/web`、`/acp` 路由挂载，只将导入指向 runtime 的真实实现与宿主装配；`apps/web` 保留路由薄壳并指向 runtime 的浏览器入口。已迁移实现从根 `src/`、`web/` 删除，不建立 re-export shim 或副本。

`src/transport/file-*`、`agent-node-bridge.ts`、`ws-types.ts`、workspace/file service 和 Machine 相关实现属于 PHY-07，继续由原 owner 持有。通用 EventBus 与 Workflow 专属实现不迁入 PHY-03；runtime 若已有直接依赖，只更新到其唯一现有实现的路径，不复制代码。

## 行为与失败语义

保留 Environment → 持久 Instance → `AgentInstanceRuntimeCoordinator` 的启动、确保、并发与释放顺序。HTTP、Workflow 与交互式 Chat 继续使用各自既有 instance 选择、relay、ACP session/turn 生命周期；请求或连接释放不得停止共享 runtime。

`/web/environments`、`/acp/*` 和 YJS WebSocket 的 URL、method、字段、认证与错误语义保持不变。浏览器继续使用相同 Environment API、Y.Doc 名称、确定性 `rcsSessionId`、多标签 relay 共享、64 KB 发送背压与 200 客户端上限。若迁移暴露循环依赖或需要改变已有调用顺序，则停止并报告具体引用链，而非添加兼容层。

## 验证与提交边界

迁移前记录 Environment、Instance、ACP relay、Chat/YJS 与前端 Chat 的最小专项测试基线；迁移后运行同一批专项测试、相关 server/web typecheck、`bun run build:web` 与 `git diff --check`。每个测试失败均按现有实际链路诊断，恢复原时序后再验证。

本任务只产生一个 PHY-03 物理迁移提交；review 记录保留为未提交工作区文件，记载路径映射、基线、验证和非显然取舍。无 schema、DDL、迁移或对外契约改动。
