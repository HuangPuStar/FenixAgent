# 根 `src/`、`web/` 最终 Owner 迁移设计

## 背景与目标

阶段 1 的交付目标是将根 `src/`、`web/` 中的全部实现迁至 `apps/` 或最终 workspace owner，保持既有业务、协议、权限和数据行为不变。当前根目录仍有 925 个文件，包含 Runtime、Machine/File、Sandbox、Model/AgentConfig、宿主协议与 Web 壳等混合职责；不能作为一个大提交或推给最终工具收口。

本设计以当前工作树为事实来源。原 PHY 编号仅保留历史追溯作用；后续工作按最终 owner 使用 `RMD-*` 任务编号，每个业务闭包单独提交。

## 方案选择

采用“清单先行、owner 驱动分波迁移”。先建立全量文件到最终 owner 的可审计映射，再按依赖顺序迁移。相比按现有目录批量搬运，这可避免把同一目录中 Runtime、Machine、Sandbox 和宿主代码混入同一闭包；相比一次性迁移，也可隔离测试和协议回归。

## Owner 分类合同

每个根目录文件只能属于一个最终 owner：

| 分类 | 最终位置 | 范围 |
| --- | --- | --- |
| Server 宿主 | `apps/server/src/` | HTTP/WS 协议聚合、启动/关闭组装、宿主错误与认证接入 |
| Web 宿主 | `apps/web/src/` | Router 薄适配、全局壳、共享 UI、i18n 初始化、请求层与公共前端测试 |
| Runtime | `packages/agent-runtime/`、`packages/chat-channel/` | Environment/Instance、ACP、Relay、会话、运行生命周期与专有 Chat UI |
| 资源包 | `packages/resources/<owner>/` | 资源自身的 route、service、repository、schema、页面、API client、i18n 与测试 |
| 平台包 | `packages/platform/` | 无业务领域依赖的契约和基础实现 |
| 非源码产物 | 删除或重新生成 | `.DS_Store`、根 `web/dist` 等不应拥有运行时 owner 的产物 |

跨 package 只使用 `package.json#exports` 公开入口；不得保留根目录转发文件、兼容 shim、双写或双实现。浏览器入口不得引入 server-only 模块。

## 迁移任务与依赖顺序

| 顺序 | 任务 | 最终 owner | 迁移闭包 |
| --- | --- | --- | --- |
| RMD-00 | 残留清单与基线 | 文档/审查证据 | 为每个 `src/`、`web/` 文件记录原路径、目标路径、owner、主要消费者、测试归属及批次；记录专项基线失败 |
| RMD-01 | Runtime 与会话协议补漏 | `agent-runtime`、`chat-channel` | Environment/Instance、ACP route、OpenAI Chat、Relay、Session、并发、生命周期和 Chat 专有 UI |
| RMD-02 | Machine 与 Workspace/File 补漏 | `resource-machine` | registry、FS/file-events/workspaces 路由和 schema、文件前端、预览与专项测试 |
| RMD-03 | Sandbox 补漏 | `resource-sandbox` | sandbox 系统 API、集群/服务器 adapter、资源池配置、管理页与测试 |
| RMD-04 | Model 与 AgentConfig 补漏 | `model-management`、`agent-config` | Provider/Model route 与 API、Meta Agent、算法/模型组件、Agent 配置辅助能力与测试 |
| RMD-05 | Knowledge、Site 与交付 UI 补漏 | `resource-knowledge`、`agent-config`、既有交付资源 owner | 知识图谱/检索 UI 迁至 Knowledge；SiteFrame、SiteTabs 与挂载交互迁至既有 `agent-config`；Artifact 容器按最终共同 Shell/Runtime 归属拆分，不新建 Site 包 |
| RMD-06 | 身份、授权与后台控制面补漏 | `apps/server`、`platform/access-control`、`identity-admin` | user/token/share-link/resource permission、公共错误与认证协议消费者；修正已知 platform 反向依赖，不让 platform 依赖资源或 app 实现 |
| RMD-07 | Server 宿主与启动装配收口 | `apps/server` | 剩余 HTTP/WS 聚合、Webhook 薄适配、bootstrap、data migration、构建信息、缓存和共享后端测试设施 |
| RMD-08 | Web 壳与通用组件收口 | `apps/web` | Login、Shell、路由薄适配、通用 UI、i18n/API 基础、公共前端测试与样式 |
| RMD-09 | 最终路径与交付收口 | `apps`、`db`、`deploy`、scripts | 删除根目录非源码残留，更新构建/CI/Vite/TS/Docker 引用，并证明根目录已清空；不得迁移业务实现 |

RMD-00 必须先完成。RMD-01 至 RMD-06 可按实际 import 关系分波；发现新的完整业务闭包时，必须插入这一范围而非加入 RMD-09。RMD-07 与 RMD-08 在资源出口稳定后执行，RMD-09 最后执行。

## 协议、不变量与失败处理

- 仅允许物理迁移和必要接线：HTTP/WS URL、method、headers、query、body、错误码、DTO、认证顺序、组织隔离、Elysia 挂载顺序、DB schema 与既有 Drizzle 链不变。
- 被测实现、专有 API/i18n/组件和专项测试必须与 owner 同批移动；共享测试工具迁至实际共同 owner。
- 迁移前记录最小专项基线；若已有失败，记录命令、失败用例、owner 和诊断。只修复当前任务新增的问题，不扩展重构其他 owner。
- 每个任务完成时验证：专项测试、相关 server/web typecheck、旧路径与旧 import 搜索、`git diff --check`，以及必要的前端生产构建。

## 最终验收

RMD-09 仅在以下条件全部满足后完成：

1. `rg --files src web` 没有输出；
2. 全仓不存在指向旧 `src/`、`web/` 实现路径的 import、构建、测试或部署引用；
3. `bun run precheck` 和 `bun run build:web` 均全绿；
4. 生产 server/web 构建与启动使用最终真实路径；
5. 所有迁移任务的未提交 review 记录保留命令、结果与已知失败的收口证据。

## 非目标

- 不在阶段 1 新增 Facade、模块 manifest、DTO、数据库字段、DDL 或数据迁移。
- 不以兼容层保留旧根路径。
- 不将尚未盘点的业务代码交给 RMD-09。
