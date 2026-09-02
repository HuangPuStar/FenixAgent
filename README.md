# FenixAgent

**集中接入、运行与治理企业 AI Agent 的统一控制平台。**

FenixAgent 面向企业的多团队协作场景，基于 Agent Client Protocol（ACP）集中接入和运行不同的 Agent 引擎。它统一编排企业 Agent 资源与治理策略，包括模型、Skills、MCP 服务配置、权限与运行配置，并通过交互式 Chat、工作流、定时任务和开放 API，将 Agent 能力安全地交付到业务系统。

FenixAgent 是企业的 Agent 控制面，而不是用户本地单独使用某个 Agent 的客户端应用：平台负责组织、配置、策略、运行环境和生命周期管理；Agent 可在平台所在机器、独立远端执行节点，或按需接入的受控沙盒环境中执行。

[平台能力](#平台能力) · [支持的 Agent 引擎](#支持的-agent-引擎) · [快速开始](#快速开始) · [部署模式](#部署模式) · [文档与示例](#文档与示例) · [贡献](#贡献)

## 为什么选择 FenixAgent

- **不绑定单一 Agent 引擎**：内置 OpenCode、Claude Code、claude-code-best、DeepSeek Harness（DSH）等引擎，并可通过开发 Plugin 接入其他支持 ACP 协议的引擎。
- **集中配置，按需复用**：模型、Skills、Agent 配置、权限策略和运行配置由平台统一管理，无需为每种 Agent 重复维护一套资源。
- **按需集成企业能力**：可按业务需要接入知识库、Agent 记忆、Agent Sites、受控沙盒、模型网关与配额治理等能力，避免为不需要的系统引入额外复杂度。
- **从交互到自动化**：同一套 Agent 能力可用于 Web Chat、OpenAI 兼容 API、工作流和定时任务。
- **本地与远端统一调度**：在受控的本地或远端执行节点上运行 Agent，支持跨机器部署与生命周期管理。
- **面向企业治理**：以组织、用户和执行环境（Agent 配置、执行节点与工作区的受控组合）为边界，管理身份、权限、密钥与资源隔离。

## 平台能力

### 统一接入与 Agent 生命周期

FenixAgent 通过 ACP Relay 管理 Agent 引擎的连接、会话、状态、能力发现、实例创建、复用与释放，让不同引擎在统一的服务接口下工作。

### 企业资源与配置中心

平台集中管理 Agent 模板、模型、Skills、MCP 服务配置、权限策略和运行配置，并在启动实例时将适用配置注入目标运行环境。

### MCP 服务与工具扩展

外部工具能力通过 MCP 服务集成和扩展，平台统一管理 MCP 服务配置并在启动 Agent 时注入。

### 可选集成：知识库

可按需接入知识库，为 Agent 提供企业资料的检索能力。

### 可选集成：Agent 记忆与上下文连续性

可按需接入外部记忆服务，为 Agent 提供跨会话的上下文连续性与经验沉淀。记忆与知识库分别管理，避免将动态协作经验与企业文档混为一类资源。

### 可选集成：模型网关与配额治理

通过统一模型网关管理模型接入、凭据与路由，并按组织、用户或环境施加配额和使用限制。

### 可选集成：受控沙盒与执行隔离

Agent 可在受控沙盒中执行，隔离运行环境、文件系统与资源边界，降低任务执行对平台和其他租户的影响。

### 运行、调度与自动化

同一 Agent 能力可通过 Web Chat、OpenAI 兼容 API、工作流和定时任务调用，覆盖交互式使用与业务自动化。

### 可选集成：Agent 应用交付与托管

Agent Sites 为 Agent 生成的应用提供从代码提交、自动构建、预览到生产发布的托管链路。平台统一管理站点、部署版本、构建状态和访问入口，让 Agent 的产出可直接交付给业务使用。

### 分布式执行与远端节点

Agent 引擎可以在平台所在机器或独立的远端节点执行。平台负责节点注册、健康状态、调度与 Relay 通信；节点只承载实际运行时和工作区执行。

### 多租户安全与治理

组织、用户、环境、工作区和密钥相互隔离。平台在协议入口完成认证与组织上下文校验，并将受信任的工作目录和运行配置注入 Agent。

### 开放集成

通过 OpenAI 兼容 API、外部 API 与 MCP，FenixAgent 能作为企业业务系统与 Agent 引擎之间的统一集成层。

## 支持的 Agent 引擎

| Agent 引擎 | ACP 接入 | 平台所在机器执行 | 远端节点执行 | 说明 |
| --- | --- | --- | --- | --- |
| OpenCode | 支持 | 支持 | 支持 | 内置 Agent 引擎（默认） |
| Peri | 支持 | 支持 | 支持 | 内置 Agent 引擎（rust实现，兼容Claude Code生态，资源占用极低，建议生产使用） |
| Claude Code | 支持 | 支持 | 支持 | 内置 Agent 引擎 |
| claude-code-best（ccb） | 支持 | 支持 | 支持 | 内置 Agent 引擎 |
| DeepSeek Harness（DSH） | 原生支持 | 支持 | 支持 | 内置 Agent 引擎（接入详见 [DSH 文档](docker/sandbox-dsh/README.md)） |

除内置引擎外，其他支持 ACP 协议的 Agent 引擎可通过开发 Plugin 接入。开发与注册 Engine Plugin 的方式见 [`@fenix/plugin-sdk`](packages/plugin-sdk/README.md)。

## 快速开始

### Docker Compose（推荐）

```bash
docker compose up --build -d
```

默认服务地址为 <http://localhost:3001/>，并提供 OpenCode Agent 引擎。

首次启动时，系统会创建管理员账号 `admin@fenix.com`。初始密码会写入 `RCS_SYSTEM_ADMIN_PASSWORD_FILE` 指定的文件，默认是 `data/password.txt`。

### 本地开发

前置要求：Bun、Docker 与 Docker Compose，以及可用的 OpenCode Agent 引擎（建议使用版本opencode-ai@1.17.12，更高版本可能有兼容性问题）。

```bash
# 仅启动 PostgreSQL
docker compose up -d postgres

# 安装依赖并同步数据库
bun install
bun run db:migrate

# 启动本地服务
bash restart-server.sh
```

本地服务默认运行在 <http://localhost:3000/>。前端独立开发可执行 `bun run dev:web`；完整开发与验证流程见 [贡献指南](CONTRIBUTING.md)。

## 部署模式

### 单机部署

使用上面的 Docker Compose 命令即可在一台机器上运行控制服务与默认 Agent 引擎，适合体验、开发和单机环境。

可选集成与远端 Sandbox 的 Docker Compose 启动方式见 [进阶部署指南](docker/prod/README.md)。

### 远端执行节点

`acp-link` 运行在远端机器上，将 Agent 引擎的 ACP stdio 通信桥接到 FenixAgent。控制服务集中管理节点和 Agent 实例，任务则在远端机器的工作区中执行。

```text
FenixAgent Control Plane                    Remote Machine
┌────────────────────────┐                 ┌──────────────────────────┐
│ Console / API / Workflow│────── WebSocket │ acp-link + ACP Runtime   │
│ ACP Relay / Scheduler   │                 │ └── Agent process        │
└────────────────────────┘                 └──────────────────────────┘
```

Linux 环境可用 OpenCode 沙盒镜像启动远端节点：

```bash
docker build -f docker/sandbox/Dockerfile -t fenix-sandbox .

docker run -d \
  --name fenix-sandbox \
  --add-host host.docker.internal:host-gateway \
  -e RCS_URL=ws://host.docker.internal:3000 \
  -e RCS_SECRET=your-secret \
  -e RCS_MACHINE_ID=mach_xxx \
  fenix-sandbox
```

`RCS_URL`、`RCS_SECRET` 与 `RCS_MACHINE_ID` 均为必填项。其他引擎请使用对应的 `docker/sandbox-ccb/`、`docker/sandbox-dsh/` 或 `docker/sandbox-peri/` 镜像。远端节点的程序接口与 ACP 桥接能力见 [`packages/acp-link`](packages/acp-link/README.md)。

### DeepSeek Harness（DSH）

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原生支持 ACP，可作为 FenixAgent 的 Agent 引擎。仓库提供 `docker/sandbox-dsh/` 镜像：模型配置由主服务下发，API Key 不落盘，并复用平台的 Web Chat、OpenAI 兼容 API、工作流、会话持久化与多租户工作区隔离。

使用步骤、权限边界与已知限制见 [DSH 沙箱文档](docker/sandbox-dsh/README.md)。

## 架构概览

```text
Console / External API / Workflow / Scheduler
                     │
                     ▼
          FenixAgent Control Plane
  organization · configuration · policy · orchestration
                     │
                     ▼
               ACP Relay / Runtime
                     │
         ┌───────────┴───────────┐
         ▼                       ▼
 Local Agent Runtime      Remote Agent Runtime
```

控制服务决定“谁能使用什么 Agent、使用哪些资源、在哪里运行”；执行节点负责启动 Agent、转发 ACP 消息并执行实际任务。三层执行引擎的职责与数据流见[执行引擎架构](docs/developer/arch/execution-engine-architecture.md)。

## 文档与示例

- [贡献与本地开发](CONTRIBUTING.md)
- [外部 API 指南](docs/developer/guide/external-api.md)
- [外部 Agent 引擎会话接入](docs/developer/guide/external-agent-session-guide.md)
- [MCP 集成](docs/developer/guide/mcp-integration.md)
- [Skill 开发](docs/developer/guide/skill-development.md)
- [Engine Plugin 开发](packages/plugin-sdk/README.md)
- [知识库使用](docs/developer/guide/knowledge-base.md)
- [Agent 记忆架构（Hindsight）](docs/developer/arch/hindsight-memory-architecture.md)
- [沙盒架构](docs/arch/19-sandbox.md)
- [模型网关架构](docs/design/2026-08-26-model-gateway-design.md)
- [工作流架构](docs/developer/arch/workflow-architecture.md)
- [Agent Sites 架构](docs/developer/arch/agent-sites-architecture.md)
- [执行引擎架构](docs/developer/arch/execution-engine-architecture.md)
- [Agent API 示例](docs/developer/api-demo/agent/README.md)
- [系统 API 示例](docs/developer/api-demo/system/README.md)

## 贡献

欢迎提交功能、修复、文档与测试改进。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

```bash
bun run precheck
```

## 许可证

FenixAgent Community Edition 采用 [Apache License 2.0](LICENSE)。
