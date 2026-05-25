# mothership

## 需求背景

mothership的核心功能：提供对 "支持acp协议的agent工具"（如opencode） 的编排和调度。主要包含以下几个点：
- 提供web控制台，管理 agent-providers（agent工具，如opencode）、agent-configs、models、skills、mcp 等；其中的agent-configs、models、skills、mcp配置持久化在平台，和agent-providers解耦，保证在不同的agent-providers下可见（需要providers支持对应的配置才能实际生效）
- 通过 acp-link 与 agent-providers 建立会话、实例、relay 与事件流
- 提供更多通用控制能力，如工作区、文件系统、定时任务管理等
- 通过插件的方法，接入新的 agent-providers 和 新的 agent能力（如知识库、记忆等）

考虑到未来的扩展性，比如支持不同的agent-providers、提供更多的agent扩展（如知识库、记忆等），项目计划使用 “core + plugin” 模式。
- core：提供 agent调度和编排、通用控制能力
- plugin：分为 provider-plugin（agent工具适配）和 abilities-plugin（注入知识库、记忆、skills、mcp等）

以 opencode 作为首个agent-providers插件。

## 目标
- 建立 “core + plugin” 模式的骨架
- 完成core层设计，提供 agent调度和编排 和 基础的通用控制能力（工作区、文件系统、定时任务管理）
- 定义provider-plugin的sdk， 输出插件开发文档规范；opencode 适配逻辑迁移为独立插件包 mothership/opencode；（abilities-plugin先占位，不需要定义）

## 重构方案
保留现有代码不动，在仓库根目录新建 `mothership/` 作为新的独立工程目录；先把核心模型和插件接口建立起来，再把 opencode 迁入插件。最后改为完全使用mothership，移除外层所有代码。
整个重构工作量很大，为了保证重构过程不发生漂移，也方便人工review，需要把重构分为多个spec，每个spec的任务都拆小（2000行内）。


### 目标架构

```text
apps/
    server/     # hono服务
    web/        # react控制台

packages/
    core/       # 通用控制能力，agent调度和编排
    plugin-sdk/ # 插件定义

plugin/
    opencode/    # opencode适配插件
```

运行时关系：

```text
Web UI / REST / SSE / WS
          │
          ▼
Server Composition Layer
          │
          ▼
Core Runtime
  ├── Plugin Registry
  ├── XXX Service
  └── ACP Relay Orchestrator
          │
          ▼
Agent Plugin
  ├── opencode
  ├── cc
  └── openclaw
```

核心原则：

- `core` 只理解“能力”和“生命周期”，不理解 具体的 agent-providers 行为
- 插件负责把 core 定义的抽象能力落到具体 Agent 实现
- server 只负责协议暴露与依赖装配，不承载领域逻辑
- web 只消费统一的 core API 视图，不直接感知插件内部差异
- 关键模块必须有清晰注释，方便代码走查；注释重点解释职责边界、设计原因和插件/核心的分层关系

### Core 的职责边界

`core` 应只保留所有 Agent 都可能复用的稳定概念：

- `PluginRegistry`：插件注册、发现、能力声明
- `AgentConfigService`：agent的配置，如providers、models、skills、mcp等
- `ModelService`：models的配置
- `SkillService`：skills的配置
- `McpService`：mcp的配置
- `EnvironmentService`：环境定义、启停、状态查询
- `WorkspaceService`：运行目录、用户文件访问、预览路径解析
- `InstanceService`：实例生命周期、运行时状态
- `SessionService`：会话元数据、事件聚合、会话路由
- `RelayOrchestrator`：前端 relay 与 Agent 连接编排
- `TaskService` / `SchedulerService`：定时任务定义、调度、日志


### 插件模型（provider-plugin）

//TODO